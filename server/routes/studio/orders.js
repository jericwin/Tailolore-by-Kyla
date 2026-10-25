// Purchase orders. Without an online payment gateway, payment is recorded by
// Kyla after she has verified it herself (bank transfer, e-wallet, cash).
const express = require('express');
const db = require('../../db');
const threads = require('../../models/threads');
const { ORDER, ORDER_FLOW, PAYMENT, canMove } = require('../../lib/status');
const { refreshGownAvailability } = require('../../lib/availability');
const { notify, recordStatus, history } = require('../../lib/notify');
const { form } = require('../../lib/validate');
const { HttpError } = require('../../lib/errors');

const router = express.Router();

const VIEWS = {
  open: { label: 'Open', where: "o.status IN ('pending', 'confirmed', 'processing', 'ready')" },
  pending: { label: 'To confirm', where: "o.status = 'pending'" },
  unpaid: { label: 'Awaiting payment', where: "o.status IN ('confirmed', 'processing', 'ready') AND o.payment_status <> 'verified'" },
  closed: { label: 'Closed', where: "o.status IN ('completed', 'cancelled')" },
  all: { label: 'All', where: '1 = 1' },
};

router.get('/', (req, res) => {
  const view = VIEWS[req.query.view] ? req.query.view : 'open';
  const q = String(req.query.q || '').trim().slice(0, 80);
  const params = [];
  let search = '';
  if (q) {
    search = 'AND (o.reference LIKE ? OR u.full_name LIKE ? OR u.email LIKE ? OR g.name LIKE ?)';
    params.push(...Array(4).fill(`%${q}%`));
  }
  res.render('studio/orders.njk', {
    section: 'orders', view, VIEWS, q,
    orders: db.all(
      `SELECT o.*, u.full_name AS customer, g.name AS gown_name FROM orders o
         JOIN users u ON u.id = o.customer_id JOIN gowns g ON g.id = o.gown_id
        WHERE ${VIEWS[view].where} ${search} ORDER BY o.created_at DESC LIMIT 300`, ...params),
    counts: Object.fromEntries(Object.entries(VIEWS).map(([k, v]) => [k, db.one(`SELECT COUNT(*) AS n FROM orders o WHERE ${v.where}`).n])),
  });
});

function load(id) {
  const o = db.one(
    `SELECT o.*, u.full_name AS customer, u.email AS customer_email, u.phone AS customer_phone,
            g.name AS gown_name, g.slug AS gown_slug, gu.label AS unit_label
       FROM orders o JOIN users u ON u.id = o.customer_id JOIN gowns g ON g.id = o.gown_id
       LEFT JOIN gown_units gu ON gu.id = o.unit_id WHERE o.id = ?`, Number(id) || 0);
  if (!o) throw new HttpError(404, 'Order not found.');
  return o;
}

router.get('/:id', (req, res) => {
  const order = load(req.params.id);
  db.run("UPDATE threads SET studio_unread = 0 WHERE customer_id = ? AND subject_type = 'order' AND subject_id = ?", order.customer_id, order.id);
  res.render('studio/order.njk', {
    section: 'orders', order,
    next: ORDER_FLOW[order.status] || [],
    units: db.all("SELECT * FROM gown_units WHERE gown_id = ? AND status = 'active' ORDER BY id", order.gown_id),
    history: history('order', order.id),
    thread: threads.forSubject(order.customer_id, 'order', order.id),
    PAYMENT,
  });
});

const CUSTOMER_TITLES = {
  confirmed: 'Order confirmed — payment details inside',
  processing: 'Your gown is being prepared',
  ready: 'Your gown is ready',
  completed: 'Order completed',
  cancelled: 'Order cancelled',
};

