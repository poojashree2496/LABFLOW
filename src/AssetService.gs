/**
 * AssetService.gs - categories, assets, kits, groups, loans and returns.
 *
 * Consistency model
 *  - Source of truth: Loans + LoanItems (what is out, who has it) and the append-only AssetEvents ledger.
 *  - Assets.quantityAvailable / status / currentLoanId are DERIVED caches of that truth. Assets.reconcile()
 *    recomputes them from LoanItems and repairs drift (and fails loans left half-written in state 'issuing').
 *  - Every state-changing call carries a client idempotency key. A retry after a timeout therefore returns the
 *    original result instead of issuing or returning twice (Loans.idemKey and AssetEvents.idemKey are unique).
 *  - Each multi-sheet operation runs under the script lock. A loan is written as 'issuing', completed, then set
 *    to 'open'; a crash in between leaves a visible 'issuing' loan that reconcile() rolls back.
 *  - Returns first persist a zero-quantity return-plan ledger row. Absolute patches and deduplicated events
 *    can be replayed after interruption; a return-complete row closes the plan. Stock mutations and reconciliation
 *    recover pending plans before making new changes. No sheet/header migration is required.
 *
 * Quantity items: quantityTotal is working stock. Consumed / damaged / missing units leave quantityTotal
 * (written off); returned units go back to quantityAvailable. Individual items are always quantity 1.
 */
