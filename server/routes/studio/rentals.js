// Rental requests and bookings.
const express = require('express');
const db = require('../../db');
const threads = require('../../models/threads');
const settings = require('../../lib/settings');
const { RENTAL, RENTAL_FLOW, DEPOSIT, canMove } = require('../../lib/status');
const { findFreeUnit, refreshGownAvailability } = require('../../lib/availability');
const { notify, recordStatus, history } = require('../../lib/notify');
const { form } = require('../../lib/validate');
const { formatDate, today } = require('../../lib/dates');
const { HttpError } = require('../../lib/errors');

const router = express.Router();

const VIEWS = {
  pending: { label: 'To review', where: "r.status = 'requested'" },
  upcoming: { label: 'Upcoming', where: "r.status IN ('awaiting_deposit', 'confirmed')" },
  out: { label: 'With customers', where: "r.status = 'picked_up'" },
  returned: { label: 'To check in', where: "r.status = 'returned'" },
  closed: { label: 'Closed', where: "r.status IN ('completed', 'rejected', 'cancelled')" },
  all: { label: 'All', where: '1 = 1' },
};

router.get('/', (req, res) => {
  const view = VIEWS[req.query.view] ? req.query.view : 'pending';
  const q = String(req.query.q || '').trim().slice(0, 80);
  const params = [];
  let search = '';
  if (q) {
    search = 'AND (r.reference LIKE ? OR u.full_name LIKE ? OR u.email LIKE ? OR g.name LIKE ?)';
    params.push(...Array(4).fill(`%${q}%`));
  }
  const order = view === 'closed' || view === 'all' ? 'r.updated_at DESC' : 'r.pickup_date, r.created_at';
  res.render('studio/rentals.njk', {
    section: 'rentals', view, VIEWS, q,
    rentals: db.all(
      `SELECT r.*, u.full_name AS customer, g.name AS gown_name, gu.label AS unit_label
         FROM rentals r JOIN users u ON u.id = r.customer_id JOIN gowns g ON g.id = r.gown_id
         LEFT JOIN gown_units gu ON gu.id = r.unit_id
        WHERE ${VIEWS[view].where} ${search} ORDER BY ${order} LIMIT 300`, ...params),
    counts: Object.fromEntries(Object.entries(VIEWS).map(([k, v]) => [k,
      db.one(`SELECT COUNT(*) AS n FROM rentals r WHERE ${v.where}`).n])),
  });
});

function load(id) {
  const r = db.one(
    `SELECT r.*, u.full_name AS customer, u.email AS customer_email, u.phone AS customer_phone,
            g.name AS gown_name, g.slug AS gown_slug, gu.label AS unit_label
       FROM rentals r JOIN users u ON u.id = r.customer_id JOIN gowns g ON g.id = r.gown_id
       LEFT JOIN gown_units gu ON gu.id = r.unit_id WHERE r.id = ?`, Number(id) || 0);
  if (!r) throw new HttpError(404, 'Rental not found.');
  return r;
}

router.get('/:id', (req, res) => {
  const rental = load(req.params.id);
  // Other requests for the same gown whose dates overlap this one — useful when choosing whom to approve.
  const overlapping = db.all(
    `SELECT r.id, r.reference, r.status, r.pickup_date, r.return_date, u.full_name AS customer
       FROM rentals r JOIN users u ON u.id = r.customer_id
      WHERE r.gown_id = ? AND r.id <> ? AND r.status IN ('requested','awaiting_deposit','confirmed','picked_up')
        AND r.pickup_date <= ? AND r.return_date >= ?`, rental.gown_id, rental.id, rental.return_date, rental.pickup_date);
  const units = db.all("SELECT * FROM gown_units WHERE gown_id = ? AND status = 'active' ORDER BY id", rental.gown_id);
  const free = rental.status === 'requested' ? findFreeUnit(rental.gown_id, rental.pickup_date, rental.return_date) : null;
  if (threads.forSubject(rental.customer_id, 'rental', rental.id)) {
    db.run("UPDATE threads SET studio_unread = 0 WHERE customer_id = ? AND subject_type = 'rental' AND subject_id = ?", rental.customer_id, rental.id);
  }
  res.render('studio/rental.njk', {
    section: 'rentals', rental, overlapping, units, freeUnitId: free,
    next: RENTAL_FLOW[rental.status] || [],
    history: history('rental', rental.id),
    thread: threads.forSubject(rental.customer_id, 'rental', rental.id),
    depositFirst: settings.get('deposit_before_confirm') === '1' && rental.quoted_deposit,
    DEPOSIT, today: today(),
  });
});

