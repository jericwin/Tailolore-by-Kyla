// In-app notifications and status history.
// This is the single place to hook transactional email in later: see README "Email".
const db = require('../db');

function notify(userId, { kind, title, body = null, link = null, dedupeKey = null }) {
  db.run(
    `INSERT INTO notifications (user_id, kind, title, body, link, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, dedupe_key) DO NOTHING`,
    userId, kind, title, body, link, dedupeKey);
}

function notifyStudio(payload) {
  for (const { id } of db.all("SELECT id FROM users WHERE role = 'admin' AND disabled = 0")) {
    notify(id, payload);
  }
}

function recordStatus(entityType, entityId, fromStatus, toStatus, actorId, note = null, visibleToCustomer = true) {
  db.run(
    `INSERT INTO status_events (entity_type, entity_id, from_status, to_status, actor_id, note, visible_to_customer)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    entityType, entityId, fromStatus, toStatus, actorId, note, visibleToCustomer ? 1 : 0);
}

function history(entityType, entityId, { customerView = false } = {}) {
  return db.all(
    `SELECT e.*, u.full_name AS actor_name, u.role AS actor_role
       FROM status_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.entity_type = ? AND e.entity_id = ? ${customerView ? 'AND e.visible_to_customer = 1' : ''}
      ORDER BY e.created_at, e.id`, entityType, entityId);
}

function unreadCount(userId) {
  return db.one('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', userId).n;
}

/**
 * Creates reminders for upcoming pickups and returns. Idempotent thanks to
 * dedupe keys, so it is safe to run on a timer.
 */
function sendDateReminders() {
  const { today, addDays, formatDate } = require('./dates');
  const t = today();
  const soon = addDays(t, 3);
  const pickups = db.all(
    `SELECT r.id, r.reference, r.customer_id, r.pickup_date, g.name AS gown_name
       FROM rentals r JOIN gowns g ON g.id = r.gown_id
      WHERE r.status IN ('confirmed', 'awaiting_deposit') AND r.pickup_date BETWEEN ? AND ?`, t, soon);
  for (const r of pickups) {
    const payload = {
      kind: 'rental_pickup_soon',
      title: `Pickup on ${formatDate(r.pickup_date)}`,
      body: `${r.gown_name} · ${r.reference}`,
      dedupeKey: `pickup-soon-${r.id}-${r.pickup_date}`,
    };
    notify(r.customer_id, { ...payload, link: `/account/rentals/${r.id}` });
    notifyStudio({ ...payload, link: `/studio/rentals/${r.id}` });
  }
  const returns = db.all(
    `SELECT r.id, r.reference, r.customer_id, r.return_date, g.name AS gown_name
       FROM rentals r JOIN gowns g ON g.id = r.gown_id
      WHERE r.status = 'picked_up' AND r.return_date BETWEEN ? AND ?`, t, addDays(t, 1));
  for (const r of returns) {
    const payload = {
      kind: 'rental_return_soon',
      title: `Return due ${formatDate(r.return_date)}`,
      body: `${r.gown_name} · ${r.reference}`,
      dedupeKey: `return-soon-${r.id}-${r.return_date}`,
    };
    notify(r.customer_id, { ...payload, link: `/account/rentals/${r.id}` });
    notifyStudio({ ...payload, link: `/studio/rentals/${r.id}` });
  }
}

module.exports = { notify, notifyStudio, recordStatus, history, unreadCount, sendDateReminders };