var Assets = {
  OUT: 'out',
  IDEM_RE: /^[A-Za-z0-9_-]{16,64}$/,
  _idem: function (v) { if (typeof v !== 'string' || !Assets.IDEM_RE.test(v)) fail('BAD_INPUT', 'A request key is required (16-64 letters, digits, - or _). Reload the page and try again.'); return v; },

  // ---- categories ----------------------------------------------------------------------------------
  listCategories: function () { return { categories: Db.readAll('Categories') }; },
  upsertCategory: function (ctx, p) {
    V.obj(p);
    var rec = { name: V.str(p.name, 'Name', { max: 60 }), trackingMode: V.enumOf(p.trackingMode, 'Tracking mode', ['individual', 'quantity']), notes: V.str(p.notes, 'Notes', { optional: true, max: 200 }) };
    return Locks.with(function () {
      var c;
      if (p.categoryId) {
        var cur = Db.mustGet('Categories', V.id(p.categoryId, 'Category', 'category'), 'Category');
        if (cur.trackingMode !== rec.trackingMode && Db.whereEq('Assets', { categoryId: cur.categoryId }).length) fail('INVALID_STATE', 'Tracking mode cannot change once assets exist in the category.');
        c = Db.update('Categories', cur.categoryId, rec);
      } else c = Db.insert('Categories', Object.assign({ categoryId: U.id('category') }, rec));
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: p.categoryId ? 'category.update' : 'category.create', entityType: 'Category', entityId: c.categoryId, detail: rec });
      return { category: c };
    });
  },

  // ---- assets --------------------------------------------------------------------------------------
  _pub: function (a, ctx) {
    var o = { assetId: a.assetId, labId: a.labId, categoryId: a.categoryId, name: a.name, serialNo: a.serialNo, assetTag: a.assetTag, trackingMode: a.trackingMode,
      quantityTotal: a.quantityTotal, quantityAvailable: a.quantityAvailable, status: a.status, condition: a.condition, location: a.location, currentLoanId: a.currentLoanId, notes: a.notes };
    if (ctx && (ctx.has('admin') || ctx.has('staff'))) o.valueInr = a.valueInr;
    return o;
  },
  list: function (ctx, p) {
    p = p || {};
    var q = p.q ? String(p.q).toLowerCase().slice(0, 60) : '';
    var rows = Db.where('Assets', function (a) {
      if (p.labId && a.labId !== p.labId) return false;
      if (p.categoryId && a.categoryId !== p.categoryId) return false;
      if (p.status && a.status !== p.status) return false;
      if (q && (a.name + ' ' + a.assetTag + ' ' + a.serialNo).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var total = rows.length, limit = V.int(p.limit, 'Limit', 1, 500, { optional: true, def: 200 });
    return { assets: rows.slice(0, limit).map(function (a) { return Assets._pub(a, ctx); }), total: total };
  },
  /**
   * What a lab has and what is free right now, for anyone signed in (FR-20: students see availability without
   * checking in). No serial numbers, values or borrower details. Workstations (individually tracked) are listed by
   * name so they can be booked.
   */
  catalog: function (ctx, p) {
    p = p || {};
    var labs = Db.where('Labs', function (l) { return l.status === 'active' && (!p.labId || l.labId === p.labId); }), now = U.now(), cats = Db.readAll('Categories');
    return { labs: labs.map(function (lab) {
      var assets = Db.whereEq('Assets', { labId: lab.labId });
      var categories = cats.filter(function (c) { return assets.some(function (a) { return a.categoryId === c.categoryId; }); }).map(function (c) {
        var av = Booking.availability(lab.labId, c.categoryId, now, now + 3600000, null);
        return { categoryId: c.categoryId, name: c.name, trackingMode: c.trackingMode, total: av.total, free: av.free };
      });
      var units = assets.filter(function (a) { return a.trackingMode === 'individual' && (a.status === 'available' || a.status === 'on_loan'); })
        .map(function (a) { return { assetId: a.assetId, name: a.name, assetTag: a.assetTag, categoryId: a.categoryId, status: a.status }; });
      var kits = Db.where('Kits', function (k) { return k.labId === lab.labId && k.status === 'active'; }).map(function (k) {
        var comps = Db.whereEq('KitComponents', { kitId: k.kitId }).filter(function (c) { return c.quantity > 0; });
        var can = comps.length ? Math.min.apply(null, comps.map(function (c) { var av = Booking.availability(lab.labId, c.categoryId, now, now + 3600000, null); return Math.floor(av.free / c.quantity); })) : 0;
        return { kitId: k.kitId, name: k.name, description: k.description, available: can };
      });
      return { labId: lab.labId, code: lab.code, name: lab.name, type: lab.type, categories: categories, units: units, kits: kits };
    }), serverNow: now };
  },
  _validate: function (p, existing) {
    var cat = Db.mustGet('Categories', V.id(p.categoryId, 'Category', 'category'), 'Category');
    var lab = Db.mustGet('Labs', V.id(p.labId, 'Lab', 'lab'), 'Lab');
    var rec = {
      labId: lab.labId, categoryId: cat.categoryId, name: V.str(p.name, 'Name', { max: 80 }), serialNo: V.str(p.serialNo, 'Serial number', { optional: true, max: 60 }),
      trackingMode: cat.trackingMode, location: V.str(p.location, 'Location', { optional: true, max: 60 }), notes: V.str(p.notes, 'Notes', { optional: true, max: 300 }),
      condition: V.enumOf(p.condition, 'Condition', Cfg.CONDITIONS, { optional: true, def: existing ? existing.condition : 'good' }),
      valueInr: V.num(p.valueInr, 'Value', 0, 100000000, { optional: true, def: 0 })
    };
    if (cat.trackingMode === 'individual') rec.assetTag = V.str(p.assetTag, 'Asset tag', { max: 40, re: /^[A-Za-z0-9._\/-]+$/ }).toUpperCase();
    else rec.assetTag = p.assetTag ? V.str(p.assetTag, 'Asset tag', { max: 40, re: /^[A-Za-z0-9._\/-]+$/ }).toUpperCase() : '';
    return rec;
  },
  upsert: function (ctx, p) {
    V.obj(p);
    return Locks.with(function () {
      Loans._recoverReturns();
      var cur = p.assetId ? Db.mustGet('Assets', V.id(p.assetId, 'Asset', 'asset'), 'Asset') : null;
      var rec = Assets._validate(p, cur), now = U.now(), a;
      if (cur && cur.trackingMode !== rec.trackingMode) fail('INVALID_STATE', 'The category tracking mode of an existing asset cannot change.');
      if (rec.trackingMode === 'individual') {
        rec.quantityTotal = 1;
        var status = V.enumOf(p.status, 'Status', ['available', 'maintenance', 'retired', 'damaged', 'missing'], { optional: true, def: cur ? cur.status : 'available' });
        if (cur && cur.currentLoanId && status !== cur.status) fail('INVALID_STATE', 'This asset is on loan. Return it first.');
        rec.status = cur && cur.currentLoanId ? cur.status : status;
        rec.quantityAvailable = rec.status === 'available' ? 1 : 0;
      } else {
        var total = V.int(p.quantityTotal, 'Quantity', 0, 1000000);
        var out = cur ? Assets._outstandingQty(cur.assetId) : 0;
        if (total < out) fail('INVALID_STATE', out + ' units are currently on loan, so the total cannot be below ' + out + '.');
        rec.quantityTotal = total; rec.quantityAvailable = total - out;
        rec.status = V.enumOf(p.status, 'Status', ['available', 'maintenance', 'retired'], { optional: true, def: cur ? cur.status : 'available' });
      }
      if (cur) a = Db.update('Assets', cur.assetId, Object.assign(rec, { updatedAt: now }));
      else a = Db.insert('Assets', Object.assign({ assetId: U.id('asset'), currentLoanId: '', createdAt: now, updatedAt: now }, rec));
      if (!cur || (cur.quantityTotal !== a.quantityTotal)) Assets._event(a.assetId, '', cur ? 'adjust' : 'create', a.quantityTotal - (cur ? cur.quantityTotal : 0), ctx.email, 'asset ' + (cur ? 'edited' : 'created'), '');
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: cur ? 'asset.update' : 'asset.create', entityType: 'Asset', entityId: a.assetId, detail: { name: a.name, tag: a.assetTag, status: a.status, total: a.quantityTotal } });
      return { asset: Assets._pub(a, ctx) };
    });
  },
  /** Bulk add. All-or-nothing on uniqueness; every row is validated first and the errors are reported per row. */
  importAssets: function (ctx, p) {
    V.obj(p);
    var rows = V.arr(p.rows, 'Rows', 300), errors = [], recs = [], now = U.now();
    var cats = U.indexBy(Db.readAll('Categories'), 'name'), labs = U.indexBy(Db.readAll('Labs'), 'code');
    rows.forEach(function (r, i) {
      try {
        V.obj(r);
        var cat = cats[String(r.category || '').trim()], lab = labs[String(r.lab || '').trim().toUpperCase()];
        if (!cat) fail('BAD_INPUT', 'Unknown category "' + r.category + '".');
        if (!lab) fail('BAD_INPUT', 'Unknown lab code "' + r.lab + '".');
        var rec = Assets._validate({ categoryId: cat.categoryId, labId: lab.labId, name: r.name, serialNo: r.serialNo, assetTag: r.assetTag, location: r.location, notes: r.notes, valueInr: r.valueInr, condition: r.condition }, null);
        if (rec.trackingMode === 'individual') { rec.quantityTotal = 1; rec.quantityAvailable = 1; }
        else { rec.quantityTotal = V.int(r.quantity, 'Quantity', 0, 1000000); rec.quantityAvailable = rec.quantityTotal; }
        recs.push(Object.assign({ assetId: U.id('asset'), status: 'available', currentLoanId: '', createdAt: now, updatedAt: now }, rec));
      } catch (e) { errors.push({ row: i + 1, error: e instanceof AppError ? e.message : 'Invalid row.' }); }
    });
    if (errors.length) return { imported: 0, errors: errors };
    var created = Db.insertMany('Assets', recs);
    Db.insertMany('AssetEvents', created.map(function (a) { return { txId: U.id('tx'), assetId: a.assetId, loanId: '', type: 'create', qtyDelta: a.quantityTotal, at: now, by: ctx.email, note: 'imported', idemKey: '' }; }));
    Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'asset.import', entityType: 'Asset', entityId: '', detail: { count: created.length } });
    return { imported: created.length, errors: [] };
  },
  /** Record a condition check with no loan involved. Poor/damaged takes the asset out of circulation. */
  conditionCheck: function (ctx, p) {
    V.obj(p);
    var key = Assets._idem(p.idemKey), condition = V.enumOf(p.condition, 'Condition', Cfg.CONDITIONS), note = V.str(p.note, 'Note', { optional: true, max: 300 });
    return Locks.with(function () {
      Loans._recoverReturns();
      if (Db.getBy('AssetEvents', 'idemKey', 'cond:' + key)) return { replayed: true };
      var a = Db.mustGet('Assets', V.id(p.assetId, 'Asset', 'asset'), 'Asset');
      var patch = { condition: condition, updatedAt: U.now() };
      if (a.trackingMode === 'individual' && !a.currentLoanId && condition === 'damaged' && a.status === 'available') { patch.status = 'damaged'; patch.quantityAvailable = 0; }
      var next = Db.update('Assets', a.assetId, patch);
      Assets._event(a.assetId, '', 'condition', 0, ctx.email, condition + (note ? ': ' + note : ''), 'cond:' + key);
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'asset.condition', entityType: 'Asset', entityId: a.assetId, detail: { from: a.condition, to: condition, note: note } });
      return { asset: Assets._pub(next, ctx) };
    });
  },
  history: function (ctx, p) {
    V.obj(p);
    var id = V.id(p.assetId, 'Asset', 'asset');
    return { events: Db.where('AssetEvents', function (e) { return e.assetId === id; }).slice(-100).reverse() };
  },
  _event: function (assetId, loanId, type, delta, by, note, idemKey) {
    return Db.insert('AssetEvents', { txId: U.id('tx'), assetId: assetId, loanId: loanId || '', type: type, qtyDelta: delta, at: U.now(), by: by, note: String(note || '').slice(0, 300), idemKey: idemKey || '' });
  },
  _outstandingQty: function (assetId) {
    var n = 0;
    Db.whereEq('LoanItems', { assetId: assetId }).forEach(function (i) { if (i.status === Assets.OUT) n += i.qtyIssued - i.qtyReturned - i.qtyConsumed - i.qtyDamaged - i.qtyMissing; });
    return n;
  },

  /**
   * Recompute derived asset fields from LoanItems. Safe to run at any time and by a trigger.
   * fix=false reports only. Stale 'issuing' loans (crashed mid-write) are failed and their items voided first.
   */
  reconcile: function (opts) {
    var fix = !opts || opts.fix !== false;
    return Locks.with(function () {
      if (fix) Loans._recoverReturns();
      var report = { staleLoans: [], drift: [], fixed: 0 };
      var staleBefore = U.now() - 5 * 60000;
      var forced = {}; ((opts && opts.failLoanIds) || []).forEach(function (id) { forced[id] = true; });
      Db.where('Loans', function (l) { return l.status === 'issuing' && (l.issuedAt < staleBefore || forced[l.loanId]); }).forEach(function (l) {
        report.staleLoans.push(l.loanId);
        if (!fix) return;
        Db.whereEq('LoanItems', { loanId: l.loanId }).forEach(function (i) {
          if (i.status !== Assets.OUT) return;
          Db.update('LoanItems', i.loanItemId, { status: 'voided' });
          // The ledger is append-only: if the issue event was written, cancel it with a compensating event.
          if (Db.getBy('AssetEvents', 'idemKey', 'iss:' + l.loanId + ':' + i.assetId)) Assets._event(i.assetId, l.loanId, 'rollback', i.qtyIssued, 'system', 'issue rolled back', 'rb:' + l.loanId + ':' + i.assetId);
        });
        if (l.reservationId) { var rsv = Db.get('Reservations', l.reservationId); if (rsv && rsv.status === 'fulfilled') Db.update('Reservations', rsv.reservationId, { status: 'approved' }); }
        Db.where('EquipmentRequests', function (r) { return r.loanId === l.loanId && r.status === 'fulfilled'; }).forEach(function (r) {
          Db.update('EquipmentRequests', r.requestId, { status: 'pending', loanId: '', decidedBy: '', decidedAt: null, decisionNote: '' });
        });
        Db.update('Loans', l.loanId, { status: 'failed', notes: 'Rolled back by reconcile: issue did not complete.' });
        Audit.log({ actor: 'system', role: 'system', action: 'loan.rollback', entityType: 'Loan', entityId: l.loanId, result: 'ok', detail: { reason: 'issue did not complete' } });
      });
      var outByAsset = {}, loanOfAsset = {};
      Db.where('LoanItems', function (i) { return i.status === Assets.OUT; }).forEach(function (i) {
        var q = i.qtyIssued - i.qtyReturned - i.qtyConsumed - i.qtyDamaged - i.qtyMissing;
        outByAsset[i.assetId] = (outByAsset[i.assetId] || 0) + q; loanOfAsset[i.assetId] = i.loanId;
      });
      Db.readAll('Assets').forEach(function (a) {
        var out = outByAsset[a.assetId] || 0, patch = null;
        if (a.trackingMode === 'quantity') {
          var avail = a.quantityTotal - out;
          if (avail !== a.quantityAvailable) patch = { quantityAvailable: avail };
        } else {
          var wantLoan = out > 0 ? loanOfAsset[a.assetId] : '';
          if (out > 0 && a.status !== 'on_loan') patch = { status: 'on_loan', quantityAvailable: 0, currentLoanId: wantLoan };
          else if (out === 0 && a.status === 'on_loan') patch = { status: 'available', quantityAvailable: 1, currentLoanId: '' };
          else if ((a.currentLoanId || '') !== wantLoan) patch = { currentLoanId: wantLoan };
          else if (a.status === 'available' && a.quantityAvailable !== 1) patch = { quantityAvailable: 1 };
          else if (a.status !== 'available' && a.status !== 'on_loan' && a.quantityAvailable !== 0) patch = { quantityAvailable: 0 };
        }
        if (patch) {
          report.drift.push({ assetId: a.assetId, name: a.name, from: { status: a.status, available: a.quantityAvailable, loan: a.currentLoanId }, to: patch });
          if (fix) { Db.update('Assets', a.assetId, Object.assign(patch, { updatedAt: U.now() })); report.fixed++; }
        }
      });
      // A loan whose items are all closed must be closed, and vice versa.
      Db.where('Loans', function (l) { return l.status === 'open' || l.status === 'partial'; }).forEach(function (l) {
        var items = Db.whereEq('LoanItems', { loanId: l.loanId }).filter(function (i) { return i.status !== 'voided'; });
        var anyOut = items.some(function (i) { return i.status === Assets.OUT; });
        if (!anyOut && items.length) {
          report.drift.push({ loanId: l.loanId, from: l.status, to: 'closed' });
          if (fix) { Db.update('Loans', l.loanId, { status: 'closed', returnedAt: l.returnedAt || U.now() }); report.fixed++; }
        }
      });
      if (fix && report.fixed) Audit.log({ actor: 'system', role: 'system', action: 'inventory.reconcile', entityType: 'Asset', entityId: '', detail: { fixed: report.fixed, stale: report.staleLoans.length } });
      return report;
    });
  }
};

