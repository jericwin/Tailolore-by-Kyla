// Categories, studio settings and customer directory.
const express = require('express');
const db = require('../../db');
const settings = require('../../lib/settings');
const auth = require('../../lib/auth');
const { form } = require('../../lib/validate');
const { uniqueSlug } = require('../../lib/util');
const { HttpError } = require('../../lib/errors');

const router = express.Router();
// Sections of the public collection; every category belongs to one.
const SECTIONS = { gowns: 'Women’s gowns', menswear: 'Menswear', costumes: 'Costumes', other: 'Other pieces' };

router.get('/categories', (req, res) => {
  res.render('studio/categories.njk', {
    section: 'categories',
    SECTIONS,
    categories: db.all(
      `SELECT c.*, (SELECT COUNT(*) FROM gowns g WHERE g.category_id = c.id) AS gown_count
         FROM categories c ORDER BY c.sort_order, c.name`),
  });
});

router.post('/categories', (req, res) => {
  const values = form(req.body).text('name', { required: true, max: 60, label: 'Name' }).int('sort_order', { min: 0, max: 999 })
    .oneOf('section', Object.keys(SECTIONS), { fallback: 'gowns' }).done();
  if (db.one('SELECT 1 FROM categories WHERE name = ?', values.name)) throw new HttpError(422, 'That category already exists.');
  db.run('INSERT INTO categories (name, slug, sort_order, section) VALUES (?, ?, ?, ?)', values.name, uniqueSlug(values.name, 'categories'), values.sort_order || 0, values.section);
  req.flash('ok', 'Category added.');
  res.redirect('/studio/categories');
});

router.post('/categories/:id', (req, res) => {
  const cat = db.one('SELECT * FROM categories WHERE id = ?', Number(req.params.id) || 0);
  if (!cat) throw new HttpError(404, 'Category not found.');
  if (req.body.action === 'delete') {
    db.run('DELETE FROM categories WHERE id = ?', cat.id); // gowns keep existing, uncategorised
    req.flash('ok', `“${cat.name}” removed. Its gowns are now uncategorised.`);
    return res.redirect('/studio/categories');
  }
  const values = form(req.body).text('name', { required: true, max: 60, label: 'Name' }).int('sort_order', { min: 0, max: 999 })
    .oneOf('section', Object.keys(SECTIONS), { fallback: cat.section }).done();
  if (db.one('SELECT 1 FROM categories WHERE name = ? AND id <> ?', values.name, cat.id)) throw new HttpError(422, 'Another category has that name.');
  db.run('UPDATE categories SET name = ?, slug = ?, sort_order = ?, section = ? WHERE id = ?',
    values.name, uniqueSlug(values.name, 'categories', cat.id), values.sort_order || 0, values.section, cat.id);
  req.flash('ok', 'Category saved.');
  res.redirect('/studio/categories');
});

const TEXT_FIELDS = {
  brand_name: 120, location: 200, facebook_url: 300, messenger_url: 300, instagram_url: 300, contact_email: 200,
  contact_phone: 60, studio_hours: 300, about_heading: 200, about_text: 4000, hero_line: 160,
  rental_terms: 6000, purchase_terms: 6000, custom_terms: 6000, payment_instructions: 3000,
};

router.get('/settings', (req, res) => {
  res.render('studio/settings.njk', { section: 'settings', values: settings.all(), errors: {} });
});

router.post('/settings', (req, res) => {
  const v = form(req.body);
  for (const [k, max] of Object.entries(TEXT_FIELDS)) v.text(k, { max });
  v.int('turnaround_days', { min: 0, max: 30, label: 'Turnaround' })
    .int('rental_cancel_days', { min: 0, max: 365, label: 'Cancellation window' })
    .int('booking_horizon_days', { min: 14, max: 730, label: 'Booking horizon' })
    .bool('deposit_before_confirm');
  for (const k of ['facebook_url', 'messenger_url', 'instagram_url']) {
    if (v.values[k] && !/^https:\/\/[^\s]+$/.test(v.values[k])) v.fail(k, 'Use a full https:// link.');
  }
  if (v.values.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.values.contact_email)) v.fail('contact_email', 'Enter a valid email.');
  if (!v.ok()) {
    return res.status(422).render('studio/settings.njk', { section: 'settings', values: { ...settings.all(), ...req.body }, errors: v.errors });
  }
  const values = v.values;
  if (!values.brand_name) values.brand_name = settings.DEFAULTS.brand_name;
  if (values.booking_horizon_days == null) values.booking_horizon_days = settings.DEFAULTS.booking_horizon_days;
  if (values.turnaround_days == null) values.turnaround_days = 0;
  settings.setMany(values);
  req.flash('ok', 'Settings saved.');
  res.redirect('/studio/settings');
});

