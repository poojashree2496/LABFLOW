/**
 * NotificationService.gs - in-app notifications and batched, quota-aware email.
 *
 * - Every notification has an optional dedupeKey (unique column). Re-running a job or retrying a request can
 *   therefore never create a second copy, and never sends a second email.
 * - Emails are queued ('queued') and sent by Notify.flushEmails() from a time-driven trigger, grouped into ONE
 *   digest per recipient per run, and stop when the remaining daily quota drops below the configured reserve.
 *
 * SCOPE NOTE: GmailApp needs the broad https://mail.google.com/ OAuth scope (verified in Google's docs). The
 * narrower MailApp (script.send_mail) is available by setting the EMAIL_TRANSPORT script property to "mail".
 */
var Notify = {
  _create: function (userId, type, title, body, dedupeKey, email) {
    try {
      return Db.insert('Notifications', { notificationId: U.id('notification'), userId: userId, type: type, title: String(title).slice(0, 120), body: String(body).slice(0, 600),
        createdAt: U.now(), emailStatus: email && Settings.get('emailEnabled') ? 'queued' : 'none', dedupeKey: dedupeKey || '' });
    } catch (e) {
      if (e && e.code === 'DUPLICATE') return null; // already notified: idempotent
      Syslog.warn('notify', 'NOTIFY_FAILED', String(e && e.message));
      return null;
    }
  },
  toUser: function (userId, type, title, body, dedupeKey, opts) { return Notify._create(userId, type, title, body, dedupeKey, !opts || opts.email !== false); },
  toRole: function (role, type, title, body, dedupeKey) {
    Db.where('Users', function (u) { return u.status === 'active' && String(u.roles).split(',').indexOf(role) >= 0; })
      .forEach(function (u) { Notify._create(u.userId, type, title, body, dedupeKey ? dedupeKey + ':' + u.userId : '', true); });
  },
  toStudent: function (studentId, type, title, body, dedupeKey, opts) {
    var p = Db.get('StudentProfiles', studentId);
    if (p && p.userId) Notify.toUser(p.userId, type, title, body, dedupeKey, opts);
  },

  list: function (ctx) {
    if (!ctx.user) return { notifications: [], unread: 0 };
    var rows = Db.tail('Notifications', 400).filter(function (n) { return n.userId === ctx.user.userId; }).reverse().slice(0, 50);
    return { notifications: rows.map(function (n) { return { notificationId: n.notificationId, type: n.type, title: n.title, body: n.body, createdAt: n.createdAt, read: !!n.readAt }; }),
             unread: rows.filter(function (n) { return !n.readAt; }).length };
  },
  markRead: function (ctx, p) {
    V.obj(p);
    var ids = V.arr(p.ids || [], 'Ids', 100);
    var mine = Db.tail('Notifications', 400).filter(function (n) { return n.userId === ctx.user.userId && !n.readAt && (ids.length === 0 || ids.indexOf(n.notificationId) >= 0); });
    mine.forEach(function (n) { Db.update('Notifications', n.notificationId, { readAt: U.now() }); });
    return { marked: mine.length };
  },

  /** Low-level send honouring the transport setting. Throws on failure. */
  _send: function (to, subject, body, opts) {
    var transport = PropertiesService.getScriptProperties().getProperty(Cfg.PROP.EMAIL_TRANSPORT) || 'gmail';
    var o = Object.assign({ name: 'LABFLOW', noReply: true }, opts || {});
    if (transport === 'mail') MailApp.sendEmail(Object.assign({ to: to, subject: subject, body: body }, o));
    else GmailApp.sendEmail(to, subject, body, o);
  },
  quotaOk: function () { return MailApp.getRemainingDailyQuota() > Settings.get('emailDailyReserve'); },

  /** Send an email now (used by scheduled reports and audit anchors). Returns true if sent. */
  sendNow: function (to, subject, body, opts) {
    if (!Settings.get('emailEnabled')) return false;
    if (!Notify.quotaOk()) { Syslog.warn('notify', 'MAIL_QUOTA', 'Skipped email "' + subject + '": daily quota reserve reached'); return false; }
    try { Notify._send(to, '[LABFLOW] ' + subject, body, opts); return true; }
    catch (e) { Syslog.error('notify', 'MAIL_FAILED', String(e && e.message), { to: to, subject: subject }); return false; }
  },

  /** Trigger entry: send queued notifications as one digest per user. Idempotent and bounded. */
  flushEmails: function (deadlineMs) {
    if (!Settings.get('emailEnabled')) return { sent: 0, skipped: 'email disabled' };
    var queued = Db.tail('Notifications', 1000).filter(function (n) { return n.emailStatus === 'queued'; });
    if (!queued.length) return { sent: 0, queued: 0 };
    var users = U.indexBy(Db.readAll('Users'), 'userId');
    var byUser = U.groupBy(queued, function (n) { return n.userId; });
    var sent = 0, failed = 0, deferred = 0;
    Object.keys(byUser).forEach(function (uid) {
      if (deadlineMs && U.now() > deadlineMs) { deferred += byUser[uid].length; return; }
      var u = users[uid], items = byUser[uid];
      if (!u || u.status !== 'active') { items.forEach(function (n) { Db.update('Notifications', n.notificationId, { emailStatus: 'skipped' }); }); return; }
      if (!Notify.quotaOk()) { deferred += items.length; return; }
      var subject = items.length === 1 ? items[0].title : items.length + ' updates from LABFLOW';
      var body = 'Hello ' + u.displayName + ',\n\n' + items.map(function (n) { return '- ' + n.title + '\n  ' + n.body; }).join('\n\n') + '\n\nOpen LABFLOW for details.\n';
      try {
        Notify._send(u.email, '[LABFLOW] ' + subject, body);
        items.forEach(function (n) { Db.update('Notifications', n.notificationId, { emailStatus: 'sent' }); });
        sent++;
      } catch (e) {
        failed++;
        items.forEach(function (n) { Db.update('Notifications', n.notificationId, { emailStatus: 'failed' }); });
        Syslog.error('notify', 'MAIL_FAILED', String(e && e.message), { userId: uid });
      }
    });
    return { sent: sent, failed: failed, deferred: deferred, queued: queued.length };
  }
};
