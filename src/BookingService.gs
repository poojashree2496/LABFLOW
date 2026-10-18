/**
 * BookingService.gs - advance reservations, kept separate from immediate checkout (Loans.issue).
 *
 * A reservation promises stock of one or more CATEGORIES for a time window. Availability for a window is
 *   free = workingStock - unitsStillOut(at window start) - unitsPromisedToOverlappingReservations
 * Everything is recomputed from Assets / LoanItems / Reservations inside the script lock, so two requests for the
 * last unit cannot both succeed. Loans.issue consults Booking.availability so that walk-up checkout cannot consume
 * stock promised to an approved booking.
 *
 * Statuses: pending -> approved | rejected | cancelled | expired ; approved -> fulfilled | cancelled | expired (no-show) | completed (used workstation slot).
 */
var Booking = {
  COLLECT_EARLY_MS: 2 * 3600000,
  NO_SHOW_MS: 2 * 3600000,

  /** Expand a reservation resource into category demand: { categoryId: qty }. */
  demand: function (resourceType, resourceId, quantity) {
    var d = {};
    if (resourceType === 'category') { Db.mustGet('Categories', resourceId, 'Category'); d[resourceId] = quantity; }
    else if (resourceType === 'kit') {
      Db.mustGet('Kits', resourceId, 'Kit');
      Db.whereEq('KitComponents', { kitId: resourceId }).forEach(function (c) { if (c.quantity > 0) d[c.categoryId] = (d[c.categoryId] || 0) + c.quantity * quantity; });
      if (!Object.keys(d).length) fail('BAD_INPUT', 'This kit has no components.');
    } else if (resourceType === 'asset') {
      var a = Db.mustGet('Assets', resourceId, 'Asset'); d[a.categoryId] = 1;
    } else fail('BAD_INPUT', 'Unknown resource type.');
    return d;
  },

  _holds: function (r) { return r.status === 'approved' || (r.status === 'pending' && Settings.get('bookingHoldPending')); },

  /** Stock numbers for one category in one lab and window. */
  availability: function (labId, categoryId, startAt, endAt, excludeReservationId) {
    var now = U.now(), total = 0, physicalFree = 0, assetIds = {};
    Db.whereEq('Assets', { labId: labId, categoryId: categoryId }).forEach(function (a) {
      if (a.status !== 'available' && a.status !== 'on_loan') return;
      assetIds[a.assetId] = true;
      if (a.trackingMode === 'individual') { total += 1; if (a.status === 'available') physicalFree += 1; }
      else { total += a.quantityTotal; physicalFree += a.quantityAvailable; }
    });
    var loans = U.indexBy(Db.where('Loans', function (l) { return l.status === 'open' || l.status === 'partial'; }), 'loanId'), outstanding = 0;
    Db.where('LoanItems', function (i) { return i.status === Assets.OUT && assetIds[i.assetId]; }).forEach(function (i) {
      var l = loans[i.loanId]; if (!l) return;
      if (l.dueAt > startAt || l.dueAt < now) outstanding += i.qtyIssued - i.qtyReturned - i.qtyConsumed - i.qtyDamaged - i.qtyMissing;
    });
    var reserved = 0;
    Db.where('Reservations', function (r) { return r.labId === labId && r.reservationId !== excludeReservationId && Booking._holds(r) && U.overlaps(startAt, endAt, r.startAt, r.endAt); }).forEach(function (r) {
      reserved += Booking.demand(r.resourceType, r.resourceId, r.quantity)[categoryId] || 0;
    });
    return { total: total, outstanding: outstanding, reserved: reserved, physicalFree: physicalFree, free: Math.max(0, total - outstanding - reserved) };
  },

  _checkCapacity: function (labId, demand, startAt, endAt, excludeId) {
    Object.keys(demand).forEach(function (catId) {
      var av = Booking.availability(labId, catId, startAt, endAt, excludeId);
      if (demand[catId] > av.free) {
        var cat = Db.get('Categories', catId);
        fail('NOT_AVAILABLE', 'Not enough ' + (cat ? cat.name : 'stock') + ' for that period: ' + av.free + ' available, ' + demand[catId] + ' requested.', { categoryId: catId, free: av.free });
      }
    });
  },
  /** An individually tracked asset booked by name must not already be promised to someone else in the window. */
  _checkAssetExclusive: function (r, excludeId) {
    if (r.resourceType !== 'asset') return;
    var clash = Db.where('Reservations', function (x) { return x.reservationId !== excludeId && x.resourceType === 'asset' && x.resourceId === r.resourceId && Booking._holds(x) && U.overlaps(r.startAt, r.endAt, x.startAt, x.endAt); });
    if (clash.length) fail('NOT_AVAILABLE', 'That item is already booked for an overlapping period.');
  },

  /** A completed booking/request must receive every promised unit; extra checked items are allowed. */
  validateContents: function (r, demand, lines) {
    var needed = Booking.demand(r.resourceType, r.resourceId, r.quantity);
    Object.keys(needed).forEach(function (catId) {
      if ((demand[catId] || 0) < needed[catId]) fail('BAD_INPUT', 'The issued items do not fill the requested resource and quantity.');
    });
    if (r.resourceType === 'asset' && !lines.some(function (ln) { return ln.assetId === r.resourceId && ln.qty === 1; })) {
      fail('BAD_INPUT', 'Issue the specific item named in this booking.');
    }
  },

  checkAvailability: function (ctx, p) {
    V.obj(p);
    var labId = V.id(p.labId, 'Lab', 'lab'), start = V.int(p.startAt, 'Start', 0, 4102444800000), end = V.int(p.endAt, 'End', 0, 4102444800000);
    if (end <= start) fail('BAD_INPUT', 'End must be after start.');
    var rt = V.enumOf(p.resourceType, 'Resource type', ['category', 'kit', 'asset']);
    var rid = rt === 'category' ? V.id(p.resourceId, 'Category', 'category') : rt === 'kit' ? V.id(p.resourceId, 'Kit', 'kit') : V.id(p.resourceId, 'Asset', 'asset');
    var d = Booking.demand(rt, rid, V.int(p.quantity === undefined ? 1 : p.quantity, 'Quantity', 1, 1000));
    return { categories: Object.keys(d).map(function (catId) { var c = Db.get('Categories', catId), av = Booking.availability(labId, catId, start, end, null); return { categoryId: catId, name: c ? c.name : catId, needed: d[catId], free: av.free }; }) };
  },

  _requesterName: function (r) {
    if (r.requesterType === 'group') { var g = Db.get('Groups', r.requesterId); return g ? g.name : r.requesterId; }
    if (r.requesterType === 'faculty') { var f = Db.get('FacultyProfiles', r.requesterId); return f ? f.name : r.requesterId; }
    var s = Db.get('StudentProfiles', r.requesterId); return s ? s.name + ' (' + s.rollNo + ')' : r.requesterId;
  },
  _resourceName: function (r) {
    var rec = r.resourceType === 'category' ? Db.get('Categories', r.resourceId) : r.resourceType === 'kit' ? Db.get('Kits', r.resourceId) : Db.get('Assets', r.resourceId);
    return rec ? rec.name : r.resourceId;
  },
  _view: function (r) {
    return { reservationId: r.reservationId, labId: r.labId, resourceType: r.resourceType, resourceId: r.resourceId, resourceName: Booking._resourceName(r), quantity: r.quantity, requesterType: r.requesterType, requesterId: r.requesterId,
      requesterName: Booking._requesterName(r), startAt: r.startAt, endAt: r.endAt, collectionOpensAt: r.startAt - Booking.COLLECT_EARLY_MS, status: r.status, purpose: r.purpose, requestedAt: r.requestedAt, decidedAt: r.decidedAt, decisionNote: r.decisionNote };
  },
  _mayAct: function (ctx, r) {
    if (ctx.has('admin') || ctx.has('staff')) return true;
    if (r.requesterType === 'faculty') return !!(ctx.faculty && ctx.faculty.facultyId === r.requesterId);
    if (!ctx.student) return false;
    if (r.requesterType === 'student') return r.requesterId === ctx.student.studentId;
    return !!Groups._mineIds(ctx)[r.requesterId];
  },

  request: function (ctx, p) {
    V.obj(p);
    var labId = V.id(p.labId, 'Lab', 'lab'), rt = V.enumOf(p.resourceType, 'Resource type', ['category', 'kit', 'asset']);
    var rid = rt === 'category' ? V.id(p.resourceId, 'Category', 'category') : rt === 'kit' ? V.id(p.resourceId, 'Kit', 'kit') : V.id(p.resourceId, 'Asset', 'asset');
    var qty = V.int(p.quantity === undefined ? 1 : p.quantity, 'Quantity', 1, 1000), start = V.int(p.startAt, 'Start', 0, 4102444800000), end = V.int(p.endAt, 'End', 0, 4102444800000);
    var purpose = V.str(p.purpose, 'Purpose', { min: 3, max: 200 });
    var now = U.now();
    if (start < now - 60000) fail('BAD_INPUT', 'The start time is in the past.');
    if (end <= start) fail('BAD_INPUT', 'End must be after start.');
    if (start > now + Settings.get('bookingMaxAdvanceDays') * 86400000) fail('BAD_INPUT', 'Bookings can be made at most ' + Settings.get('bookingMaxAdvanceDays') + ' days ahead.');
    if (end - start > Settings.get('bookingMaxDays') * 86400000) fail('BAD_INPUT', 'A booking can last at most ' + Settings.get('bookingMaxDays') + ' days.');
    // Requester is derived from the authenticated caller, never from the payload.
    var requesterType = V.enumOf(p.requesterType || (ctx.student ? 'student' : 'faculty'), 'Requester type', ['student', 'group', 'faculty']), requesterId;
    if (requesterType === 'student') { if (!ctx.student || ctx.student.status !== 'verified') fail('FORBIDDEN', 'Only verified students can book.'); requesterId = ctx.student.studentId; }
    else if (requesterType === 'faculty') { if (!ctx.faculty) fail('FORBIDDEN', 'Faculty profile required.'); requesterId = ctx.faculty.facultyId; }
    else {
      requesterId = V.id(p.requesterId, 'Group', 'group');
      if (!ctx.student || !Groups._mineIds(ctx)[requesterId]) fail('FORBIDDEN', 'You are not a member of that group.');
    }
    return Locks.with(function () {
      var lab = Db.mustGet('Labs', labId, 'Lab'); if (lab.status !== 'active') fail('INVALID_STATE', 'This lab is not active.');
      var res = rt === 'category' ? Db.mustGet('Categories', rid, 'Category') : rt === 'kit' ? Db.mustGet('Kits', rid, 'Kit') : Db.mustGet('Assets', rid, 'Asset');
      if (rt !== 'category' && res.labId !== labId) fail('BAD_INPUT', 'That resource belongs to a different lab.');
      if (rt === 'asset') { qty = 1; if (res.trackingMode !== 'individual') fail('BAD_INPUT', 'Book consumable stock by category.'); }
      var active = Db.where('Reservations', function (r) { return r.requesterType === requesterType && r.requesterId === requesterId && (r.status === 'pending' || r.status === 'approved'); });
      var dup = active.filter(function (r) { return r.labId === labId && r.resourceType === rt && r.resourceId === rid && r.quantity === qty && r.startAt === start && r.endAt === end; });
      if (dup.length) return { reservation: Booking._view(dup[0]), replayed: true };
      if (active.length >= Settings.get('bookingMaxActivePerRequester')) fail('LIMIT', 'You already have ' + active.length + ' active bookings (limit ' + Settings.get('bookingMaxActivePerRequester') + ').');
      var demand = Booking.demand(rt, rid, qty);
      var rec = { reservationId: U.id('reservation'), labId: labId, resourceType: rt, resourceId: rid, quantity: qty, requesterType: requesterType, requesterId: requesterId, requestedBy: ctx.email, startAt: start, endAt: end,
        status: 'pending', purpose: purpose, requestedAt: now, decidedBy: '', decidedAt: null, decisionNote: '', cancelledAt: null };
      Booking._checkAssetExclusive(rec, null);
      Booking._checkCapacity(labId, demand, start, end, null);
      var r = Db.insert('Reservations', rec);
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'booking.request', entityType: 'Reservation', entityId: r.reservationId, detail: { resourceType: rt, resourceId: rid, quantity: qty, startAt: start, endAt: end } });
      Notify.toRole('staff', 'booking', 'New booking request', Booking._requesterName(r) + ' requested ' + Booking._resourceName(r) + ' x' + qty + ' from ' + U.fmt(start) + '.', 'bk-new:' + r.reservationId);
      return { reservation: Booking._view(r), replayed: false };
    });
  },

  decide: function (ctx, p) {
    V.obj(p);
    var approve = V.bool(p.approve);
    var note = V.str(p.note, 'Note', { optional: true, max: 200 });
    return Locks.with(function () {
      var r = Db.mustGet('Reservations', V.id(p.reservationId, 'Reservation', 'reservation'), 'Reservation');
      if (r.status !== 'pending') fail('INVALID_STATE', 'This booking is already ' + r.status + '.');
      if (approve) {
        if (r.endAt < U.now()) fail('INVALID_STATE', 'This booking period has already passed.');
        Booking._checkAssetExclusive(r, r.reservationId);
        Booking._checkCapacity(r.labId, Booking.demand(r.resourceType, r.resourceId, r.quantity), r.startAt, r.endAt, r.reservationId);
      }
      var next = Db.update('Reservations', r.reservationId, { status: approve ? 'approved' : 'rejected', decidedBy: ctx.email, decidedAt: U.now(), decisionNote: note });
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: approve ? 'booking.approve' : 'booking.reject', entityType: 'Reservation', entityId: r.reservationId, detail: { note: note } });
      Booking._notifyRequester(next, 'booking', approve ? 'Booking approved' : 'Booking rejected', Booking._resourceName(next) + ' from ' + U.fmt(next.startAt) + (note ? '. ' + note : ''), 'bk-dec:' + r.reservationId);
      return { reservation: Booking._view(next) };
    });
  },

  cancel: function (ctx, p) {
    V.obj(p);
    return Locks.with(function () {
      var r = Db.mustGet('Reservations', V.id(p.reservationId, 'Reservation', 'reservation'), 'Reservation');
      if (!Booking._mayAct(ctx, r)) fail('FORBIDDEN', 'You cannot cancel this booking.');
      if (r.status === 'cancelled') return { reservation: Booking._view(r), replayed: true };
      if (r.status !== 'pending' && r.status !== 'approved') fail('INVALID_STATE', 'A ' + r.status + ' booking cannot be cancelled.');
      var next = Db.update('Reservations', r.reservationId, { status: 'cancelled', cancelledAt: U.now() });
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'booking.cancel', entityType: 'Reservation', entityId: r.reservationId, detail: { was: r.status } });
      return { reservation: Booking._view(next), replayed: false };
    });
  },

  _notifyRequester: function (r, type, title, body, dedupe) {
    if (r.requesterType === 'student') Notify.toStudent(r.requesterId, type, title, body, dedupe);
    else if (r.requesterType === 'faculty') { var f = Db.get('FacultyProfiles', r.requesterId); if (f) Notify.toUser(f.userId, type, title, body, dedupe); }
    else Db.whereEq('GroupMembers', { groupId: r.requesterId }).forEach(function (m) { Notify.toStudent(m.studentId, type, title, body, dedupe + ':' + m.studentId); });
  },

  mine: function (ctx) {
    var groups = Groups._mineIds(ctx);
    var rows = Db.where('Reservations', function (r) {
      if (r.requesterType === 'student') return !!ctx.student && r.requesterId === ctx.student.studentId;
      if (r.requesterType === 'faculty') return !!ctx.faculty && r.requesterId === ctx.faculty.facultyId;
      return !!groups[r.requesterId];
    });
    return { reservations: rows.slice(-100).reverse().map(Booking._view) };
  },
  list: function (ctx, p) {
    p = p || {};
    var status = p.status ? V.enumOf(p.status, 'Status', ['pending', 'approved', 'rejected', 'cancelled', 'expired', 'fulfilled', 'completed']) : '';
    var rows = Db.where('Reservations', function (r) { return (!status || r.status === status) && (!p.labId || r.labId === p.labId); }).reverse();
    return { reservations: rows.slice(0, 200).map(Booking._view), total: rows.length };
  },

  /** A student's own approved workstation (single asset) bookings in this lab that are running now (or start within `earlyMs`). */
  activeWorkstationBookings: function (studentId, labId, now, earlyMs) {
    var groups = {}; Db.whereEq('GroupMembers', { studentId: studentId }).forEach(function (m) { groups[m.groupId] = true; });
    return Db.where('Reservations', function (r) {
      return r.labId === labId && r.status === 'approved' && r.resourceType === 'asset' && r.startAt - (earlyMs || 0) <= now && now <= r.endAt &&
        ((r.requesterType === 'student' && r.requesterId === studentId) || (r.requesterType === 'group' && groups[r.requesterId]));
    });
  },
  /** A check-in by the booking's student during the slot marks it used (utilisation counts used slots, FR-25). */
  markUsed: function (studentId, labId, now) {
    Booking.activeWorkstationBookings(studentId, labId, now, 15 * 60000).forEach(function (r) {
      if (r.usedAt) return;
      Db.update('Reservations', r.reservationId, { usedAt: now });
      Audit.log({ actor: 'system', role: 'system', action: 'booking.used', entityType: 'Reservation', entityId: r.reservationId, detail: { studentId: studentId } });
    });
  },

  /**
   * Trigger. Pending requests whose start has passed expire. A workstation slot nobody checked in for is released
   * noShowReleaseMinutes after it starts (FR-25) and a used one completes at its end. Other approved bookings expire
   * when they are not collected within the collection window.
   */
  expireStale: function () {
    var now = U.now(), n = 0, released = 0, completed = 0, noShow = Settings.get('noShowReleaseMinutes') * 60000;
    Db.where('Reservations', function (r) { return r.status === 'pending' || r.status === 'approved'; }).forEach(function (r) {
      var note = null, status = 'expired';
      if (r.status === 'pending' && r.startAt < now) note = 'Not decided before start';
      else if (r.status === 'approved' && r.resourceType === 'asset') {
        if (r.usedAt && r.endAt < now) { status = 'completed'; note = 'Slot finished'; }
        else if (!r.usedAt && r.startAt + noShow < now) note = 'No-show: released ' + Math.round(noShow / 60000) + ' minutes after the start';
      } else if (r.status === 'approved' && r.startAt + Booking.NO_SHOW_MS < now) note = 'Not collected (no-show)';
      if (!note) return;
      try {
        var next = Db.update('Reservations', r.reservationId, { status: status, decidedAt: r.decidedAt || now, decisionNote: note });
        Audit.log({ actor: 'system', role: 'system', action: status === 'completed' ? 'booking.complete' : 'booking.expire', entityType: 'Reservation', entityId: r.reservationId, detail: { was: r.status, note: note } });
        if (status === 'completed') { completed++; return; }
        Booking._notifyRequester(next, 'booking', 'Booking ' + (r.resourceType === 'asset' && r.status === 'approved' ? 'released' : 'expired'), Booking._resourceName(next) + ' from ' + U.fmt(next.startAt) + ': ' + note + '.', 'bk-exp:' + r.reservationId);
        if (r.resourceType === 'asset' && r.status === 'approved') released++; else n++;
      } catch (e) { Syslog.error('booking', 'EXPIRE_FAILED', String(e && e.message), { id: r.reservationId }); }
    });
    return { expired: n, released: released, completed: completed };
  }
};

