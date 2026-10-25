// Customer area. Every query is scoped to req.user.id, so customers can only
// ever load their own rentals, orders, requests, messages and notifications.
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const gowns = require('../models/gowns');
const threads = require('../models/threads');
const settings = require('../lib/settings');
const status = require('../lib/status');
const { form } = require('../lib/validate');
const { history, notifyStudio, recordStatus } = require('../lib/notify');
const { daysUntil, today } = require('../lib/dates');
const { parseJson, safeNext } = require('../lib/util');
const { refreshGownAvailability } = require('../lib/availability');
const { HttpError, ValidationError } = require('../lib/errors');

const router = express.Router();
router.use(auth.requireCustomer);
router.use((req, res, next) => { res.locals.area = 'account'; next(); });
// Counts shown beside the account menu items.
router.use((req, res, next) => {
  res.locals.acctCounts = db.one(
    `SELECT
       (SELECT COUNT(*) FROM rentals WHERE customer_id = ? AND status IN ('requested', 'awaiting_deposit', 'confirmed', 'picked_up', 'returned')) AS rentals,
       (SELECT COUNT(*) FROM orders WHERE customer_id = ? AND status NOT IN ('completed', 'cancelled')) AS orders,
       (SELECT COUNT(*) FROM custom_requests WHERE customer_id = ? AND status NOT IN ('completed', 'cancelled')) AS custom,
       (SELECT COUNT(*) FROM threads WHERE customer_id = ? AND customer_unread > 0) AS messages,
       (SELECT COUNT(*) FROM wishlist WHERE user_id = ?) AS wishlist`, ...Array(5).fill(req.user.id));
  next();
});
// After signing in with a temporary password from the studio, choosing a new one comes first.
router.use((req, res, next) => {
  if (!req.user.mustChangePassword || req.path.startsWith('/settings')) return next();
  req.flash('error', 'You signed in with a temporary password. Please choose your own password to continue.');
  res.redirect('/account/settings#password');
});

const GOWN_THUMB = `(SELECT file_key FROM gown_images WHERE gown_id = g.id ORDER BY is_main DESC, sort_order, id LIMIT 1) AS thumb_key`;

function rentalCancellable(r) {
  if (r.status === 'requested') return true;
  if (!['awaiting_deposit', 'confirmed'].includes(r.status)) return false;
  const days = settings.get('rental_cancel_days');
  if (days === '' || days == null) return false;
  return daysUntil(r.pickup_date) >= Number(days);
}
const orderCancellable = (o) => o.status === 'pending' || (o.status === 'confirmed' && o.payment_status === 'unpaid');
const customCancellable = (c) => ['pending_review', 'quotation_sent'].includes(c.status);

router.get('/', (req, res) => {
  const uid = req.user.id;
  res.render('account/overview.njk', {
    section: 'overview',
    rentals: db.all(
      `SELECT r.*, g.name AS gown_name, g.slug AS gown_slug, ${GOWN_THUMB} FROM rentals r JOIN gowns g ON g.id = r.gown_id
        WHERE r.customer_id = ? AND r.status IN ('requested', 'awaiting_deposit', 'confirmed', 'picked_up') ORDER BY r.event_date LIMIT 4`, uid),
    orders: db.all(
      `SELECT o.*, g.name AS gown_name, ${GOWN_THUMB} FROM orders o JOIN gowns g ON g.id = o.gown_id
        WHERE o.customer_id = ? AND o.status NOT IN ('completed', 'cancelled') ORDER BY o.created_at DESC LIMIT 4`, uid),
    customs: db.all(
      `SELECT * FROM custom_requests WHERE customer_id = ? AND status NOT IN ('completed', 'cancelled') ORDER BY created_at DESC LIMIT 4`, uid),
    notifications: db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 6', uid),
    wishCount: db.one('SELECT COUNT(*) AS n FROM wishlist WHERE user_id = ?', uid).n,
    wishItems: db.all(
      `SELECT g.name, g.slug, ${GOWN_THUMB} FROM wishlist w JOIN gowns g ON g.id = w.gown_id
        WHERE w.user_id = ? AND g.listing_status = 'published' ORDER BY w.created_at DESC LIMIT 4`, uid),
  });
});

