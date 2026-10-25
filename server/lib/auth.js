// Passwords, sessions, CSRF and role checks.
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const db = require('../db');
const config = require('../config');
const { HttpError } = require('./errors');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(key, expected);
}

// A hash used to equalise timing when the email doesn't exist.
let dummyHash;
async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword('timing-equaliser');
  await verifyPassword(password, dummyHash);
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 10) return 'Use at least 10 characters.';
  if (password.length > 200) return 'That password is too long.';
  return null;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

const SESSION_COOKIE = 'tbk_session';
const CSRF_COOKIE = 'tbk_csrf';

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    path: '/',
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

function createSession(res, userId, userAgent) {
  const token = randomToken();
  const expires = new Date(Date.now() + config.sessionDays * 864e5);
  db.run('INSERT INTO sessions (id_hash, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)',
    sha256(token), userId, expires.toISOString(), String(userAgent || '').slice(0, 200));
  res.cookie(SESSION_COOKIE, token, cookieOptions(config.sessionDays * 864e5));
  // Rotate the CSRF token whenever the privilege level changes.
  res.cookie(CSRF_COOKIE, randomToken(), cookieOptions());
}

function destroySession(req, res) {
  const token = req.cookies[SESSION_COOKIE];
  if (token) db.run('DELETE FROM sessions WHERE id_hash = ?', sha256(token));
  res.clearCookie(SESSION_COOKIE, cookieOptions());
  res.cookie(CSRF_COOKIE, randomToken(), cookieOptions());
}

function destroyOtherSessions(userId, req) {
  const current = req.cookies[SESSION_COOKIE];
  db.run('DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?', userId, current ? sha256(current) : '');
}

/** Loads req.user from the session cookie. The role always comes from the database row. */
function loadUser(req, res, next) {
  req.user = null;
  const token = req.cookies[SESSION_COOKIE];
  if (token) {
    const row = db.one(
      `SELECT u.id, u.email, u.role, u.full_name, u.phone, u.address, u.must_change_password, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash = ? AND u.disabled = 0`, sha256(token));
    if (row && row.expires_at > new Date().toISOString()) {
      req.user = { id: row.id, email: row.email, role: row.role, fullName: row.full_name, phone: row.phone, address: row.address, mustChangePassword: !!row.must_change_password };
    } else if (row) {
      db.run('DELETE FROM sessions WHERE id_hash = ?', sha256(token));
      res.clearCookie(SESSION_COOKIE, cookieOptions());
    }
  }
  res.locals.user = req.user;
  res.locals.isAdmin = req.user?.role === 'admin';
  next();
}

/**
 * Double-submit CSRF protection: an HttpOnly random cookie whose value must be
 * echoed in the form body (_csrf) or X-CSRF-Token header on every unsafe request.
 */
function csrf(req, res, next) {
  let token = req.cookies[CSRF_COOKIE];
  if (!token || token.length < 32) {
    token = randomToken();
    res.cookie(CSRF_COOKIE, token, cookieOptions());
  }
  res.locals.csrfToken = token;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // multipart bodies are parsed later by the upload middleware; check there via verifyCsrf.
  if (req.is('multipart/form-data')) return next();
  return verifyCsrf(req, res, next);
}

function verifyCsrf(req, res, next) {
  const expected = req.cookies[CSRF_COOKIE] || '';
  const sent = String((req.body && req.body._csrf) || req.get('x-csrf-token') || '');
  const a = Buffer.from(expected);
  const b = Buffer.from(sent);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(new HttpError(403, 'This form expired. Please go back, refresh the page and try again.'));
  }
  next();
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (req.accepts(['html', 'json']) === 'json' || req.get('x-requested-with') === 'fetch') {
    return next(new HttpError(401, 'Please sign in.'));
  }
  // After signing in, return to the page the form was on rather than to a POST-only URL.
  let back = req.originalUrl;
  if (req.method !== 'GET') {
    try {
      const ref = new URL(req.get('referer') || '', `${req.protocol}://${req.get('host')}`);
      back = ref.host === req.get('host') ? ref.pathname + ref.search : '/';
    } catch { back = '/'; }
  }
  res.redirect(`/login?next=${encodeURIComponent(back)}`);
}

function requireCustomer(req, res, next) {
  requireLogin(req, res, () => {
    if (req.user.role === 'admin') return res.redirect('/studio');
    next();
  });
}

/** Studio access. Enforced on the server for every /studio route; there is no client-side flag. */
function requireAdmin(req, res, next) {
  if (!req.user) return requireLogin(req, res, next);
  if (req.user.role !== 'admin') return next(new HttpError(404, 'Page not found.'));
  next();
}

/** Simple sliding-window limiter stored in SQLite so it survives restarts. */
function rateLimited(key, { max, windowMs }) {
  const now = Date.now();
  db.run('DELETE FROM login_attempts WHERE at < ?', now - windowMs);
  const { n } = db.one('SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND at >= ?', key, now - windowMs);
  return n >= max;
}
function recordAttempt(key) {
  db.run('INSERT INTO login_attempts (key, at) VALUES (?, ?)', key, Date.now());
}
function clearAttempts(key) {
  db.run('DELETE FROM login_attempts WHERE key = ?', key);
}

function purgeExpiredSessions() {
  db.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
}

module.exports = {
  hashPassword, verifyPassword, burnPasswordCheck, passwordProblem, randomToken, sha256,
  createSession, destroySession, destroyOtherSessions, loadUser, csrf, verifyCsrf,
  requireLogin, requireCustomer, requireAdmin, rateLimited, recordAttempt, clearAttempts, purgeExpiredSessions,
};
