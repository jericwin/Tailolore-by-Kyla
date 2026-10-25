// Custom gown requests, quotations and the agreed brief.
const express = require('express');
const db = require('../../db');
const threads = require('../../models/threads');
const { CUSTOM, CUSTOM_FLOW, canMove } = require('../../lib/status');
const { notify, recordStatus, history } = require('../../lib/notify');
const { form } = require('../../lib/validate');
const { parseJson, money } = require('../../lib/util');
const { HttpError } = require('../../lib/errors');

const router = express.Router();

const VIEWS = {
  new: { label: 'To review', where: "c.status = 'pending_review'" },
  quoted: { label: 'Quoted', where: "c.status IN ('quotation_sent', 'awaiting_approval')" },
  active: { label: 'In work', where: "c.status IN ('approved', 'in_progress', 'ready_for_fitting')" },
  closed: { label: 'Closed', where: "c.status IN ('completed', 'cancelled')" },
  all: { label: 'All', where: '1 = 1' },
};

router.get('/', (req, res) => {
  const view = VIEWS[req.query.view] ? req.query.view : 'new';
  res.render('studio/customs.njk', {
    section: 'custom', view, VIEWS,
    customs: db.all(`SELECT c.* FROM custom_requests c WHERE ${VIEWS[view].where} ORDER BY COALESCE(c.event_date, '9999'), c.created_at LIMIT 300`),
    counts: Object.fromEntries(Object.entries(VIEWS).map(([k, v]) => [k, db.one(`SELECT COUNT(*) AS n FROM custom_requests c WHERE ${v.where}`).n])),
  });
});

function load(id) {
  const c = db.one(
    `SELECT c.*, u.email AS account_email, g.name AS based_on_name, g.slug AS based_on_slug
       FROM custom_requests c JOIN users u ON u.id = c.customer_id LEFT JOIN gowns g ON g.id = c.based_on_gown_id
      WHERE c.id = ?`, Number(id) || 0);
  if (!c) throw new HttpError(404, 'Request not found.');
  return c;
}

router.get('/:id', (req, res) => {
  const custom = load(req.params.id);
  db.run("UPDATE threads SET studio_unread = 0 WHERE customer_id = ? AND subject_type = 'custom' AND subject_id = ?", custom.customer_id, custom.id);
  res.render('studio/custom.njk', {
    section: 'custom', custom,
    measurements: parseJson(custom.measurements, {}),
    images: db.all('SELECT id FROM custom_request_images WHERE request_id = ? ORDER BY id', custom.id),
    quotations: db.all('SELECT * FROM quotations WHERE request_id = ? ORDER BY created_at DESC', custom.id),
    next: CUSTOM_FLOW[custom.status] || [],
    history: history('custom', custom.id),
    thread: threads.forSubject(custom.customer_id, 'custom', custom.id),
  });
});