// ——— Rentals ———
router.get('/rentals', (req, res) => {
  res.render('account/rentals.njk', {
    section: 'rentals',
    rentals: db.all(
      `SELECT r.*, g.name AS gown_name, g.slug AS gown_slug, ${GOWN_THUMB} FROM rentals r JOIN gowns g ON g.id = r.gown_id
        WHERE r.customer_id = ? ORDER BY (r.status IN ('completed','rejected','cancelled')), r.event_date DESC`, req.user.id),
  });
});

function ownRental(req) {
  const r = db.one(
    `SELECT r.*, g.name AS gown_name, g.slug AS gown_slug, ${GOWN_THUMB} FROM rentals r JOIN gowns g ON g.id = r.gown_id
      WHERE r.id = ? AND r.customer_id = ?`, Number(req.params.id) || 0, req.user.id);
  if (!r) throw new HttpError(404, 'We couldn’t find that rental.');
  return r;
}

router.get('/rentals/:id', (req, res) => {
  const rental = ownRental(req);
  res.render('account/rental.njk', {
    section: 'rentals', rental,
    history: history('rental', rental.id, { customerView: true }),
    thread: threads.forSubject(req.user.id, 'rental', rental.id),
    cancellable: rentalCancellable(rental),
    cancelDays: settings.get('rental_cancel_days'),
  });
});

router.post('/rentals/:id/cancel', (req, res) => {
  const rental = ownRental(req);
  if (!rentalCancellable(rental)) throw new HttpError(409, 'This rental can no longer be cancelled online. Please message Kyla.');
  db.tx(() => {
    db.run("UPDATE rentals SET status = 'cancelled', updated_at = ? WHERE id = ?", new Date().toISOString(), rental.id);
    recordStatus('rental', rental.id, rental.status, 'cancelled', req.user.id, 'Cancelled by customer');
    refreshGownAvailability(rental.gown_id);
    notifyStudio({ kind: 'rental_cancelled', title: `Rental cancelled · ${rental.reference}`, body: `${req.user.fullName} · ${rental.gown_name}`, link: `/studio/rentals/${rental.id}` });
  });
  req.flash('ok', 'The rental was cancelled.');
  res.redirect(`/account/rentals/${rental.id}`);
});

// ——— Orders ———
router.get('/orders', (req, res) => {
  res.render('account/orders.njk', {
    section: 'orders',
    orders: db.all(
      `SELECT o.*, g.name AS gown_name, g.slug AS gown_slug, ${GOWN_THUMB} FROM orders o JOIN gowns g ON g.id = o.gown_id
        WHERE o.customer_id = ? ORDER BY (o.status IN ('completed','cancelled')), o.created_at DESC`, req.user.id),
  });
});

function ownOrder(req) {
  const o = db.one(
    `SELECT o.*, g.name AS gown_name, g.slug AS gown_slug, ${GOWN_THUMB} FROM orders o JOIN gowns g ON g.id = o.gown_id
      WHERE o.id = ? AND o.customer_id = ?`, Number(req.params.id) || 0, req.user.id);
  if (!o) throw new HttpError(404, 'We couldn’t find that order.');
  return o;
}

router.get('/orders/:id', (req, res) => {
  const order = ownOrder(req);
  res.render('account/order.njk', {
    section: 'orders', order,
    history: history('order', order.id, { customerView: true }),
    thread: threads.forSubject(req.user.id, 'order', order.id),
    cancellable: orderCancellable(order),
  });
});