var Kits = {
  _view: function (k) {
    var comps = Db.whereEq('KitComponents', { kitId: k.kitId }).filter(function (c) { return c.quantity > 0; });
    return { kitId: k.kitId, labId: k.labId, name: k.name, description: k.description, status: k.status, components: comps.map(function (c) { return { componentId: c.componentId, categoryId: c.categoryId, quantity: c.quantity, note: c.note }; }) };
  },
  list: function (ctx, p) { return { kits: Db.where('Kits', function (k) { return !(p && p.labId) || k.labId === p.labId; }).map(Kits._view) }; },
  upsert: function (ctx, p) {
    V.obj(p);
    var comps = V.arr(p.components, 'Components', 40);
    if (!comps.length) fail('BAD_INPUT', 'A kit needs at least one component.');
    var seen = {};
    var clean = comps.map(function (c) {
      V.obj(c);
      var catId = V.id(c.categoryId, 'Category', 'category');
      if (seen[catId]) fail('BAD_INPUT', 'Each category can appear once per kit.');
      seen[catId] = true; Db.mustGet('Categories', catId, 'Category');
      return { categoryId: catId, quantity: V.int(c.quantity, 'Quantity', 1, 1000), note: V.str(c.note, 'Note', { optional: true, max: 100 }) };
    });
    var rec = { labId: V.id(p.labId, 'Lab', 'lab'), name: V.str(p.name, 'Name', { max: 80 }), description: V.str(p.description, 'Description', { optional: true, max: 300 }), status: V.enumOf(p.status, 'Status', ['active', 'inactive'], { optional: true, def: 'active' }) };
    Db.mustGet('Labs', rec.labId, 'Lab');
    return Locks.with(function () {
      var k = p.kitId ? Db.update('Kits', V.id(p.kitId, 'Kit', 'kit'), rec) : Db.insert('Kits', Object.assign({ kitId: U.id('kit'), createdAt: U.now() }, rec));
      var existing = Db.whereEq('KitComponents', { kitId: k.kitId }), byCat = U.indexBy(existing, 'categoryId');
      clean.forEach(function (c) {
        if (byCat[c.categoryId]) Db.update('KitComponents', byCat[c.categoryId].componentId, { quantity: c.quantity, note: c.note });
        else Db.insert('KitComponents', { componentId: U.id('component'), kitId: k.kitId, categoryId: c.categoryId, quantity: c.quantity, note: c.note });
      });
      existing.forEach(function (e) { if (!seen[e.categoryId] && e.quantity > 0) Db.update('KitComponents', e.componentId, { quantity: 0 }); }); // soft remove
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: p.kitId ? 'kit.update' : 'kit.create', entityType: 'Kit', entityId: k.kitId, detail: { name: rec.name, components: clean.length } });
      return { kit: Kits._view(k) };
    });
  }
};

