// Kyla's studio. The whole router is mounted behind auth.requireAdmin in app.js.
const express = require('express');
const db = require('../../db');
const { today, addDays } = require('../../lib/dates');
const { safeNext } = require('../../lib/util');
const { HttpError } = require('../../lib/errors');

const router = express.Router();

router.use((req, res, next) => {
  res.locals.area = 'studio';
  res.locals.studioCounts = db.one(
    `SELECT
       (SELECT COUNT(*) FROM rentals WHERE status = 'requested') AS rentals,
       (SELECT COUNT(*) FROM orders WHERE status = 'pending') AS orders,
       (SELECT COUNT(*) FROM custom_requests WHERE status IN ('pending_review', 'awaiting_approval')) AS custom,
       (SELECT COALESCE(SUM(studio_unread > 0), 0) FROM threads) AS messages`);
  next();
});

router.get('/', (req, res) => {
  const t = today();
  const stats = db.one(
    `SELECT
       (SELECT COUNT(*) FROM gowns WHERE listing_status = 'published') AS published,
       (SELECT COUNT(*) FROM gowns WHERE listing_status = 'published' AND availability_status = 'available') AS available,
       (SELECT COUNT(*) FROM gowns WHERE listing_status = 'draft') AS drafts,
       (SELECT COUNT(*) FROM rentals WHERE status = 'requested') AS pending_rentals,
       (SELECT COUNT(*) FROM rentals WHERE status IN ('confirmed', 'awaiting_deposit') AND pickup_date >= ?) AS upcoming_rentals,
       (SELECT COUNT(*) FROM orders WHERE status = 'pending') AS pending_orders,
       (SELECT COUNT(*) FROM custom_requests WHERE status = 'pending_review') AS new_custom,
       (SELECT COUNT(*) FROM custom_requests WHERE status = 'awaiting_approval') AS custom_awaiting`, t);

  // A single list of what needs Kyla's attention, oldest first.
  const actions = [
    ...db.all(`SELECT 'rental' AS type, r.id, r.reference, r.status, r.created_at, r.event_date AS due, u.full_name AS customer, g.name AS subject
                 FROM rentals r JOIN users u ON u.id = r.customer_id JOIN gowns g ON g.id = r.gown_id
                WHERE r.status = 'requested'
                   OR (r.status = 'awaiting_deposit')
                   OR (r.status = 'confirmed' AND r.pickup_date <= ?)
                   OR (r.status = 'picked_up' AND r.return_date <= ?)
                   OR (r.status = 'returned')`, addDays(t, 2), t),
    ...db.all(`SELECT 'order' AS type, o.id, o.reference, o.status, o.created_at, NULL AS due, u.full_name AS customer, g.name AS subject
                 FROM orders o JOIN users u ON u.id = o.customer_id JOIN gowns g ON g.id = o.gown_id
                WHERE o.status IN ('pending', 'confirmed', 'processing', 'ready')`),
    ...db.all(`SELECT 'custom' AS type, c.id, c.reference, c.status, c.created_at, c.event_date AS due, c.contact_name AS customer, c.event_type AS subject
                 FROM custom_requests c WHERE c.status IN ('pending_review', 'awaiting_approval')`),
  ].sort((a, b) => a.created_at.localeCompare(b.created_at));

  const upcoming = db.all(
    `SELECT r.*, u.full_name AS customer, g.name AS gown_name, gu.label AS unit_label
       FROM rentals r JOIN users u ON u.id = r.customer_id JOIN gowns g ON g.id = r.gown_id
       LEFT JOIN gown_units gu ON gu.id = r.unit_id
      WHERE r.status IN ('awaiting_deposit', 'confirmed', 'picked_up') AND r.return_date >= ?
      ORDER BY r.pickup_date LIMIT 12`, t);

  res.render('studio/overview.njk', { section: 'overview', stats, actions, upcoming });
});

// Studio notifications
router.get('/notifications', (req, res) => {
  res.render('studio/notifications.njk', {
    section: 'notifications',
    notifications: db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 150', req.user.id),
  });
});
router.get('/notifications/:id', (req, res) => {
  const n = db.one('SELECT * FROM notifications WHERE id = ? AND user_id = ?', Number(req.params.id) || 0, req.user.id);
  if (!n) throw new HttpError(404, 'Notification not found.');
  db.run('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?', new Date().toISOString(), n.id);
  res.redirect(safeNext(n.link, '/studio/notifications'));
});
router.post('/notifications/read', (req, res) => {
  db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', new Date().toISOString(), req.user.id);
  res.redirect('/studio/notifications');
});

router.use('/gowns', require('./gowns'));
router.use('/rentals', require('./rentals'));
router.use('/orders', require('./orders'));
router.use('/custom', require('./custom'));
router.use('/messages', require('./messages'));
router.use(require('./library'));
router.use(require('./settings'));

module.exports = router;