router.post('/orders/:id/cancel', (req, res) => {
  const order = ownOrder(req);
  if (!orderCancellable(order)) throw new HttpError(409, 'This order can no longer be cancelled online. Please message Kyla.');
  db.tx(() => {
    db.run("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?", new Date().toISOString(), order.id);
    if (order.unit_id) db.run("UPDATE gown_units SET status = 'active' WHERE id = ? AND status = 'reserved_sale'", order.unit_id);
    recordStatus('order', order.id, order.status, 'cancelled', req.user.id, 'Cancelled by customer');
    refreshGownAvailability(order.gown_id);
    notifyStudio({ kind: 'order_cancelled', title: `Order cancelled · ${order.reference}`, body: `${req.user.fullName} · ${order.gown_name}`, link: `/studio/orders/${order.id}` });
  });
  req.flash('ok', 'The order was cancelled.');
  res.redirect(`/account/orders/${order.id}`);
});

// ——— Custom requests ———
router.get('/custom', (req, res) => {
  res.render('account/customs.njk', {
    section: 'custom',
    customs: db.all('SELECT * FROM custom_requests WHERE customer_id = ? ORDER BY (status IN (\'completed\',\'cancelled\')), created_at DESC', req.user.id),
  });
});

function ownCustom(req) {
  const c = db.one(
    `SELECT c.*, g.name AS based_on_name, g.slug AS based_on_slug FROM custom_requests c
       LEFT JOIN gowns g ON g.id = c.based_on_gown_id WHERE c.id = ? AND c.customer_id = ?`,
    Number(req.params.id) || 0, req.user.id);
  if (!c) throw new HttpError(404, 'We couldn’t find that request.');
  return c;
}

router.get('/custom/:id', (req, res) => {
  const custom = ownCustom(req);
  res.render('account/custom.njk', {
    section: 'custom', custom,
    measurements: parseJson(custom.measurements, {}),
    images: db.all('SELECT id FROM custom_request_images WHERE request_id = ? ORDER BY id', custom.id),
    quotations: db.all("SELECT * FROM quotations WHERE request_id = ? AND status <> 'withdrawn' ORDER BY created_at DESC", custom.id),
    history: history('custom', custom.id, { customerView: true }),
    thread: threads.forSubject(req.user.id, 'custom', custom.id),
    cancellable: customCancellable(custom),
  });
});

router.post('/custom/:id/cancel', (req, res) => {
  const custom = ownCustom(req);
  if (!customCancellable(custom)) throw new HttpError(409, 'This request can no longer be cancelled online. Please message Kyla.');
  db.tx(() => {
    db.run("UPDATE custom_requests SET status = 'cancelled', updated_at = ? WHERE id = ?", new Date().toISOString(), custom.id);
    db.run("UPDATE quotations SET status = 'withdrawn' WHERE request_id = ? AND status = 'sent'", custom.id);
    recordStatus('custom', custom.id, custom.status, 'cancelled', req.user.id, 'Cancelled by customer');
    notifyStudio({ kind: 'custom_cancelled', title: `Custom request cancelled · ${custom.reference}`, body: req.user.fullName, link: `/studio/custom/${custom.id}` });
  });
  req.flash('ok', 'Your request was cancelled.');
  res.redirect(`/account/custom/${custom.id}`);
});

router.post('/custom/:id/quotations/:qid/:decision(accept|decline)', (req, res) => {
  const custom = ownCustom(req);
  const q = db.one("SELECT * FROM quotations WHERE id = ? AND request_id = ? AND status = 'sent'", Number(req.params.qid) || 0, custom.id);
  if (!q || custom.status !== 'quotation_sent') throw new HttpError(409, 'This quotation is no longer open.');
  if (q.valid_until && q.valid_until < today()) throw new HttpError(409, 'This quotation has expired. Please message Kyla for an updated one.');
  const accept = req.params.decision === 'accept';
  const response = String(req.body.response || '').trim().slice(0, 2000) || null;
  const next = accept ? 'awaiting_approval' : 'pending_review';
  db.tx(() => {
    db.run('UPDATE quotations SET status = ?, customer_response = ?, responded_at = ? WHERE id = ?',
      accept ? 'accepted' : 'declined', response, new Date().toISOString(), q.id);
    db.run('UPDATE custom_requests SET status = ?, updated_at = ? WHERE id = ?', next, new Date().toISOString(), custom.id);
    recordStatus('custom', custom.id, custom.status, next, req.user.id, accept ? 'Quotation accepted' : 'Quotation declined');
    notifyStudio({
      kind: accept ? 'quote_accepted' : 'quote_declined',
      title: `Quotation ${accept ? 'accepted' : 'declined'} · ${custom.reference}`,
      body: response || req.user.fullName,
      link: `/studio/custom/${custom.id}`,
    });
  });
  req.flash('ok', accept
    ? 'Thank you. Kyla will confirm the agreement and the next steps before work begins.'
    : 'Quotation declined. You can message Kyla about changes.');
  res.redirect(`/account/custom/${custom.id}`);
});