router.get('/customers', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  res.render('studio/customers.njk', {
    section: 'customers', q,
    customers: db.all(
      `SELECT u.id, u.full_name, u.email, u.phone, u.created_at, u.disabled, u.password_help_at,
              (SELECT COUNT(*) FROM rentals WHERE customer_id = u.id) AS rentals,
              (SELECT COUNT(*) FROM orders WHERE customer_id = u.id) AS orders,
              (SELECT COUNT(*) FROM custom_requests WHERE customer_id = u.id) AS customs
         FROM users u WHERE u.role = 'customer' ${q ? 'AND (u.full_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)' : ''}
        ORDER BY u.created_at DESC LIMIT 500`, ...(q ? Array(3).fill(`%${q}%`) : [])),
  });
});

function loadCustomer(id) {
  const customer = db.one(`SELECT id, full_name, email, phone, address, created_at, disabled, password_help_at, password_help_note
                             FROM users WHERE id = ? AND role = 'customer'`, Number(id) || 0);
  if (!customer) throw new HttpError(404, 'Customer not found.');
  return customer;
}

router.get('/customers/:id', (req, res) => renderCustomer(res, loadCustomer(req.params.id)));

// Without email configured, a customer who forgets their password is helped by Kyla:
// a random one-time password is shown once on screen and every session is ended.
router.post('/customers/:id/reset-password', async (req, res, next) => {
  try {
    const customer = loadCustomer(req.params.id);
    const temp = auth.randomToken(9).replace(/[-_]/g, 'x');
    db.run(`UPDATE users SET password_hash = ?, must_change_password = 1, password_help_at = NULL, password_help_note = NULL, updated_at = ?
              WHERE id = ?`, await auth.hashPassword(temp), new Date().toISOString(), customer.id);
    db.run('DELETE FROM sessions WHERE user_id = ?', customer.id);
    res.set('Cache-Control', 'no-store');
    renderCustomer(res, customer, temp);
  } catch (err) { next(err); }
});

function renderCustomer(res, customer, tempPassword = null) {
  res.render('studio/customer.njk', {
    section: 'customers', customer, tempPassword,
    rentals: db.all('SELECT r.*, g.name AS gown_name FROM rentals r JOIN gowns g ON g.id = r.gown_id WHERE r.customer_id = ? ORDER BY r.created_at DESC', customer.id),
    orders: db.all('SELECT o.*, g.name AS gown_name FROM orders o JOIN gowns g ON g.id = o.gown_id WHERE o.customer_id = ? ORDER BY o.created_at DESC', customer.id),
    customs: db.all('SELECT * FROM custom_requests WHERE customer_id = ? ORDER BY created_at DESC', customer.id),
    threads: db.all('SELECT * FROM threads WHERE customer_id = ? ORDER BY last_message_at DESC', customer.id),
  });
}

router.post('/customers/:id/access', (req, res) => {
  const customer = db.one("SELECT id, disabled FROM users WHERE id = ? AND role = 'customer'", Number(req.params.id) || 0);
  if (!customer) throw new HttpError(404, 'Customer not found.');
  const disable = req.body.disabled === '1' ? 1 : 0;
  db.tx(() => {
    db.run('UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?', disable, new Date().toISOString(), customer.id);
    if (disable) db.run('DELETE FROM sessions WHERE user_id = ?', customer.id);
  });
  req.flash('ok', disable ? 'Account disabled and signed out.' : 'Account re-enabled.');
  res.redirect(`/studio/customers/${customer.id}`);
});

module.exports = router;