const CUSTOMER_MESSAGES = {
  awaiting_deposit: (r) => ['Rental approved — deposit due', `${r.gown_name}. Your dates are held. The booking is confirmed once the deposit is received.`],
  confirmed: (r) => ['Rental confirmed', `${r.gown_name} · pickup ${formatDate(r.pickup_date)}`],
  rejected: (r) => ['Rental request declined', r.gown_name],
  cancelled: (r) => ['Rental cancelled', r.gown_name],
  picked_up: (r) => ['Gown picked up', `${r.gown_name} · return by ${formatDate(r.return_date)}`],
  returned: (r) => ['Return received', r.gown_name],
  completed: (r) => ['Rental completed', r.gown_name],
};

router.post('/:id/status', (req, res) => {
  const v = form(req.body)
    .oneOf('to', Object.keys(RENTAL), { label: 'Status' })
    .text('note', { max: 1000 })
    .id('unit_id');
  const values = v.done();
  const to = values.to;
  const result = db.tx(() => {
    const r = load(req.params.id); // re-read inside the transaction
    if (!canMove(RENTAL_FLOW, r.status, to)) throw new HttpError(409, `A ${RENTAL[r.status].label.toLowerCase()} rental can’t be moved to “${RENTAL[to].label}”.`);
    const now = new Date().toISOString();
    let unitId = r.unit_id;

    if (r.status === 'requested' && ['awaiting_deposit', 'confirmed'].includes(to)) {
      // Approval: assign a free piece, re-checking every other approved booking.
      unitId = findFreeUnit(r.gown_id, r.pickup_date, r.return_date, { excludeRentalId: r.id, preferUnitId: values.unit_id });
      if (!unitId) throw new HttpError(409, 'No piece of this gown is free for these dates any more — another booking or a blocked date overlaps.');
      if (values.unit_id && values.unit_id !== unitId) throw new HttpError(409, 'That piece is not free for these dates. Choose another piece.');
      if (to === 'confirmed' && settings.get('deposit_before_confirm') === '1' && r.quoted_deposit && r.deposit_status !== 'received') {
        throw new HttpError(409, 'This gown has a deposit. Approve the request first, then record the deposit to confirm it.');
      }
    }
    if (r.status === 'awaiting_deposit' && to === 'confirmed' && r.deposit_status !== 'received' && r.quoted_deposit) {
      throw new HttpError(409, 'Record the deposit as received before confirming.');
    }
    if (to === 'rejected' && !values.note) {
      // A reason is kept so the customer understands; Kyla can write a short one.
      throw new HttpError(422, 'Please add a short note for the customer explaining why.');
    }

    db.run(
      `UPDATE rentals SET status = ?, unit_id = ?, updated_at = ?,
              actual_pickup_at = CASE WHEN ? = 'picked_up' THEN ? ELSE actual_pickup_at END,
              actual_return_at = CASE WHEN ? = 'returned' THEN ? ELSE actual_return_at END,
              decision_reason = CASE WHEN ? IN ('rejected', 'cancelled') THEN ? ELSE decision_reason END
        WHERE id = ?`,
      to, ['rejected', 'cancelled'].includes(to) && r.status === 'requested' ? null : unitId, now, to, now, to, now, to, values.note, r.id);
    recordStatus('rental', r.id, r.status, to, req.user.id, values.note);
    refreshGownAvailability(r.gown_id);
    const [title, body] = CUSTOMER_MESSAGES[to](r);
    notify(r.customer_id, { kind: `rental_${to}`, title, body: values.note ? `${body} — ${values.note}` : body, link: `/account/rentals/${r.id}` });
    return r;
  });
  req.flash('ok', `${result.reference} → ${RENTAL[to].label}.`);
  res.redirect(`/studio/rentals/${result.id}`);
});