var Groups = {
  _view: function (g) {
    var members = Db.whereEq('GroupMembers', { groupId: g.groupId });
    var profiles = U.indexBy(Db.readAll('StudentProfiles'), 'studentId');
    return { groupId: g.groupId, name: g.name, courseId: g.courseId, labId: g.labId, status: g.status,
      members: members.map(function (m) { var s = profiles[m.studentId]; return { groupMemberId: m.groupMemberId, studentId: m.studentId, name: s ? s.name : '', rollNo: s ? s.rollNo : '', isLeader: m.isLeader }; }) };
  },
  list: function (ctx, p) {
    var mine = Groups._mineIds(ctx);
    var rows = Db.where('Groups', function (g) { return g.status === 'active' && (ctx.has('admin') || ctx.has('staff') || ctx.has('faculty') || mine[g.groupId]); });
    return { groups: rows.map(Groups._view) };
  },
  _mineIds: function (ctx) {
    var out = {};
    if (ctx.student) Db.whereEq('GroupMembers', { studentId: ctx.student.studentId }).forEach(function (m) { out[m.groupId] = true; });
    return out;
  },
  create: function (ctx, p) {
    V.obj(p);
    var ids = V.arr(p.studentIds, 'Members', 12);
    if (!ids.length) fail('BAD_INPUT', 'A group needs at least one member.');
    var leader = p.leaderId ? V.id(p.leaderId, 'Leader', 'student') : ids[0];
    var uniq = U.uniq(ids.map(function (s) { return V.id(s, 'Student', 'student'); }));
    if (uniq.indexOf(leader) < 0) fail('BAD_INPUT', 'The leader must be a member.');
    uniq.forEach(function (sid) { var s = Db.mustGet('StudentProfiles', sid, 'Student'); if (s.status !== 'verified') fail('BAD_INPUT', s.name + ' is not a verified student.'); });
    var rec = { name: V.str(p.name, 'Group name', { max: 60 }), courseId: p.courseId ? V.id(p.courseId, 'Course', 'course') : '', labId: p.labId ? V.id(p.labId, 'Lab', 'lab') : '', status: 'active' };
    return Locks.with(function () {
      var g = Db.insert('Groups', Object.assign({ groupId: U.id('group'), createdBy: ctx.email, createdAt: U.now() }, rec));
      Db.insertMany('GroupMembers', uniq.map(function (sid) { return { groupMemberId: U.id('member'), groupId: g.groupId, studentId: sid, isLeader: sid === leader, addedAt: U.now() }; }));
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'group.create', entityType: 'Group', entityId: g.groupId, detail: { name: rec.name, members: uniq.length } });
      return { group: Groups._view(g) };
    });
  },
  setStatus: function (ctx, p) {
    V.obj(p);
    var g = Db.mustGet('Groups', V.id(p.groupId, 'Group', 'group'), 'Group');
    var status = V.enumOf(p.status, 'Status', ['active', 'disbanded']);
    if (status === 'disbanded' && Loans._openFor('group', g.groupId).length) fail('INVALID_STATE', 'The group has open loans.');
    Db.update('Groups', g.groupId, { status: status });
    Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'group.status', entityType: 'Group', entityId: g.groupId, detail: { status: status } });
    return { ok: true };
  }
};