// ——— Messages about a request ———
const SUBJECTS = {
  rentals: { type: 'rental', load: ownRental, label: (r) => `${r.gown_name} · ${r.reference}` },
  orders: { type: 'order', load: ownOrder, label: (o) => `${o.gown_name} · ${o.reference}` },
  custom: { type: 'custom', load: ownCustom, label: (c) => `Custom gown · ${c.reference}` },
};
router.post('/:kind(rentals|orders|custom)/:id/message', (req, res) => {
  const subject = SUBJECTS[req.params.kind];
  const record = subject.load(req);
  const body = String(req.body.body || '').trim();
  if (!body) throw new HttpError(422, 'Please write a message first.');
  if (body.length > 4000) throw new HttpError(422, 'Please keep messages under 4,000 characters.');
  const thread = threads.getOrCreate(req.user.id, subject.type, record.id, subject.label(record));
  threads.post(thread, req.user, body);
  req.flash('ok', 'Message sent.');
  res.redirect(`/account/${req.params.kind}/${record.id}#messages`);
});

// ——— Inbox ———
router.get('/messages', (req, res) => {
  res.render('account/messages.njk', {
    section: 'messages',
    threads: db.all(
      `SELECT t.*, (SELECT body FROM messages WHERE thread_id = t.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_body
         FROM threads t WHERE t.customer_id = ? ORDER BY t.last_message_at DESC`, req.user.id),
  });
});

router.post('/messages', (req, res) => {
  const body = String(req.body.body || '').trim();
  if (!body || body.length > 4000) throw new HttpError(422, 'Please write a message (up to 4,000 characters).');
  const thread = threads.getOrCreate(req.user.id, 'general', null, 'General enquiry');
  threads.post(thread, req.user, body);
  res.redirect(`/account/messages/${thread.id}`);
});

function ownThread(req) {
  const t = db.one('SELECT * FROM threads WHERE id = ? AND customer_id = ?', Number(req.params.id) || 0, req.user.id);
  if (!t) throw new HttpError(404, 'We couldn’t find that conversation.');
  return t;
}

const SUBJECT_LINKS = { rental: 'rentals', order: 'orders', custom: 'custom' };

router.get('/messages/:id', (req, res) => {
  const thread = ownThread(req);
  db.run('UPDATE threads SET customer_unread = 0 WHERE id = ?', thread.id);
  let subjectLink = null;
  if (SUBJECT_LINKS[thread.subject_type]) subjectLink = `/account/${SUBJECT_LINKS[thread.subject_type]}/${thread.subject_id}`;
  if (thread.subject_type === 'gown') {
    const g = db.one("SELECT slug FROM gowns WHERE id = ? AND listing_status = 'published'", thread.subject_id);
    if (g) subjectLink = `/gowns/${g.slug}`;
  }
  res.render('account/thread.njk', { section: 'messages', thread, subjectLink, messages: threads.messages(thread.id) });
});

router.post('/messages/:id', (req, res) => {
  const thread = ownThread(req);
  const body = String(req.body.body || '').trim();
  if (!body || body.length > 4000) throw new HttpError(422, 'Please write a message (up to 4,000 characters).');
  threads.post(thread, req.user, body);
  res.redirect(`/account/messages/${thread.id}#latest`);
});