/**
 * Equipment requests made from inside the lab (FR-21): a student who is checked in asks for a component or kit now;
 * lab staff hand it over on the issue screen, which closes the request. Advance bookings (above) need no check-in.
 */
var Requests = {
  _view: function (r) {
    var st = Db.get('StudentProfiles', r.studentId) || {}, res = r.resourceType === 'kit' ? Db.get('Kits', r.resourceId) : Db.get('Categories', r.resourceId), lab = Db.cachedGet('Labs', 'labId', r.labId, 120) || {};
    return { requestId: r.requestId, labId: r.labId, labName: lab.name, sessionId: r.sessionId, studentId: r.studentId, name: st.name, rollNo: st.rollNo, resourceType: r.resourceType, resourceId: r.resourceId,
             resourceName: res ? res.name : r.resourceId, quantity: r.quantity, note: r.note, status: r.status, requestedAt: r.requestedAt, decidedAt: r.decidedAt, decisionNote: r.decisionNote, loanId: r.loanId };
  },
  create: function (ctx, p) {
    V.obj(p);
    var st = Creds._requireVerifiedStudent(ctx);
    var labId = V.id(p.labId, 'Lab', 'lab'), rt = V.enumOf(p.resourceType, 'Item type', ['category', 'kit']);
    var rid = rt === 'kit' ? V.id(p.resourceId, 'Kit', 'kit') : V.id(p.resourceId, 'Category', 'category');
    var qty = V.int(p.quantity === undefined ? 1 : p.quantity, 'Quantity', 1, 50), note = V.str(p.note, 'Note', { optional: true, max: 200 });
    var inside = Occupancy.insideSession(st.studentId, labId);
    if (Settings.get('requireCheckinForRequests') && !inside) fail('NOT_CHECKED_IN', 'Check in to this lab first. Requests are made from inside the lab; book ahead under Bookings.');
    if (rt === 'kit') { var kit = Db.mustGet('Kits', rid, 'Kit'); if (kit.labId !== labId || kit.status !== 'active') fail('BAD_INPUT', 'That kit is not available in this lab.'); }
    var now = U.now(), demand = Booking.demand(rt, rid, qty);
    Object.keys(demand).forEach(function (catId) {
      var av = Booking.availability(labId, catId, now, now + 3600000, null), cat = Db.get('Categories', catId);
      if (demand[catId] > av.free) fail('NOT_AVAILABLE', 'Not enough ' + (cat ? cat.name : 'stock') + ' right now: ' + av.free + ' free.');
    });
    return Locks.with(function () {
      var pending = Db.where('EquipmentRequests', function (r) { return r.studentId === st.studentId && r.status === 'pending'; });
      if (pending.length >= 3) fail('LIMIT', 'You already have 3 requests waiting at the desk.');
      var r = Db.insert('EquipmentRequests', { requestId: U.id('request'), labId: labId, sessionId: inside ? inside.sessionId : '', studentId: st.studentId, resourceType: rt, resourceId: rid, quantity: qty, note: note,
        status: 'pending', requestedAt: now });
      Audit.log({ actor: ctx.email, role: 'student', action: 'equipment.request', entityType: 'EquipmentRequest', entityId: r.requestId, detail: { labId: labId, resourceType: rt, resourceId: rid, quantity: qty } });
      var v = Requests._view(r);
      Notify.toRole('staff', 'equipment', 'Equipment request', v.name + ' (' + v.rollNo + ') asks for ' + v.resourceName + ' x' + qty + ' in ' + v.labName + '.', 'eqr:' + r.requestId);
      return { request: v };
    });
  },
  mine: function (ctx) {
    if (!ctx.student) return { requests: [] };
    return { requests: Db.where('EquipmentRequests', function (r) { return r.studentId === ctx.student.studentId; }).slice(-30).reverse().map(Requests._view) };
  },
  cancel: function (ctx, p) {
    V.obj(p);
    var r = Db.mustGet('EquipmentRequests', V.id(p.requestId, 'Request', 'request'), 'Request');
    if (!ctx.student || r.studentId !== ctx.student.studentId) fail('FORBIDDEN', 'This is not your request.');
    if (r.status !== 'pending') fail('INVALID_STATE', 'This request is already ' + r.status + '.');
    Db.update('EquipmentRequests', r.requestId, { status: 'cancelled', decidedAt: U.now() });
    return { ok: true };
  },
  list: function (ctx, p) {
    p = p || {};
    var status = V.enumOf(p.status, 'Status', ['pending', 'fulfilled', 'rejected', 'cancelled', 'all'], { optional: true, def: 'pending' });
    return { requests: Db.where('EquipmentRequests', function (r) { return (status === 'all' || r.status === status) && (!p.labId || r.labId === p.labId); }).slice(-200).reverse().map(Requests._view) };
  },
  decide: function (ctx, p) {
    V.obj(p);
    var note = V.str(p.note, 'Note', { min: 3, max: 200 });
    return Locks.with(function () {
      var r = Db.mustGet('EquipmentRequests', V.id(p.requestId, 'Request', 'request'), 'Request');
      if (r.status !== 'pending') fail('INVALID_STATE', 'This request is already ' + r.status + '.');
      Db.update('EquipmentRequests', r.requestId, { status: 'rejected', decidedBy: ctx.email, decidedAt: U.now(), decisionNote: note });
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'equipment.reject', entityType: 'EquipmentRequest', entityId: r.requestId, detail: { note: note } });
      Notify.toStudent(r.studentId, 'equipment', 'Request not filled', note, 'eqr-dec:' + r.requestId, { email: false });
      return { ok: true };
    });
  },
  /** Called by Loans.issue (inside its lock) when a loan hands over a requested item. */
  validateFulfilment: function (requestId, type, borrowerId, labId, demand, lines) {
    var r = Db.mustGet('EquipmentRequests', requestId, 'Request');
    if (r.status !== 'pending') fail('INVALID_STATE', 'That request is already ' + r.status + '.');
    if (type !== 'student' || borrowerId !== r.studentId || labId !== r.labId) fail('BAD_INPUT', 'That request belongs to a different student or lab.');
    Booking.validateContents(r, demand, lines);
    return r;
  },
  fulfil: function (requestId, loan, ctx) {
    var r = Db.mustGet('EquipmentRequests', requestId, 'Request');
    if (r.status !== 'pending') fail('INVALID_STATE', 'That request is already ' + r.status + '.');
    if (loan.borrowerType !== 'student' || loan.borrowerId !== r.studentId) fail('BAD_INPUT', 'That request belongs to a different student.');
    Db.update('EquipmentRequests', r.requestId, { status: 'fulfilled', decidedBy: ctx.email, decidedAt: U.now(), loanId: loan.loanId });
  }
};
