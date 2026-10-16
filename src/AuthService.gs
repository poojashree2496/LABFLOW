/**
 * AuthService.gs - who is calling, and what may they do.
 *
 * Identity comes ONLY from Session.getActiveUser().getEmail() on the server. Nothing the browser sends
 * (email, role, roll number, student id) is ever used to decide who the caller is.
 *
 * PLATFORM CAVEAT (verified against Google's documentation, see README "Authentication"): for a web app that
 * executes as its owner, getActiveUser().getEmail() returns "" unless the visitor is in the owner's Google
 * Workspace domain. If Karunya's two domains are separate Workspace organisations, visitors from the other one
 * will be refused with NO_IDENTITY. There is deliberately no fallback that trusts a client-supplied identity.
 */
var Auth = {
  allowedDomains: function () {
    var raw = PropertiesService.getScriptProperties().getProperty(Cfg.PROP.DOMAINS);
    var list = raw ? raw.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean) : Cfg.DEFAULT_ALLOWED_DOMAINS;
    return list;
  },

  rawEmail: function () {
    try { return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) { return ''; }
  },

  /**
   * Resolve the caller. Returns a context object:
   *  { email, user|null, roles[], student|null, faculty|null, kiosk|null, has(role) }
   * user === null means "authenticated Google account from an allowed domain with no LABFLOW account yet"; such a
   * caller may only use the onboarding actions.
   */
  resolve: function () {
    var email = Auth.rawEmail();
    if (!email) {
      fail('NO_IDENTITY', 'Google did not share your identity with this app. Sign in with your @karunya.edu or @karunya.edu.in account. ' +
        'If you are signed in, the administrator must check that the web app is deployed for your domain (see README, Authentication).');
    }
    var domain = email.split('@')[1] || '';
    if (Auth.allowedDomains().indexOf(domain) < 0) {
      fail('DOMAIN_NOT_ALLOWED', 'Only ' + Auth.allowedDomains().map(function (d) { return '@' + d; }).join(' and ') + ' accounts can use LABFLOW.');
    }

    var ctx = { email: email, user: null, roles: [], student: null, faculty: null, kiosk: null };
    ctx.has = function (role) { return ctx.roles.indexOf(role) >= 0; };

    var kiosk = Db.cachedGet('Kiosks', 'authorizedEmail', email, 120);
    if (kiosk && kiosk.status === 'active') { ctx.kiosk = kiosk; ctx.roles.push('kiosk'); }

    var user = Db.cachedGet('Users', 'email', email, 120);
    if (!user) user = Auth._maybeBootstrapAdmin(email);
    if (user) {
      if (user.status !== 'active') fail('ACCOUNT_DISABLED', 'Your LABFLOW account is disabled. Contact the lab office.');
      ctx.user = user;
      String(user.roles || '').split(',').forEach(function (r) { r = r.trim(); if (Cfg.ROLES.indexOf(r) >= 0 && ctx.roles.indexOf(r) < 0) ctx.roles.push(r); });
      if (ctx.has('student')) ctx.student = Db.cachedGet('StudentProfiles', 'userId', user.userId, 120);
      if (ctx.has('faculty')) ctx.faculty = Db.cachedGet('FacultyProfiles', 'userId', user.userId, 120);
      Auth._touchLogin(user);
    }
    return ctx;
  },

  /** The deploying admin names one bootstrap admin (Setup.setBootstrapAdmin). It works only while no active admin exists. */
  _maybeBootstrapAdmin: function (email) {
    var boot = PropertiesService.getScriptProperties().getProperty(Cfg.PROP.BOOTSTRAP_ADMIN);
    if (!boot || boot !== email) return null;
    return Locks.with(function () {
      var admins = Db.where('Users', function (u) { return u.status === 'active' && String(u.roles).split(',').indexOf('admin') >= 0; });
      if (admins.length > 0) return null;
      var existing = Db.getBy('Users', 'email', email);
      var now = U.now(), user;
      if (existing) user = Db.update('Users', existing.userId, { roles: U.uniq(String(existing.roles || '').split(',').filter(Boolean).concat(['admin'])).join(','), status: 'active', updatedAt: now });
      else user = Db.insert('Users', { userId: U.id('user'), email: email, displayName: email.split('@')[0], roles: 'admin', status: 'active', createdAt: now, updatedAt: now });
      Audit.log({ actor: email, role: 'admin', action: 'bootstrap.admin', entityType: 'User', entityId: user.userId, detail: { note: 'first administrator created from BOOTSTRAP_ADMIN_EMAIL' } });
      return user;
    });
  },

  /** Record last login at most every 6 hours (avoids a sheet write on every call). */
  _touchLogin: function (user) {
    var now = U.now();
    if (user.lastLoginAt && now - user.lastLoginAt < 6 * 3600 * 1000) return;
    try { Db.update('Users', user.userId, { lastLoginAt: now }); } catch (e) { /* best effort */ }
  },

  /** Throw FORBIDDEN unless the caller holds one of the roles. Central check used by the RPC router. */
  requireRole: function (ctx, roles) {
    if (!roles.some(function (r) { return ctx.has(r); })) fail('FORBIDDEN', 'You do not have permission to do that.');
  },

  /** Is the faculty member assigned to this session (or an admin)? */
  ownsSession: function (ctx, session) {
    if (ctx.has('admin')) return true;
    return !!(ctx.faculty && session.facultyId === ctx.faculty.facultyId);
  },

  /**
   * May the caller run this session (open, close, call a rescan, see the live roster)? The owning faculty and admins
   * always; an event's coordinator during the event; a class representative for their own class on the day. Spot
   * checks, corrections and photos stay with the faculty owner.
   */
  canOperate: function (ctx, session) {
    if (Auth.ownsSession(ctx, session)) return true;
    if (Events.isCoordinator(ctx, session)) return true;
    return !!(ctx.student && session.date === U.local(U.now()).date && ClassReps.isRepFor(ctx.student.studentId, session));
  },
  operatorRole: function (ctx, session) {
    if (ctx.has('admin')) return 'admin';
    if (ctx.faculty && session.facultyId === ctx.faculty.facultyId) return 'faculty';
    if (Events.isCoordinator(ctx, session)) return 'coordinator';
    if (ctx.student && ClassReps.isRepFor(ctx.student.studentId, session)) return 'cr';
    return ctx.roles[0] || 'user';
  },

  /** Simple fixed-window rate limiter on CacheService (approximate under concurrency; see SECURITY.md). */
  rateLimit: function (key, max, windowSec) {
    var cache = CacheService.getScriptCache();
    var k = 'rl|' + key;
    var n = 0;
    try { n = parseInt(cache.get(k) || '0', 10); } catch (e) {}
    if (n >= max) return false;
    try { cache.put(k, String(n + 1), windowSec); } catch (e) {}
    return true;
  }
};
