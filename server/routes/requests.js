// Customer actions that create records: rental requests, order inquiries,
// custom gown requests, wishlist and "ask about this gown" messages.
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const gowns = require('../models/gowns');
const threads = require('../models/threads');
const availability = require('../lib/availability');
const images = require('../lib/images');
const settings = require('../lib/settings');
const { form } = require('../lib/validate');
const { notifyStudio, recordStatus } = require('../lib/notify');
const { reference, safeNext } = require('../lib/util');
const { today, formatDate } = require('../lib/dates');
const { HttpError, ValidationError } = require('../lib/errors');
const { renderGown } = require('./public');

const router = express.Router();

function loadPublishedGown(req, res, next) {
  const gown = gowns.bySlug(req.params.slug);
  if (!gown) return next(new HttpError(404, 'This gown is not in the collection.'));
  req.gown = gown;
  next();
}

// ——— Rental request ———
router.post('/gowns/:slug/rent', auth.requireCustomer, loadPublishedGown, (req, res, next) => {
  const gown = req.gown;
  try {
    if (!gown.canRent) throw new HttpError(409, 'This gown isn’t available for rental at the moment.');
    const v = form(req.body)
      .date('event_date', { required: true, label: 'Event date' })
      .date('pickup_date', { required: true, label: 'Pickup date' })
      .date('return_date', { required: true, label: 'Return date' })
      .text('size_note', { max: 200 })
      .text('customer_note', { max: 2000 })
      .bool('accept_terms');
    const termsText = [gown.terms, settings.get('rental_terms')].filter(Boolean).join('\n\n');
    if (termsText && req.body.accept_terms !== '1') v.fail('accept_terms', 'Please confirm you’ve read the rental terms.');
    if (v.ok()) {
      for (const [k, msg] of Object.entries(availability.checkWindow(gown, v.values))) v.fail(k, msg);
    }
    const values = v.done();

    const id = db.tx(() => {
      // Checked inside the write transaction so two customers can't slip in at once.
      if (!availability.findFreeUnit(gown.id, values.pickup_date, values.return_date)) {
        throw new ValidationError({ pickup_date: 'Those dates are no longer available. Please choose others.' });
      }
      const dup = db.one(
        `SELECT reference FROM rentals WHERE customer_id = ? AND gown_id = ? AND status = 'requested'
            AND pickup_date <= ? AND return_date >= ?`, req.user.id, gown.id, values.return_date, values.pickup_date);
      if (dup) throw new ValidationError({ event_date: `You already have a pending request (${dup.reference}) for these dates.` });

      const ref = reference('RN', 'rentals');
      const { lastInsertRowid } = db.run(
        `INSERT INTO rentals (reference, customer_id, gown_id, event_date, pickup_date, return_date, size_note, customer_note,
                              quoted_price, quoted_deposit, period_days, terms_snapshot, deposit_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ref, req.user.id, gown.id, values.event_date, values.pickup_date, values.return_date, values.size_note,
        values.customer_note, gown.rental_price, gown.security_deposit, gown.rental_period_days, termsText || null,
        gown.security_deposit ? 'not_received' : 'not_required');
      const rid = Number(lastInsertRowid);
      recordStatus('rental', rid, null, 'requested', req.user.id);
      notifyStudio({
        kind: 'rental_requested',
        title: `Rental request · ${gown.name}`,
        body: `${req.user.fullName} · event ${formatDate(values.event_date)}`,
        link: `/studio/rentals/${rid}`,
      });
      return rid;
    });
    req.flash('ok', 'Your rental request was sent. Kyla will review it — your dates are not held until she approves.');
    res.redirect(`/account/rentals/${id}`);
  } catch (err) {
    if (err instanceof ValidationError) {
      return renderGown(req, res, gown, { preview: false, errors: err.errors, values: req.body, service: 'rent', statusCode: 422 });
    }
    next(err);
  }
});

// ——— Purchase inquiry ———
router.post('/gowns/:slug/order', auth.requireCustomer, loadPublishedGown, (req, res, next) => {
  const gown = req.gown;
  try {
    if (!gown.canBuy) throw new HttpError(409, 'This gown isn’t available for purchase at the moment.');
    const v = form(req.body)
      .text('size_note', { max: 200 })
      .oneOf('fulfillment', ['pickup', 'delivery'], { label: 'Pickup or delivery' })
      .text('delivery_address', { max: 600 })
      .text('customer_note', { max: 2000 });
    if (req.body.fulfillment === 'delivery' && !String(req.body.delivery_address || '').trim()) {
      v.fail('delivery_address', 'Please add the delivery address.');
    }
    const termsText = [gown.terms, settings.get('purchase_terms')].filter(Boolean).join('\n\n');
    if (termsText && req.body.accept_terms !== '1') v.fail('accept_terms', 'Please confirm you’ve read the terms.');
    const values = v.done();
    const open = db.one(
      "SELECT id, reference FROM orders WHERE customer_id = ? AND gown_id = ? AND status IN ('pending', 'confirmed', 'processing', 'ready')",
      req.user.id, gown.id);
    if (open) throw new ValidationError({ customer_note: `You already have an open order for this gown (${open.reference}).` });

    const id = db.tx(() => {
      const ref = reference('OR', 'orders');
      const { lastInsertRowid } = db.run(
        `INSERT INTO orders (reference, customer_id, gown_id, size_note, fulfillment, delivery_address, customer_note, quoted_price, terms_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ref, req.user.id, gown.id, values.size_note, values.fulfillment,
        values.fulfillment === 'delivery' ? values.delivery_address : null, values.customer_note, gown.purchase_price, termsText || null);
      const oid = Number(lastInsertRowid);
      recordStatus('order', oid, null, 'pending', req.user.id);
      notifyStudio({
        kind: 'order_requested', title: `Order inquiry · ${gown.name}`, body: req.user.fullName, link: `/studio/orders/${oid}`,
      });
      return oid;
    });
    req.flash('ok', 'Your order inquiry was sent. Nothing has been charged — Kyla will confirm availability and payment details.');
    res.redirect(`/account/orders/${id}`);
  } catch (err) {
    if (err instanceof ValidationError) {
      return renderGown(req, res, gown, { preview: false, errors: err.errors, values: req.body, service: 'buy', statusCode: 422 });
    }
    next(err);
  }
});

// ——— Ask about a gown ———
router.post('/gowns/:slug/ask', auth.requireCustomer, loadPublishedGown, (req, res, next) => {
  const body = String(req.body.body || '').trim();
  if (!body) {
    req.flash('error', 'Please write a message first.');
    return res.redirect(`/gowns/${req.gown.slug}#ask`);
  }
  if (body.length > 4000) return next(new HttpError(422, 'Please keep messages under 4,000 characters.'));
  const thread = threads.getOrCreate(req.user.id, 'gown', req.gown.id, req.gown.name);
  threads.post(thread, req.user, body);
  req.flash('ok', 'Message sent to Kyla.');
  res.redirect(`/account/messages/${thread.id}`);
});

// ——— Wishlist ———
router.post('/wishlist/:gownId', auth.requireCustomer, (req, res, next) => {
  const gown = db.one("SELECT id, slug FROM gowns WHERE id = ? AND listing_status = 'published'", Number(req.params.gownId) || 0);
  if (!gown) return next(new HttpError(404, 'This gown is not in the collection.'));
  const exists = db.one('SELECT 1 FROM wishlist WHERE user_id = ? AND gown_id = ?', req.user.id, gown.id);
  if (exists) db.run('DELETE FROM wishlist WHERE user_id = ? AND gown_id = ?', req.user.id, gown.id);
  else db.run('INSERT INTO wishlist (user_id, gown_id) VALUES (?, ?)', req.user.id, gown.id);
  if (req.get('x-requested-with') === 'fetch') return res.json({ saved: !exists });
  res.redirect(safeNext(req.body.next, `/gowns/${gown.slug}`));
});

// ——— Custom gown request ———
const inspirationUpload = images.handleUpload(images.uploader({ field: 'inspiration', maxFiles: 6 }));

router.post('/commission', auth.requireCustomer, inspirationUpload, auth.verifyCsrf, async (req, res, next) => {
  const basedOn = req.body.based_on ? gowns.bySlug(String(req.body.based_on)) : null;
  try {
    const v = form(req.body)
      .text('event_type', { required: true, max: 120, label: 'The occasion' })
      .date('event_date', { label: 'Event date' })
      .text('silhouette', { max: 600 })
      .text('colors', { max: 300 })
      .text('fabrics', { max: 600 })
      .money('budget_min', { label: 'Budget' })
      .money('budget_max', { label: 'Budget' })
      .text('instructions', { max: 4000 })
      .text('contact_name', { required: true, max: 120, label: 'Your name' })
      .email('contact_email')
      .phone('contact_phone')
      .oneOf('preferred_contact', ['messages', 'phone', 'email', 'facebook'], { required: false, fallback: 'messages' });
    for (const k of ['bust', 'waist', 'hips', 'height', 'shoulder', 'other']) v.text(`m_${k}`, { max: k === 'other' ? 600 : 40 });
    if (v.values.event_date && v.values.event_date < today()) v.fail('event_date', 'The event date is in the past.');
    if (v.values.budget_min && v.values.budget_max && v.values.budget_min > v.values.budget_max) {
      v.fail('budget_max', 'The upper amount should be higher than the lower one.');
    }
    const values = v.done();
    const measurements = Object.fromEntries(
      ['bust', 'waist', 'hips', 'height', 'shoulder', 'other'].filter((k) => values[`m_${k}`]).map((k) => [k, values[`m_${k}`]]));

    const stored = [];
    for (const f of req.files || []) stored.push(await images.storePrivateImage(f.buffer));

    const id = db.tx(() => {
      const ref = reference('CU', 'custom_requests');
      const { lastInsertRowid } = db.run(
        `INSERT INTO custom_requests (reference, customer_id, based_on_gown_id, event_type, event_date, silhouette, colors, fabrics,
            measurements, budget_min, budget_max, instructions, contact_name, contact_phone, contact_email, preferred_contact)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ref, req.user.id, basedOn?.offer_custom ? basedOn.id : null, values.event_type, values.event_date, values.silhouette,
        values.colors, values.fabrics, Object.keys(measurements).length ? JSON.stringify(measurements) : null,
        values.budget_min, values.budget_max, values.instructions, values.contact_name, values.contact_phone,
        values.contact_email, values.preferred_contact);
      const cid = Number(lastInsertRowid);
      for (const s of stored) {
        db.run('INSERT INTO custom_request_images (request_id, file_key, width, height) VALUES (?, ?, ?, ?)', cid, s.key, s.width, s.height);
      }
      recordStatus('custom', cid, null, 'pending_review', req.user.id);
      notifyStudio({
        kind: 'custom_requested', title: `Custom gown request · ${values.event_type}`, body: values.contact_name, link: `/studio/custom/${cid}`,
      });
      return cid;
    });
    req.flash('ok', 'Your request was sent. Kyla will review it and reply here with questions or a quotation.');
    res.redirect(`/account/custom/${id}`);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(422).render('public/commission.njk', {
        basedOn, values: req.body, errors: err.errors, minDate: today(),
        formError: (req.files || []).length ? 'Please re-attach your inspiration images after fixing the fields below.' : null,
      });
    }
    next(err);
  }
});

module.exports = router;