var Loans = {
  _openFor: function (type, id) { return Db.where('Loans', function (l) { return l.borrowerType === type && l.borrowerId === id && (l.status === 'open' || l.status === 'partial' || l.status === 'issuing'); }); },
  _isOverdue: function (l, now) { return (l.status === 'open' || l.status === 'partial') && l.dueAt < (now || U.now()); },
  _borrowerName: function (l) {
    if (l.borrowerType === 'group') { var g = Db.get('Groups', l.borrowerId); return g ? g.name : l.borrowerId; }
    var s = Db.get('StudentProfiles', l.borrowerId); return s ? s.name + ' (' + s.rollNo + ')' : l.borrowerId;
  },
  _view: function (l, withItems) {
    var o = { loanId: l.loanId, labId: l.labId, borrowerType: l.borrowerType, borrowerId: l.borrowerId, borrowerName: Loans._borrowerName(l), kitId: l.kitId, reservationId: l.reservationId, status: l.status,
      overdue: Loans._isOverdue(l), issuedAt: l.issuedAt, dueAt: l.dueAt, returnedAt: l.returnedAt, notes: l.notes };
    if (withItems) {
      var assets = {};
      o.items = Db.whereEq('LoanItems', { loanId: l.loanId }).map(function (i) {
        var a = assets[i.assetId] || (assets[i.assetId] = Db.get('Assets', i.assetId));
        return { loanItemId: i.loanItemId, assetId: i.assetId, name: a ? a.name : i.assetId, assetTag: a ? a.assetTag : '', trackingMode: a ? a.trackingMode : '', qtyIssued: i.qtyIssued, qtyReturned: i.qtyReturned, qtyConsumed: i.qtyConsumed, qtyDamaged: i.qtyDamaged,
          qtyMissing: i.qtyMissing, outstanding: i.status === Assets.OUT ? i.qtyIssued - i.qtyReturned - i.qtyConsumed - i.qtyDamaged - i.qtyMissing : 0, conditionOut: i.conditionOut, conditionIn: i.conditionIn, status: i.status };
      });
    }
    return o;
  },
  _canSee: function (ctx, l) {
    if (ctx.has('admin') || ctx.has('staff')) return true;
    if (!ctx.student) return false;
    if (l.borrowerType === 'student') return l.borrowerId === ctx.student.studentId;
    return !!Groups._mineIds(ctx)[l.borrowerId];
  },
  get: function (ctx, p) {
    V.obj(p);
    var l = Db.mustGet('Loans', V.id(p.loanId, 'Loan', 'loan'), 'Loan');
    if (!Loans._canSee(ctx, l)) fail('FORBIDDEN', 'You do not have permission to view this loan.');
    return { loan: Loans._view(l, true) };
  },
  mine: function (ctx) {
    if (!ctx.student) return { loans: [] };
    var groups = Groups._mineIds(ctx), sid = ctx.student.studentId;
    var rows = Db.where('Loans', function (l) { return l.status !== 'failed' && l.status !== 'issuing' && ((l.borrowerType === 'student' && l.borrowerId === sid) || (l.borrowerType === 'group' && groups[l.borrowerId])); });
    return { loans: rows.slice(-100).reverse().map(function (l) { return Loans._view(l, true); }) };
  },
  list: function (ctx, p) {
    p = p || {};
    var status = p.status ? V.enumOf(p.status, 'Status', ['open', 'partial', 'closed', 'overdue', 'active']) : '';
    var now = U.now(), q = p.q ? String(p.q).toLowerCase().slice(0, 60) : '';
    var rows = Db.where('Loans', function (l) {
      if (l.status === 'failed') return false;
      if (p.labId && l.labId !== p.labId) return false;
      if (status === 'overdue' && !Loans._isOverdue(l, now)) return false;
      if (status === 'active' && l.status !== 'open' && l.status !== 'partial') return false;
      if (status && status !== 'overdue' && status !== 'active' && l.status !== status) return false;
      if (p.borrowerId && l.borrowerId !== p.borrowerId) return false;
      return true;
    }).reverse();
    var out = rows.slice(0, 200).map(function (l) { return Loans._view(l, false); });
    if (q) out = out.filter(function (l) { return (l.borrowerName + ' ' + l.loanId).toLowerCase().indexOf(q) >= 0; });
    return { loans: out, total: rows.length };
  },

  /** Resolve the requested lines (assets + quantities) from direct items and/or a kit with picked assets. */
  _lines: function (p, labId) {
    var lines = {}, order = [];
    function add(assetId, qty) { if (!lines[assetId]) { lines[assetId] = 0; order.push(assetId); } lines[assetId] += qty; }
    var kit = null;
    if (p.kitId) {
      kit = Db.mustGet('Kits', V.id(p.kitId, 'Kit', 'kit'), 'Kit');
      if (kit.status !== 'active') fail('INVALID_STATE', 'This kit is inactive.');
      if (kit.labId !== labId) fail('BAD_INPUT', 'This kit belongs to a different lab.');
      var picks = V.arr(p.kitPicks || [], 'Kit picks', 80), comps = Db.whereEq('KitComponents', { kitId: kit.kitId }).filter(function (c) { return c.quantity > 0; });
      comps.forEach(function (c) {
        var mine = picks.filter(function (x) { return x && x.componentId === c.componentId; }), got = 0;
        mine.forEach(function (x) {
          var a = Db.mustGet('Assets', V.id(x.assetId, 'Asset', 'asset'), 'Asset');
          if (a.categoryId !== c.categoryId) fail('BAD_INPUT', a.name + ' is not the right category for this kit component.');
          var q = V.int(x.qty === undefined ? 1 : x.qty, 'Quantity', 1, 100000); got += q; add(a.assetId, q);
        });
        if (got !== c.quantity) { var cat = Db.get('Categories', c.categoryId); fail('BAD_INPUT', 'Kit component ' + (cat ? cat.name : c.categoryId) + ' needs exactly ' + c.quantity + ' (got ' + got + ').'); }
      });
      picks.forEach(function (x) { if (!comps.some(function (c) { return x && c.componentId === x.componentId; })) fail('BAD_INPUT', 'Unknown kit component.'); });
    }
    V.arr(p.items || [], 'Items', 80).forEach(function (x) { V.obj(x); add(V.id(x.assetId, 'Asset', 'asset'), V.int(x.qty === undefined ? 1 : x.qty, 'Quantity', 1, 100000)); });
    if (!order.length) fail('BAD_INPUT', 'Select at least one item to issue.');
    if (order.length > 80) fail('BAD_INPUT', 'Too many items in one loan.');
    return { kit: kit, lines: order.map(function (id) { return { assetId: id, qty: lines[id] }; }) };
  },

  issue: function (ctx, p) {
    V.obj(p);
    var key = Assets._idem(p.idemKey);
    var type = V.enumOf(p.borrowerType, 'Borrower type', ['student', 'group']);
    var borrowerId = type === 'student' ? V.id(p.borrowerId, 'Student', 'student') : V.id(p.borrowerId, 'Group', 'group');
    var labId = V.id(p.labId, 'Lab', 'lab');
    var notes = V.str(p.notes, 'Notes', { optional: true, max: 300 });
    return Locks.with(function () {
      Loans._recoverReturns();
      var prior = Db.getBy('Loans', 'idemKey', key);
      if (prior) {
        if (prior.status === 'failed') fail('RETRY', 'That attempt did not complete and was rolled back. Try again.');
        if (prior.status === 'issuing') fail('IN_PROGRESS', 'That issue is still being processed. Check the loan list before trying again.');
        return { loan: Loans._view(prior, true), replayed: true };
      }
      var now = U.now();
      Db.mustGet('Labs', labId, 'Lab');
      if (type === 'student') { var st = Db.mustGet('StudentProfiles', borrowerId, 'Student'); if (st.status !== 'verified') fail('INVALID_STATE', st.name + ' is not a verified student.'); }
      else { var g = Db.mustGet('Groups', borrowerId, 'Group'); if (g.status !== 'active') fail('INVALID_STATE', 'This group is not active.'); }
      var open = Loans._openFor(type, borrowerId);
      if (open.length >= Settings.get('maxOpenLoansPerBorrower')) fail('LIMIT', 'Open-loan limit reached (' + Settings.get('maxOpenLoansPerBorrower') + ').');
      if (Settings.get('blockLoansWhenOverdue') && open.some(function (l) { return Loans._isOverdue(l, now); })) fail('OVERDUE', 'The borrower has overdue items. Return them before borrowing more.');
      var reservation = null;
      if (p.reservationId) {
        reservation = Db.mustGet('Reservations', V.id(p.reservationId, 'Reservation', 'reservation'), 'Reservation');
        if (reservation.status !== 'approved') fail('INVALID_STATE', 'The booking is ' + reservation.status + ', not approved.');
        if (reservation.labId !== labId) fail('BAD_INPUT', 'The booking is for a different lab.');
        if (now < reservation.startAt - Booking.COLLECT_EARLY_MS) fail('TOO_EARLY', 'The booking starts at ' + U.fmt(reservation.startAt) + '. Collection opens at ' + U.fmt(reservation.startAt - Booking.COLLECT_EARLY_MS) + '.');
        if (now > reservation.endAt) fail('INVALID_STATE', 'The booking has ended.');
        var okReq = (reservation.requesterType === 'student' && type === 'student' && reservation.requesterId === borrowerId) || (reservation.requesterType === 'group' && type === 'group' && reservation.requesterId === borrowerId);
        if (!okReq) fail('BAD_INPUT', 'This booking belongs to a different borrower.');
      }
      var days = V.int(p.days, 'Days', 1, 120, { optional: true, def: Settings.get('loanDefaultDays') });
      var dueAt = reservation ? reservation.endAt : now + days * 86400000;
      var resolved = Loans._lines(p, labId);
      // Re-read each asset INSIDE the lock; this is what prevents two counters issuing the same item.
      var assets = {}, demand = {};
      var namedHolds = Db.where('Reservations', function (r) {
        return r.labId === labId && r.resourceType === 'asset' && Booking._holds(r) &&
          (!reservation || r.reservationId !== reservation.reservationId) && U.overlaps(now, dueAt, r.startAt, r.endAt);
      });
      resolved.lines.forEach(function (ln) {
        var a = Db.mustGet('Assets', ln.assetId, 'Asset'); assets[a.assetId] = a;
        if (a.labId !== labId) fail('BAD_INPUT', a.name + ' belongs to a different lab.');
        if (a.status !== 'available' && !(a.trackingMode === 'quantity' && a.status === 'on_loan')) fail('UNAVAILABLE', a.name + ' is not available (' + a.status + ').');
        if (a.trackingMode === 'individual' && ln.qty !== 1) fail('BAD_INPUT', a.name + ' is tracked individually: quantity must be 1.');
        if (ln.qty > a.quantityAvailable) fail('UNAVAILABLE', 'Only ' + a.quantityAvailable + ' of ' + a.name + ' available.');
        if (namedHolds.some(function (r) { return r.resourceId === a.assetId; })) fail('RESERVED', a.name + ' is reserved by another booking during this loan.');
        demand[a.categoryId] = (demand[a.categoryId] || 0) + ln.qty;
      });
      if (reservation) Booking.validateContents(reservation, demand, resolved.lines);
      var requestId = p.requestId ? V.id(p.requestId, 'Request', 'request') : '';
      if (requestId) Requests.validateFulfilment(requestId, type, borrowerId, labId, demand, resolved.lines);
      // Immediate checkout must not eat stock promised to approved advance bookings in the loan window.
      Object.keys(demand).forEach(function (catId) {
        var av = Booking.availability(labId, catId, now, dueAt, reservation ? reservation.reservationId : null);
        // av.reserved already excludes the booking being collected, so that booking's own stock stays available to it.
        var free = av.physicalFree - av.reserved;
        if (demand[catId] > free) { var cat = Db.get('Categories', catId); fail('RESERVED', 'Stock of ' + (cat ? cat.name : catId) + ' is reserved by approved bookings in this period (free: ' + Math.max(0, free) + ').'); }
      });
      var loan = Db.insert('Loans', { loanId: U.id('loan'), labId: labId, borrowerType: type, borrowerId: borrowerId, kitId: resolved.kit ? resolved.kit.kitId : '', reservationId: reservation ? reservation.reservationId : '',
        status: 'issuing', issuedBy: ctx.email, issuedAt: now, dueAt: dueAt, returnedAt: null, verifiedBy: ctx.email, notes: notes, idemKey: key });
      try {
        var condOut = p.conditions && typeof p.conditions === 'object' ? p.conditions : {};
        var items = resolved.lines.map(function (ln) {
          var a = assets[ln.assetId];
          return { loanItemId: U.id('loanItem'), loanId: loan.loanId, assetId: a.assetId, categoryId: a.categoryId, qtyIssued: ln.qty, qtyReturned: 0, qtyConsumed: 0, qtyDamaged: 0, qtyMissing: 0,
            conditionOut: Cfg.CONDITIONS.indexOf(condOut[a.assetId]) >= 0 ? condOut[a.assetId] : a.condition, conditionIn: '', status: Assets.OUT, note: '' };
        });
        Db.insertMany('LoanItems', items);
        resolved.lines.forEach(function (ln) {
          var a = assets[ln.assetId];
          if (a.trackingMode === 'individual') Db.update('Assets', a.assetId, { status: 'on_loan', quantityAvailable: 0, currentLoanId: loan.loanId, updatedAt: now });
          else Db.update('Assets', a.assetId, { quantityAvailable: a.quantityAvailable - ln.qty, updatedAt: now });
          Assets._event(a.assetId, loan.loanId, 'issue', -ln.qty, ctx.email, 'issued', 'iss:' + loan.loanId + ':' + a.assetId);
        });
        if (reservation) Db.update('Reservations', reservation.reservationId, { status: 'fulfilled' });
        if (requestId) Requests.fulfil(requestId, loan, ctx);
        Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'loan.issue', entityType: 'Loan', entityId: loan.loanId, detail: { borrowerType: type, borrowerId: borrowerId, items: resolved.lines.length, dueAt: dueAt, kitId: loan.kitId, reservationId: loan.reservationId } });
        // Commit only after every linked record is written; reconcile can recover any earlier failure.
        loan = Db.update('Loans', loan.loanId, { status: 'open' });
      } catch (err) {
        // Not transactional: undo what was written so the loan is never left half-issued.
        try { Assets.reconcile({ fix: true, failLoanIds: [loan.loanId] }); } catch (x) { Syslog.error('loans', 'ROLLBACK_FAILED', String(x && x.message), { loanId: loan.loanId }); }
        throw err;
      }
      try { Loans._notifyBorrower(loan, 'loan', 'Items issued', resolved.lines.length + ' item line(s) issued. Due ' + U.fmt(dueAt) + '.', 'loan-issued:' + loan.loanId); }
      catch (e) { Syslog.warn('loans', 'NOTIFY_FAILED', String(e && e.message), { loanId: loan.loanId }); }
      return { loan: Loans._view(loan, true), replayed: false };
    });
  },

  _notifyBorrower: function (loan, type, title, body, dedupe) {
    if (loan.borrowerType === 'student') Notify.toStudent(loan.borrowerId, type, title, body, dedupe);
    else Db.whereEq('GroupMembers', { groupId: loan.borrowerId }).forEach(function (m) { Notify.toStudent(m.studentId, type, title, body, dedupe ? dedupe + ':' + m.studentId : ''); });
  },

  /** Finish persisted return plans before any later stock mutation. Caller holds the script lock. */
  _recoverReturns: function () {
    var events = Db.readAll('AssetEvents'), done = {};
    events.forEach(function (e) { if (e.type === 'return-complete') done[e.idemKey] = true; });
    events.forEach(function (e) {
      if (e.type !== 'return-plan') return;
      if (done[e.idemKey.replace('ret-plan:', 'ret-done:')]) return;
      Loans._applyReturnPlan(JSON.parse(e.note));
    });
  },

  /** Absolute patches plus deduplicated ledger entries make replay safe after any intermediate write. */
  _applyReturnPlan: function (data) {
    data.lines.forEach(function (x) {
      Db.update('LoanItems', x.id, x.itemPatch);
      Db.update('Assets', x.assetId, x.assetPatch);
      x.events.forEach(function (ev) {
        if (!Db.getBy('AssetEvents', 'idemKey', ev.key)) Assets._event(x.assetId, data.loanId, ev.type, ev.delta, data.by, ev.note, ev.key);
      });
    });
    var after = Db.whereEq('LoanItems', { loanId: data.loanId }).filter(function (i) { return i.status !== 'voided'; });
    var allDone = after.every(function (i) { return i.status !== Assets.OUT; });
    var loan = Db.update('Loans', data.loanId, allDone ? { status: 'closed', returnedAt: data.at } : { status: 'partial' });
    Audit.log({ actor: data.by, role: data.role, action: 'loan.return', entityType: 'Loan', entityId: data.loanId, detail: { lines: data.lines.length, closed: allDone, problems: data.problems, requestKey: data.key } });
    Assets._event('', data.loanId, 'return-complete', 0, data.by, 'Return committed', 'ret-done:' + data.key + ':' + data.loanId);
    // Notification failure must not turn a committed return into a failed response.
    try {
      if (data.problems.length) Notify.toRole('admin', 'inventory', 'Damaged / missing items', Loans._borrowerName(loan) + ': ' + data.problems.join('; '), 'loan-problem:' + data.loanId + ':' + data.key);
      Loans._notifyBorrower(loan, 'loan', allDone ? 'Loan closed' : 'Partial return recorded', allDone ? 'All items on this loan have been returned or accounted for.' : 'Some items are still outstanding.', 'loan-return:' + data.loanId + ':' + data.key);
    } catch (e) { Syslog.warn('loans', 'NOTIFY_FAILED', String(e && e.message), { loanId: data.loanId }); }
    return loan;
  },

  /**
   * Bulk return. lines: [{ loanItemId, qtyReturned, qtyConsumed, qtyDamaged, qtyMissing, conditionIn, note }]
   * Omitted counts are 0; the sum may not exceed what is outstanding. Individually tracked items: exactly one of the four is 1.
   */
  returnItems: function (ctx, p) {
    V.obj(p);
    var key = Assets._idem(p.idemKey), loanId = V.id(p.loanId, 'Loan', 'loan');
    var lines = V.arr(p.lines, 'Lines', 80);
    if (!lines.length) fail('BAD_INPUT', 'Select at least one item to return.');
    return Locks.with(function () {
      Loans._recoverReturns();
      var loan = Db.mustGet('Loans', loanId, 'Loan');
      if (Db.getBy('AssetEvents', 'idemKey', 'ret-plan:' + key + ':' + loanId)) return { loan: Loans._view(loan, true), replayed: true };
      if (loan.status !== 'open' && loan.status !== 'partial') {
        if (Db.getBy('AssetEvents', 'idemKey', 'ret:' + key + ':' + lines[0].loanItemId)) return { loan: Loans._view(loan, true), replayed: true };
        fail('INVALID_STATE', 'This loan is ' + loan.status + ', not open.');
      }
      var items = U.indexBy(Db.whereEq('LoanItems', { loanId: loanId }), 'loanItemId'), now = U.now(), seen = {}, plan = [], replay = 0;
      lines.forEach(function (ln) {
        V.obj(ln);
        var id = V.id(ln.loanItemId, 'Loan item', 'loanItem'), it = items[id];
        if (!it) fail('BAD_INPUT', 'That item is not part of this loan.');
        if (seen[id]) fail('BAD_INPUT', 'An item appears twice.'); seen[id] = true;
        if (Db.getBy('AssetEvents', 'idemKey', 'ret:' + key + ':' + id)) { replay++; return; }
        var r = V.int(ln.qtyReturned === undefined ? 0 : ln.qtyReturned, 'Returned', 0, 100000), c = V.int(ln.qtyConsumed === undefined ? 0 : ln.qtyConsumed, 'Consumed', 0, 100000);
        var d = V.int(ln.qtyDamaged === undefined ? 0 : ln.qtyDamaged, 'Damaged', 0, 100000), m = V.int(ln.qtyMissing === undefined ? 0 : ln.qtyMissing, 'Missing', 0, 100000);
        var out = it.qtyIssued - it.qtyReturned - it.qtyConsumed - it.qtyDamaged - it.qtyMissing;
        if (it.status !== Assets.OUT || out <= 0) fail('INVALID_STATE', 'That item has already been fully returned.');
        if (r + c + d + m === 0) fail('BAD_INPUT', 'Enter a quantity for each selected item.');
        if (r + c + d + m > out) fail('BAD_INPUT', 'More units than are outstanding (' + out + ').');
        var asset = Db.mustGet('Assets', it.assetId, 'Asset');
        if (c > 0 && asset.trackingMode === 'individual') fail('BAD_INPUT', 'Individually tracked items cannot be consumed.');
        var cond = ln.conditionIn ? V.enumOf(ln.conditionIn, 'Condition', Cfg.CONDITIONS) : (d ? 'damaged' : it.conditionOut);
        if (d > 0) cond = 'damaged';
        plan.push({ it: it, asset: asset, r: r, c: c, d: d, m: m, cond: cond, note: V.str(ln.note, 'Note', { optional: true, max: 200 }), id: id });
      });
      if (!plan.length && replay) return { loan: Loans._view(loan, true), replayed: true };
      var problems = [];
      var journalLines = plan.map(function (x) {
        var it = x.it, a = x.asset;
        var done = it.qtyReturned + x.r + it.qtyConsumed + x.c + it.qtyDamaged + x.d + it.qtyMissing + x.m >= it.qtyIssued;
        var itemPatch = { qtyReturned: it.qtyReturned + x.r, qtyConsumed: it.qtyConsumed + x.c, qtyDamaged: it.qtyDamaged + x.d, qtyMissing: it.qtyMissing + x.m,
          conditionIn: x.cond, status: done ? 'closed' : Assets.OUT, note: x.note || it.note };
        var patch = { updatedAt: now };
        if (a.trackingMode === 'individual') {
          patch.currentLoanId = '';
          if (x.m) { patch.status = 'missing'; patch.quantityAvailable = 0; }
          else if (x.d || x.cond === 'damaged') { patch.status = 'damaged'; patch.quantityAvailable = 0; patch.condition = 'damaged'; }
          else { patch.status = 'available'; patch.quantityAvailable = 1; patch.condition = x.cond; }
        } else {
          patch.quantityAvailable = a.quantityAvailable + x.r;
          patch.quantityTotal = a.quantityTotal - x.c - x.d - x.m;
        }
        var base = 'ret:' + key + ':' + x.id;
        var events = [];
        function event(type, delta, note, suffix) { events.push({ type: type, delta: delta, note: note, key: base + (suffix || '') }); }
        if (x.r) event('return', x.r, 'returned (' + x.cond + ')' + (x.note ? ': ' + x.note : ''));
        if (x.c) event('consume', -x.c, 'consumed', ':c');
        if (x.d) event('damage', -x.d, 'damaged' + (x.note ? ': ' + x.note : ''), ':d');
        if (x.m) event('missing', -x.m, 'missing' + (x.note ? ': ' + x.note : ''), ':m');
        if (!x.r && (x.c || x.d || x.m)) event('return-marker', 0, 'return recorded');
        if (x.d || x.m) problems.push((a.name) + (x.d ? ' damaged x' + x.d : '') + (x.m ? ' missing x' + x.m : ''));
        return { id: it.loanItemId, assetId: a.assetId, itemPatch: itemPatch, assetPatch: patch, events: events };
      });
      var data = { key: key, loanId: loanId, by: ctx.email, role: ctx.roles[0], at: now, lines: journalLines, problems: problems };
      var journal = JSON.stringify(data);
      // Keep the recovery record comfortably within one spreadsheet cell, even with long per-item notes.
      if (journal.length > 40000) fail('BAD_INPUT', 'Too many items or notes for one return. Return fewer items at a time.');
      // Write intent before touching counts. A retry, reconciliation or the next stock mutation finishes it.
      Db.insert('AssetEvents', { txId: U.id('tx'), assetId: '', loanId: loanId, type: 'return-plan', qtyDelta: 0, at: now, by: ctx.email, note: journal, idemKey: 'ret-plan:' + key + ':' + loanId });
      loan = Loans._applyReturnPlan(data);
      return { loan: Loans._view(loan, true), replayed: false };
    });
  },

  /** Trigger: remind borrowers of overdue loans once per loan per day (dedupeKey) and send staff one digest per day. */
  sendOverdueReminders: function () {
    var now = U.now(), day = U.local(now).date, overdue = Db.where('Loans', function (l) { return Loans._isOverdue(l, now); });
    overdue.forEach(function (l) {
      var days = Math.max(1, Math.floor((now - l.dueAt) / 86400000));
      Loans._notifyBorrower(l, 'overdue', 'Overdue lab items', 'Your loan ' + l.loanId + ' was due ' + U.fmt(l.dueAt) + ' (' + days + ' day(s) overdue). Please return the items to the lab.', 'overdue:' + l.loanId + ':' + day);
    });
    if (overdue.length) Notify.toRole('staff', 'overdue', overdue.length + ' overdue loan(s)', overdue.slice(0, 8).map(function (l) { return Loans._borrowerName(l) + ' (due ' + U.fmt(l.dueAt) + ')'; }).join('; '), 'overdue-digest:' + day);
    return { overdue: overdue.length };
  }
};