router.post('/:id/status', (req, res) => {
  const values = form(req.body).oneOf('to', Object.keys(ORDER), { label: 'Status' }).text('note', { max: 1000 }).id('unit_id').done();
  const to = values.to;
  const o = db.tx(() => {
    const order = load(req.params.id);
    if (!canMove(ORDER_FLOW, order.status, to)) throw new HttpError(409, `An order that is “${ORDER[order.status].label}” can’t be moved to “${ORDER[to].label}”.`);
    let unitId = order.unit_id;
    if (order.status === 'pending' && to === 'confirmed') {
      // Reserve a specific piece so it can't also be sold or rented to someone else.
      const candidates = db.all(
        `SELECT u.id FROM gown_units u WHERE u.gown_id = ? AND u.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM rentals r WHERE r.unit_id = u.id AND r.status IN ('awaiting_deposit','confirmed','picked_up'))
          ORDER BY u.id`, order.gown_id).map((r) => r.id);
      unitId = values.unit_id && candidates.includes(values.unit_id) ? values.unit_id : candidates[0];
      if (!unitId) throw new HttpError(409, 'Every piece of this gown is sold, reserved or has upcoming rentals. Resolve those first, or cancel this order.');
      db.run("UPDATE gown_units SET status = 'reserved_sale' WHERE id = ?", unitId);
    }
    if (to === 'completed') {
      if (order.payment_status !== 'verified') throw new HttpError(409, 'Verify the payment before completing the order.');
      if (unitId) db.run("UPDATE gown_units SET status = 'sold' WHERE id = ?", unitId);
    }
    if (to === 'cancelled' && unitId) db.run("UPDATE gown_units SET status = 'active' WHERE id = ? AND status = 'reserved_sale'", unitId);
    db.run('UPDATE orders SET status = ?, unit_id = ?, updated_at = ? WHERE id = ?',
      to, to === 'cancelled' ? null : unitId, new Date().toISOString(), order.id);
    recordStatus('order', order.id, order.status, to, req.user.id, values.note);
    refreshGownAvailability(order.gown_id);
    notify(order.customer_id, {
      kind: `order_${to}`, title: CUSTOMER_TITLES[to],
      body: values.note ? `${order.gown_name} — ${values.note}` : order.gown_name, link: `/account/orders/${order.id}`,
    });
    return order;
  });
  req.flash('ok', `${o.reference} → ${ORDER[to].label}.`);
  res.redirect(`/studio/orders/${o.id}`);
});

router.post('/:id/payment', (req, res) => {
  const values = form(req.body).oneOf('payment_status', Object.keys(PAYMENT), { label: 'Payment' }).text('payment_note', { max: 500 }).done();
  const o = load(req.params.id);
  if (o.status === 'pending') throw new HttpError(409, 'Confirm the order before recording payment.');
  db.tx(() => {
    db.run('UPDATE orders SET payment_status = ?, payment_note = ?, updated_at = ? WHERE id = ?',
      values.payment_status, values.payment_note, new Date().toISOString(), o.id);
    recordStatus('order', o.id, o.status, o.status, req.user.id, `Payment: ${PAYMENT[values.payment_status]}`);
    notify(o.customer_id, { kind: 'order_payment', title: PAYMENT[values.payment_status], body: o.gown_name, link: `/account/orders/${o.id}` });
  });
  req.flash('ok', 'Payment status updated.');
  res.redirect(`/studio/orders/${o.id}`);
});

router.post('/:id/note', (req, res) => {
  const o = load(req.params.id);
  db.run('UPDATE orders SET admin_note = ?, updated_at = ? WHERE id = ?', String(req.body.admin_note || '').trim().slice(0, 4000) || null, new Date().toISOString(), o.id);
  req.flash('ok', 'Private note saved.');
  res.redirect(`/studio/orders/${o.id}`);
});

router.post('/:id/message', (req, res) => {
  const o = load(req.params.id);
  const body = String(req.body.body || '').trim();
  if (!body || body.length > 4000) throw new HttpError(422, 'Please write a message (up to 4,000 characters).');
  threads.post(threads.getOrCreate(o.customer_id, 'order', o.id, `${o.gown_name} · ${o.reference}`), req.user, body);
  req.flash('ok', 'Message sent to the customer.');
  res.redirect(`/studio/orders/${o.id}#messages`);
});

module.exports = router;