router.post('/:id/deposit', (req, res) => {
  const values = form(req.body).oneOf('deposit_status', Object.keys(DEPOSIT), { label: 'Deposit' }).text('note', { max: 500 }).done();
  const r = load(req.params.id);
  db.tx(() => {
    db.run('UPDATE rentals SET deposit_status = ?, updated_at = ? WHERE id = ?', values.deposit_status, new Date().toISOString(), r.id);
    recordStatus('rental', r.id, r.status, r.status, req.user.id, `Deposit: ${DEPOSIT[values.deposit_status]}${values.note ? ` — ${values.note}` : ''}`);
    // Recording the deposit on an approved booking completes the confirmation.
    if (values.deposit_status === 'received' && r.status === 'awaiting_deposit') {
      db.run("UPDATE rentals SET status = 'confirmed', updated_at = ? WHERE id = ?", new Date().toISOString(), r.id);
      recordStatus('rental', r.id, 'awaiting_deposit', 'confirmed', req.user.id, 'Deposit received');
      notify(r.customer_id, { kind: 'rental_confirmed', title: 'Rental confirmed', body: `${r.gown_name} · deposit received · pickup ${formatDate(r.pickup_date)}`, link: `/account/rentals/${r.id}` });
    } else {
      notify(r.customer_id, { kind: 'rental_deposit', title: `Deposit: ${DEPOSIT[values.deposit_status]}`, body: r.gown_name, link: `/account/rentals/${r.id}` });
    }
  });
  req.flash('ok', 'Deposit updated.');
  res.redirect(`/studio/rentals/${r.id}`);
});

router.post('/:id/return', (req, res) => {
  const values = form(req.body)
    .oneOf('return_condition', ['good', 'needs_cleaning', 'damaged'], { label: 'Condition' })
    .text('damage_notes', { max: 2000 })
    .done();
  if (values.return_condition === 'damaged' && !values.damage_notes) throw new HttpError(422, 'Describe the damage so there is a record of it.');
  const r = load(req.params.id);
  if (!['picked_up', 'returned', 'completed'].includes(r.status)) throw new HttpError(409, 'The gown hasn’t been picked up yet.');
  db.tx(() => {
    db.run('UPDATE rentals SET return_condition = ?, damage_notes = ?, updated_at = ? WHERE id = ?',
      values.return_condition, values.damage_notes, new Date().toISOString(), r.id);
    if (r.status === 'picked_up') {
      db.run("UPDATE rentals SET status = 'returned', actual_return_at = ? WHERE id = ?", new Date().toISOString(), r.id);
      recordStatus('rental', r.id, 'picked_up', 'returned', req.user.id, `Condition: ${values.return_condition.replace('_', ' ')}`);
      refreshGownAvailability(r.gown_id);
      notify(r.customer_id, { kind: 'rental_returned', title: 'Return received', body: r.gown_name, link: `/account/rentals/${r.id}` });
    } else {
      recordStatus('rental', r.id, r.status, r.status, req.user.id, `Return condition updated: ${values.return_condition.replace('_', ' ')}`, false);
    }
  });
  req.flash('ok', 'Return recorded.');
  res.redirect(`/studio/rentals/${r.id}`);
});

router.post('/:id/note', (req, res) => {
  const r = load(req.params.id);
  const note = String(req.body.admin_note || '').trim().slice(0, 4000) || null;
  db.run('UPDATE rentals SET admin_note = ?, updated_at = ? WHERE id = ?', note, new Date().toISOString(), r.id);
  req.flash('ok', 'Private note saved.');
  res.redirect(`/studio/rentals/${r.id}`);
});

router.post('/:id/message', (req, res) => {
  const r = load(req.params.id);
  const body = String(req.body.body || '').trim();
  if (!body || body.length > 4000) throw new HttpError(422, 'Please write a message (up to 4,000 characters).');
  const thread = threads.getOrCreate(r.customer_id, 'rental', r.id, `${r.gown_name} · ${r.reference}`);
  threads.post(thread, req.user, body);
  req.flash('ok', 'Message sent to the customer.');
  res.redirect(`/studio/rentals/${r.id}#messages`);
});

module.exports = router;