router.post('/:id/quotations', (req, res) => {
  const values = form(req.body)
    .money('amount', { required: true, label: 'Amount' })
    .money('downpayment', { label: 'Downpayment' })
    .text('details', { required: true, max: 4000, label: 'What the quotation covers' })
    .date('proposed_deadline')
    .date('valid_until')
    .done();
  const c = db.tx(() => {
    const custom = load(req.params.id);
    if (!['pending_review', 'quotation_sent'].includes(custom.status)) {
      throw new HttpError(409, 'A quotation can be sent while the request is pending review or already quoted.');
    }
    db.run("UPDATE quotations SET status = 'superseded' WHERE request_id = ? AND status = 'sent'", custom.id);
    db.run(
      `INSERT INTO quotations (request_id, amount, downpayment, details, proposed_deadline, valid_until, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      custom.id, values.amount, values.downpayment, values.details, values.proposed_deadline, values.valid_until, req.user.id);
    db.run("UPDATE custom_requests SET status = 'quotation_sent', updated_at = ? WHERE id = ?", new Date().toISOString(), custom.id);
    recordStatus('custom', custom.id, custom.status, 'quotation_sent', req.user.id, `Quotation ${money(values.amount)}`);
    notify(custom.customer_id, {
      kind: 'quotation', title: 'You have a quotation from Kyla', body: `${custom.event_type} · ${money(values.amount)}`, link: `/account/custom/${custom.id}`,
    });
    return custom;
  });
  req.flash('ok', 'Quotation sent. The customer can accept or decline it from their account.');
  res.redirect(`/studio/custom/${c.id}`);
});

router.post('/:id/quotations/:qid/withdraw', (req, res) => {
  const c = load(req.params.id);
  const q = db.one("SELECT * FROM quotations WHERE id = ? AND request_id = ? AND status = 'sent'", Number(req.params.qid) || 0, c.id);
  if (!q) throw new HttpError(409, 'That quotation is no longer open.');
  db.tx(() => {
    db.run("UPDATE quotations SET status = 'withdrawn' WHERE id = ?", q.id);
    if (c.status === 'quotation_sent') {
      db.run("UPDATE custom_requests SET status = 'pending_review', updated_at = ? WHERE id = ?", new Date().toISOString(), c.id);
      recordStatus('custom', c.id, c.status, 'pending_review', req.user.id, 'Quotation withdrawn');
    }
  });
  req.flash('ok', 'Quotation withdrawn.');
  res.redirect(`/studio/custom/${c.id}`);
});

const CUSTOMER_TITLES = {
  pending_review: 'Your request is back in review',
  approved: 'Your custom gown is approved',
  in_progress: 'Work has started on your gown',
  ready_for_fitting: 'Your gown is ready for a fitting',
  completed: 'Your custom gown is complete',
  cancelled: 'Custom request cancelled',
};

router.post('/:id/status', (req, res) => {
  const values = form(req.body).oneOf('to', Object.keys(CUSTOM), { label: 'Status' }).text('note', { max: 1000 }).done();
  const to = values.to;
  const c = db.tx(() => {
    const custom = load(req.params.id);
    if (!canMove(CUSTOM_FLOW, custom.status, to)) {
      throw new HttpError(409, `“${CUSTOM[custom.status].label}” can’t move to “${CUSTOM[to].label}” directly.`);
    }
    if (to === 'approved' && !db.one("SELECT 1 FROM quotations WHERE request_id = ? AND status = 'accepted'", custom.id)) {
      throw new HttpError(409, 'A request can only be approved after the customer accepts a quotation.');
    }
    if (to === 'cancelled') db.run("UPDATE quotations SET status = 'withdrawn' WHERE request_id = ? AND status = 'sent'", custom.id);
    db.run('UPDATE custom_requests SET status = ?, updated_at = ? WHERE id = ?', to, new Date().toISOString(), custom.id);
    recordStatus('custom', custom.id, custom.status, to, req.user.id, values.note);
    notify(custom.customer_id, {
      kind: `custom_${to}`, title: CUSTOMER_TITLES[to] || `Status: ${CUSTOM[to].label}`,
      body: values.note || custom.event_type, link: `/account/custom/${custom.id}`,
    });
    return custom;
  });
  req.flash('ok', `${c.reference} → ${CUSTOM[to].label}.`);
  res.redirect(`/studio/custom/${c.id}`);
});

router.post('/:id/brief', (req, res) => {
  const values = form(req.body)
    .text('agreed_measurements', { max: 4000 })
    .text('design_notes', { max: 8000 })
    .date('fitting_date')
    .date('deadline')
    .text('admin_note', { max: 4000 })
    .done();
  const c = load(req.params.id);
  db.run(
    `UPDATE custom_requests SET agreed_measurements = ?, design_notes = ?, fitting_date = ?, deadline = ?, admin_note = ?, updated_at = ?
      WHERE id = ?`,
    values.agreed_measurements, values.design_notes, values.fitting_date, values.deadline, values.admin_note, new Date().toISOString(), c.id);
  if (values.fitting_date !== c.fitting_date || values.deadline !== c.deadline) {
    recordStatus('custom', c.id, c.status, c.status, req.user.id,
      [values.fitting_date && `Fitting ${values.fitting_date}`, values.deadline && `Deadline ${values.deadline}`].filter(Boolean).join(' · ') || 'Dates cleared');
  }
  req.flash('ok', 'Brief saved.');
  res.redirect(`/studio/custom/${c.id}#brief`);
});

router.post('/:id/message', (req, res) => {
  const c = load(req.params.id);
  const body = String(req.body.body || '').trim();
  if (!body || body.length > 4000) throw new HttpError(422, 'Please write a message (up to 4,000 characters).');
  threads.post(threads.getOrCreate(c.customer_id, 'custom', c.id, `Custom gown · ${c.reference}`), req.user, body);
  req.flash('ok', 'Message sent to the customer.');
  res.redirect(`/studio/custom/${c.id}#messages`);
});

module.exports = router;
