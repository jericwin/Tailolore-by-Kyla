const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const { form, EMAIL_RE } = require('../lib/validate');
const { ValidationError } = require('../lib/errors');
const { safeNext } = require('../lib/util');
const { notifyStudio } = require('../lib/notify');

const router = express.Router();

const LOGIN_LIMIT = { max: 8, windowMs: 15 * 60 * 1000 };

/**
 * One sign-in page for everyone; where it leads depends on the role.
 * A requested page is honoured only if that role may open it, so a customer is
 * never sent towards the studio and the studio never lands in a customer area.
 */
function landingFor(user, requested) {
  const home = user.role === 'admin' ? '/studio' : '/account';
  if (!requested) return home;
  const isStudio = requested === '/studio' || requested.startsWith('/studio/') || requested.startsWith('/studio?');
  const isAccount = requested === '/account' || requested.startsWith('/account/') || requested.startsWith('/account?');
  if (isStudio && user.role !== 'admin') return home;
  if (isAccount && user.role === 'admin') return home;
  return requested;
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(landingFor(req.user, safeNext(req.query.next, '')));
  res.render('auth/login.njk', { next: safeNext(req.query.next, ''), values: {}, errors: {} });
});

router.post('/login', async (req, res, next) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 254);
  const password = String(req.body.password || '');
  const dest = safeNext(req.body.next, '');
  const ipKey = `ip:${req.ip}`;
  const emailKey = `email:${email}`;
  const fail = (message, statusCode = 401) => res.status(statusCode).render('auth/login.njk', {
    next: dest, values: { email }, errors: {}, formError: message,
  });
  try {
    if (auth.rateLimited(ipKey, { ...LOGIN_LIMIT, max: 30 }) || auth.rateLimited(emailKey, LOGIN_LIMIT)) {
      return fail('Too many attempts. Please wait fifteen minutes and try again.', 429);
    }
    const user = email ? db.one('SELECT * FROM users WHERE email = ?', email) : null;
    const ok = user && !user.disabled ? await auth.verifyPassword(password, user.password_hash) : (await auth.burnPasswordCheck(password), false);
    if (!ok) {
      auth.recordAttempt(ipKey);
      auth.recordAttempt(emailKey);
      return fail('That email and password don’t match an account.');
    }
    auth.clearAttempts(emailKey);
    auth.createSession(res, user.id, req.get('user-agent'));
    res.redirect(landingFor(user, dest));
  } catch (err) { next(err); }
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect(landingFor(req.user, ''));
  res.render('auth/register.njk', { next: safeNext(req.query.next, ''), values: {}, errors: {} });
});

router.post('/register', async (req, res, next) => {
  const dest = safeNext(req.body.next, '');
  const v = form(req.body)
    .text('full_name', { required: true, max: 120, label: 'Your name' })
    .email('email')
    .phone('phone');
  const problem = auth.passwordProblem(req.body.password);
  if (problem) v.fail('password', problem);
  else if (req.body.password !== req.body.password_confirm) v.fail('password_confirm', 'The passwords don’t match.');
  try {
    if (auth.rateLimited(`register:${req.ip}`, { max: 10, windowMs: 60 * 60 * 1000 })) {
      v.fail('email', 'Too many sign-ups from this connection. Please try again later.');
    }
    const values = v.done();
    if (db.one('SELECT 1 FROM users WHERE email = ?', values.email)) {
      throw new ValidationError({ email: 'An account with this email already exists. Try signing in.' });
    }
    auth.recordAttempt(`register:${req.ip}`);
    const hash = await auth.hashPassword(req.body.password);
    // Registration always creates customers. Studio accounts are created only via `npm run create-admin`.
    const { lastInsertRowid } = db.run(
      "INSERT INTO users (email, password_hash, role, full_name, phone) VALUES (?, ?, 'customer', ?, ?)",
      values.email, hash, values.full_name, values.phone);
    auth.createSession(res, Number(lastInsertRowid), req.get('user-agent'));
    req.flash('ok', 'Welcome. Your account is ready.');
    res.redirect(dest || '/account');
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(422).render('auth/register.njk', {
        next: dest, values: { full_name: req.body.full_name, email: req.body.email, phone: req.body.phone }, errors: err.errors,
      });
    }
    next(err);
  }
});

// ——— Help signing in ———
// There is no email yet, so the request goes to the studio: Kyla checks it's really
// the customer and gives them a temporary password. The reply never reveals
// whether an account exists for the address.
router.get('/forgot-password', (req, res) => {
  if (req.user) return res.redirect(landingFor(req.user, ''));
  res.render('auth/forgot.njk', { values: { email: String(req.query.email || '').slice(0, 254) }, errors: {}, sent: false });
});

router.post('/forgot-password', (req, res) => {
  const values = {
    email: String(req.body.email || '').trim().toLowerCase().slice(0, 254),
    contact: String(req.body.contact || '').trim().slice(0, 300),
  };
  if (!EMAIL_RE.test(values.email)) {
    return res.status(422).render('auth/forgot.njk', { values, errors: { email: 'Enter the email address you signed up with.' }, sent: false });
  }
  const limited = auth.rateLimited(`help:${req.ip}`, { max: 5, windowMs: 60 * 60 * 1000 })
    || auth.rateLimited(`help:${values.email}`, { max: 3, windowMs: 24 * 60 * 60 * 1000 });
  if (!limited) {
    auth.recordAttempt(`help:${req.ip}`);
    auth.recordAttempt(`help:${values.email}`);
    const user = db.one("SELECT id, full_name FROM users WHERE email = ? AND role = 'customer' AND disabled = 0", values.email);
    if (user) {
      db.run('UPDATE users SET password_help_at = ?, password_help_note = ? WHERE id = ?', new Date().toISOString(), values.contact || null, user.id);
      notifyStudio({
        kind: 'password_help',
        title: `${user.full_name} needs help signing in`,
        body: values.contact ? `Reach them: ${values.contact}` : 'Contact them using the details on their account.',
        link: `/studio/customers/${user.id}`,
        dedupeKey: `password_help:${user.id}:${new Date().toISOString().slice(0, 10)}`,
      });
    }
  }
  res.render('auth/forgot.njk', { values: {}, errors: {}, sent: true });
});

router.post('/logout', (req, res) => {
  auth.destroySession(req, res);
  res.redirect('/');
});

module.exports = router;
module.exports.landingFor = landingFor;
