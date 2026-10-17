/**
 * AuthService.gs - who is calling, and what may they do.
 *
 * Identity comes ONLY from Session.getActiveUser().getEmail() on the server. Nothing the browser sends
 * (email, role, roll number, student id) is ever used to decide who the caller is.
 *
 * Two ways in, both decided on the server:
 *  - the hosted app (doPost): "Sign in with Google" gives the browser an ID token; signIn() checks it with Google
 *    (tokeninfo), then issues a LABFLOW session signed with SESSION_SECRET. Every later call carries that session,
 *    and resolve() trusts nothing else on this path - not even Session.getActiveUser().
 *  - the Apps Script page (google.script.run): Session.getActiveUser(). For a web app that executes as its owner
 *    this is "" unless the visitor is in the owner's Workspace domain (see docs/deployment.md).
 * There is deliberately no fallback that trusts a client-supplied email.
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
  resolve: function (session, apiCall) {
    var email = apiCall || session ? Auth.sessionEmail(session) : Auth.rawEmail();
    if (!email) {
      fail('NO_IDENTITY', 'Google did not share your identity with this app. Sign in with your @karunya.edu or @karunya.edu.in account. ' +
        'If you are signed in, the administrator must check that the web app is deployed for your domain (see README, Authentication).');
    }
    return Auth._contextForEmail(email);
  },

  /** Rebuild context for an already authenticated identity; fresh reads are used at scan commit time. */
  _contextForEmail: function (email, fresh) {
    var lookup = function (table, col, value) {
      return fresh ? Db.getBy(table, col, value) : Db.cachedGet(table, col, value, 120);
    };
    var domain = email.split('@')[1] || '';
    if (Auth.allowedDomains().indexOf(domain) < 0) {
      fail('DOMAIN_NOT_ALLOWED', 'Only ' + Auth.allowedDomains().map(function (d) { return '@' + d; }).join(' and ') + ' accounts can use LABFLOW.');
    }

    var ctx = { email: email, user: null, roles: [], student: null, faculty: null, kiosk: null };
    ctx.has = function (role) { return ctx.roles.indexOf(role) >= 0; };

    var kiosk = lookup('Kiosks', 'authorizedEmail', email);
    if (kiosk && kiosk.status === 'active') { ctx.kiosk = kiosk; ctx.roles.push('kiosk'); }

    var user = lookup('Users', 'email', email);
    if (!user) user = Auth._maybeBootstrapAdmin(email);
    if (user) {
      if (user.status !== 'active') fail('ACCOUNT_DISABLED', 'Your LABFLOW account is disabled. Contact the lab office.');
      ctx.user = user;
      String(user.roles || '').split(',').forEach(function (r) { r = r.trim(); if (Cfg.ROLES.indexOf(r) >= 0 && ctx.roles.indexOf(r) < 0) ctx.roles.push(r); });
      if (ctx.has('student')) ctx.student = lookup('StudentProfiles', 'userId', user.userId);
      if (ctx.has('faculty')) ctx.faculty = lookup('FacultyProfiles', 'userId', user.userId);
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

  SESSION_DAYS: 30,
  TOKENINFO_URL: 'https://oauth2.googleapis.com/tokeninfo?id_token=',

  _sessionSecret: function () {
    var props = PropertiesService.getScriptProperties(), s = props.getProperty(Cfg.PROP.SESSION);
    if (s) return s;
    return Locks.with(function () {
      var again = props.getProperty(Cfg.PROP.SESSION);
      if (again) return again;
      var fresh = Setup._newSecret();
      props.setProperty(Cfg.PROP.SESSION, fresh);
      return fresh;
    });
  },

  /** A session is "<b64u(JSON {e, x})>.<HMAC>". Returns the email, or fails with SESSION_EXPIRED / NO_IDENTITY. */
  sessionEmail: function (token) {
    if (typeof token !== 'string' || !token) fail('NO_IDENTITY', 'Please sign in.');
    var parts = token.split('.');
    if (parts.length !== 2 || parts[0].length > 400 || !U.safeEq(U.hmacB64u(Auth._sessionSecret(), parts[0]), parts[1])) fail('NO_IDENTITY', 'Your sign-in is not valid. Please sign in again.');
    var claims = null;
    try { claims = JSON.parse(Auth._ascii(U.b64uDecode(parts[0]))); } catch (e) { fail('NO_IDENTITY', 'Your sign-in is not valid. Please sign in again.'); }
    if (!claims || typeof claims.e !== 'string' || typeof claims.x !== 'number') fail('NO_IDENTITY', 'Your sign-in is not valid. Please sign in again.');
    if (claims.x <= U.now()) fail('SESSION_EXPIRED', 'Your sign-in has expired. Please sign in again.');
    return claims.e.toLowerCase();
  },

  _issueSession: function (email) {
    var exp = U.now() + Auth.SESSION_DAYS * 86400000;
    var body = U.b64uEncode(JSON.stringify({ e: email, x: exp }));
    return { session: body + '.' + U.hmacB64u(Auth._sessionSecret(), body), email: email, expiresAt: exp };
  },

  _ascii: function (bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s; },

  /**
   * Exchange a Google ID token for a LABFLOW session. The claims are pre-checked locally (shape, audience, issuer,
   * expiry) so junk never costs a UrlFetch; then Google's tokeninfo endpoint verifies the signature and we check the
   * claims it returns, which are the only ones trusted.
   */
  signIn: function (p) {
    var clientId = PropertiesService.getScriptProperties().getProperty(Cfg.PROP.GOOGLE_CLIENT_ID);
    if (!clientId) fail('NOT_CONFIGURED', 'Google sign-in is not set up on the server yet (run setupGoogleSignIn).');
    var idToken = p && p.idToken;
    if (typeof idToken !== 'string' || idToken.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idToken)) fail('BAD_INPUT', 'Sign-in failed. Please try again.');
    var pre = null;
    try { pre = JSON.parse(Auth._ascii(U.b64uDecode(idToken.split('.')[1]))); } catch (e) { pre = null; }
    if (!Auth._claimsOk(pre, clientId)) fail('BAD_INPUT', 'Sign-in failed. Please try again.');
    if (!Auth.rateLimit('signin|all', 120, 60)) fail('RATE_LIMITED', 'Too many sign-ins right now. Try again in a minute.');
    var res = UrlFetchApp.fetch(Auth.TOKENINFO_URL + encodeURIComponent(idToken), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) fail('NO_IDENTITY', 'Google could not confirm this sign-in. Please try again.');
    var claims = null;
    try { claims = JSON.parse(res.getContentText()); } catch (e) { claims = null; }
    if (!Auth._claimsOk(claims, clientId)) fail('NO_IDENTITY', 'Google could not confirm this sign-in. Please try again.');
    if (String(claims.email_verified) !== 'true') fail('NO_IDENTITY', 'Your Google account email is not verified.');
    var email = String(claims.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) fail('NO_IDENTITY', 'Google did not share an email address.');
    if (Auth.allowedDomains().indexOf(email.split('@')[1]) < 0) {
      fail('DOMAIN_NOT_ALLOWED', 'Only ' + Auth.allowedDomains().map(function (d) { return '@' + d; }).join(' and ') + ' accounts can use LABFLOW.');
    }
    if (!Auth.rateLimit('signin|' + email, 20, 600)) fail('RATE_LIMITED', 'Too many sign-ins. Try again in a few minutes.');
    Audit.tryLog({ actor: email, role: 'user', action: 'auth.signin', entityType: 'Session', entityId: email, result: 'ok', detail: { via: 'google' } });
    return Auth._issueSession(email);
  },

  _claimsOk: function (c, clientId) {
    if (!c || typeof c !== 'object') return false;
    if (c.aud !== clientId) return false;
    if (c.iss !== 'accounts.google.com' && c.iss !== 'https://accounts.google.com') return false;
    var exp = Number(c.exp);
    return isFinite(exp) && exp * 1000 > U.now();
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