// ——— Wishlist ———
router.get('/wishlist', (req, res) => {
  const ids = db.all('SELECT gown_id FROM wishlist WHERE user_id = ? ORDER BY created_at DESC', req.user.id).map((r) => r.gown_id);
  const list = ids.map((id) => gowns.byId(id)).filter((g) => g && g.listing_status === 'published');
  res.render('account/wishlist.njk', { section: 'wishlist', gowns: list });
});

// ——— Notifications ———
router.get('/notifications', (req, res) => {
  res.render('account/notifications.njk', {
    section: 'notifications',
    notifications: db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', req.user.id),
  });
});

router.get('/notifications/:id', (req, res) => {
  const n = db.one('SELECT * FROM notifications WHERE id = ? AND user_id = ?', Number(req.params.id) || 0, req.user.id);
  if (!n) throw new HttpError(404, 'Notification not found.');
  db.run('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?', new Date().toISOString(), n.id);
  res.redirect(safeNext(n.link, '/account/notifications'));
});

router.post('/notifications/read', (req, res) => {
  db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', new Date().toISOString(), req.user.id);
  res.redirect(safeNext(req.body.next, '/account/notifications'));
});

// ——— Settings ———
router.get('/settings', (req, res) => {
  const me = db.one('SELECT full_name, email, phone, address FROM users WHERE id = ?', req.user.id);
  res.render('account/settings.njk', { section: 'settings', values: me, errors: {}, pwErrors: {} });
});

router.post('/settings', async (req, res, next) => {
  try {
    const v = form(req.body)
      .text('full_name', { required: true, max: 120, label: 'Your name' })
      .email('email')
      .phone('phone')
      .text('address', { max: 600 });
    const values = v.done();
    const current = db.one('SELECT email, password_hash FROM users WHERE id = ?', req.user.id);
    if (values.email !== current.email) {
      if (!(await auth.verifyPassword(String(req.body.current_password || ''), current.password_hash))) {
        throw new ValidationError({ current_password: 'Enter your current password to change your email.' });
      }
      if (db.one('SELECT 1 FROM users WHERE email = ? AND id <> ?', values.email, req.user.id)) {
        throw new ValidationError({ email: 'Another account already uses this email.' });
      }
    }
    db.run('UPDATE users SET full_name = ?, email = ?, phone = ?, address = ?, updated_at = ? WHERE id = ?',
      values.full_name, values.email, values.phone, values.address, new Date().toISOString(), req.user.id);
    req.flash('ok', 'Your details were saved.');
    res.redirect('/account/settings');
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(422).render('account/settings.njk', { section: 'settings', values: req.body, errors: err.errors, pwErrors: {} });
    }
    next(err);
  }
});

router.post('/settings/password', async (req, res, next) => {
  try {
    const row = db.one('SELECT password_hash FROM users WHERE id = ?', req.user.id);
    const errors = {};
    if (!(await auth.verifyPassword(String(req.body.current_password || ''), row.password_hash))) errors.current_password = 'That isn’t your current password.';
    const problem = auth.passwordProblem(req.body.new_password);
    if (problem) errors.new_password = problem;
    else if (req.body.new_password !== req.body.new_password_confirm) errors.new_password_confirm = 'The passwords don’t match.';
    if (Object.keys(errors).length) throw new ValidationError(errors);
    db.run('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?', await auth.hashPassword(req.body.new_password), new Date().toISOString(), req.user.id);
    auth.destroyOtherSessions(req.user.id, req);
    req.flash('ok', 'Password changed. Other devices were signed out.');
    res.redirect('/account/settings');
  } catch (err) {
    if (err instanceof ValidationError) {
      const me = db.one('SELECT full_name, email, phone, address FROM users WHERE id = ?', req.user.id);
      return res.status(422).render('account/settings.njk', { section: 'settings', values: me, errors: {}, pwErrors: err.errors });
    }
    next(err);
  }
});

module.exports = router;
