// Gown listings: create, edit, photographs, units, availability blocks, publishing.
const express = require('express');
const db = require('../../db');
const auth = require('../../lib/auth');
const crypto = require('node:crypto');
const gowns = require('../../models/gowns');
const library = require('../../models/library');
const showcase = require('../../models/showcase');
const images = require('../../lib/images');
const config = require('../../config');
const { form } = require('../../lib/validate');
const { uniqueSlug, safeNext, moneyInput } = require('../../lib/util');
const { recordStatus } = require('../../lib/notify');
const { refreshGownAvailability } = require('../../lib/availability');
const { LISTING, AVAILABILITY } = require('../../lib/status');
const { HttpError, ValidationError } = require('../../lib/errors');
const { renderGown } = require('../public');

const router = express.Router();
const BACKDROPS = ['bone', 'clay', 'ink', 'moss', 'blush'];

router.get('/', (req, res) => {
  const filter = LISTING[req.query.listing] ? req.query.listing : '';
  const cat = Number(req.query.category) || 0;
  const where = [];
  const params = [];
  if (filter) { where.push('g.listing_status = ?'); params.push(filter); } else where.push("g.listing_status <> 'archived'");
  if (cat) { where.push('g.category_id = ?'); params.push(cat); }
  const rows = db.all(
    `SELECT g.*, c.name AS category_name,
            (SELECT COUNT(*) FROM gown_images WHERE gown_id = g.id) AS image_count,
            (SELECT file_key FROM gown_images WHERE gown_id = g.id ORDER BY is_main DESC, sort_order, id LIMIT 1) AS thumb_key,
            (SELECT COUNT(*) FROM gown_units WHERE gown_id = g.id AND status = 'active') AS units_active,
            (SELECT COUNT(*) FROM rentals WHERE gown_id = g.id AND status = 'requested') AS pending_rentals
       FROM gowns g LEFT JOIN categories c ON c.id = g.category_id
      WHERE ${where.join(' AND ')} ORDER BY g.updated_at DESC`, ...params);
  res.render('studio/gowns.njk', {
    section: 'gowns', gowns: rows, filter, cat, categories: gowns.categories(),
    counts: Object.fromEntries(db.all('SELECT listing_status AS s, COUNT(*) AS n FROM gowns GROUP BY listing_status').map((r) => [r.s, r.n])),
  });
});

router.get('/new', (req, res) => {
  res.render('studio/gown-form.njk', {
    section: 'gowns', gown: null, values: { offer_rental: 1, units: 1 }, errors: {}, categories: gowns.categories(),
  });
});

function readGownForm(body) {
  const v = form(body)
    .text('name', { required: true, max: 120, label: 'Gown name' })
    .text('description', { max: 4000 })
    .id('category_id')
    .text('sizes', { max: 200 })
    .text('color', { max: 120 })
    .text('design_details', { max: 2000 })
    .bool('offer_rental').bool('offer_purchase').bool('offer_custom').bool('featured')
    .money('rental_price', { label: 'Rental price' })
    .int('rental_period_days', { min: 1, max: 60, label: 'Rental period' })
    .money('purchase_price', { label: 'Purchase price' })
    .money('security_deposit', { label: 'Deposit' })
    .text('care_instructions', { max: 2000 })
    .text('terms', { max: 4000 })
    .int('sort_order', { min: -9999, max: 9999 });
  for (const k of ['bust', 'waist', 'hips', 'length', 'notes']) v.text(`m_${k}`, { max: k === 'notes' ? 400 : 40 });
  const val = v.values;
  if (val.offer_rental && val.rental_price == null) v.fail('rental_price', 'Set a rental price, or untick “Available to rent”.');
  if (val.offer_purchase && val.purchase_price == null) v.fail('purchase_price', 'Set a price, or untick “Available to buy”.');
  if (val.category_id && !db.one('SELECT 1 FROM categories WHERE id = ?', val.category_id)) v.fail('category_id', 'Choose a category.');
  const values = v.done();
  const m = Object.fromEntries(['bust', 'waist', 'hips', 'length', 'notes'].filter((k) => values[`m_${k}`]).map((k) => [k, values[`m_${k}`]]));
  values.measurements = Object.keys(m).length ? JSON.stringify(m) : null;
  // Prices for services that aren't offered are cleared so they can never show by accident.
  if (!values.offer_rental) { values.rental_price = null; values.rental_period_days = null; }
  if (!values.offer_purchase) values.purchase_price = null;
  if (!values.offer_rental) values.security_deposit = null;
  return values;
}

function formValuesFromGown(g) {
  const m = g.measurements || {};
  return {
    ...g,
    rental_price: moneyInput(g.rental_price),
    purchase_price: moneyInput(g.purchase_price),
    security_deposit: moneyInput(g.security_deposit),
    m_bust: m.bust, m_waist: m.waist, m_hips: m.hips, m_length: m.length, m_notes: m.notes,
  };
}

router.post('/new', (req, res, next) => {
  try {
    const values = readGownForm(req.body);
    const units = Math.max(1, Math.min(20, Number(req.body.units) || 1));
    const id = db.tx(() => {
      const { lastInsertRowid } = db.run(
        `INSERT INTO gowns (slug, name, description, category_id, sizes, measurements, color, design_details,
           offer_rental, offer_purchase, offer_custom, rental_price, rental_period_days, purchase_price, security_deposit,
           care_instructions, terms, featured, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        uniqueSlug(values.name, 'gowns'), values.name, values.description, values.category_id, values.sizes, values.measurements,
        values.color, values.design_details, values.offer_rental, values.offer_purchase, values.offer_custom,
        values.rental_price, values.rental_period_days, values.purchase_price, values.security_deposit,
        values.care_instructions, values.terms, values.featured, values.sort_order || 0);
      const gid = Number(lastInsertRowid);
      for (let i = 1; i <= units; i++) db.run('INSERT INTO gown_units (gown_id, label) VALUES (?, ?)', gid, `Piece ${i}`);
      recordStatus('gown', gid, null, 'draft', req.user.id, 'Listing created', false);
      return gid;
    });
    req.flash('ok', 'Draft saved. Add photographs, then preview and publish.');
    res.redirect(`/studio/gowns/${id}#photographs`);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(422).render('studio/gown-form.njk', {
        section: 'gowns', gown: null, values: req.body, errors: err.errors, categories: gowns.categories(),
      });
    }
    next(err);
  }
});

function loadGown(req, res, next) {
  const gown = gowns.byId(Number(req.params.id) || 0);
  if (!gown) return next(new HttpError(404, 'Gown not found.'));
  req.gown = gown;
  next();
}

function renderEdit(req, res, { values, errors = {}, statusCode = 200 } = {}) {
  const g = req.gown;
  res.status(statusCode).render('studio/gown-form.njk', {
    section: 'gowns',
    gown: g,
    values: values || formValuesFromGown(g),
    errors,
    categories: gowns.categories(),
    units: db.all(
      `SELECT u.*, (SELECT COUNT(*) FROM rentals r WHERE r.unit_id = u.id AND r.status IN ('awaiting_deposit','confirmed','picked_up')) AS holds
         FROM gown_units u WHERE u.gown_id = ? ORDER BY u.id`, g.id),
    blocks: db.all(
      `SELECT b.*, u.label AS unit_label FROM availability_blocks b LEFT JOIN gown_units u ON u.id = b.unit_id
        WHERE b.gown_id = ? AND b.end_date >= date('now', '-30 days') ORDER BY b.start_date`, g.id),
    bookings: db.all(
      `SELECT r.id, r.reference, r.pickup_date, r.return_date, r.event_date, r.status, u.full_name AS customer, gu.label AS unit_label
         FROM rentals r JOIN users u ON u.id = r.customer_id LEFT JOIN gown_units gu ON gu.id = r.unit_id
        WHERE r.gown_id = ? AND r.status IN ('requested','awaiting_deposit','confirmed','picked_up') ORDER BY r.pickup_date`, g.id),
    canRemoveBg: images.backgroundRemovalAvailable(),
    showcaseRole: showcase.roleOf(g.id),
    libraryCount: db.one('SELECT COUNT(*) AS n FROM library_images').n,
    BACKDROPS, LISTING, AVAILABILITY,
    uploadMaxMb: Math.round(config.upload.maxBytes / 1048576),
  });
}

router.get('/:id', loadGown, (req, res) => renderEdit(req, res));

router.post('/:id', loadGown, (req, res, next) => {
  try {
    const values = readGownForm(req.body);
    const version = Number(req.body.version) || 0;
    const result = db.run(
      `UPDATE gowns SET name = ?, description = ?, category_id = ?, sizes = ?, measurements = ?, color = ?, design_details = ?,
         offer_rental = ?, offer_purchase = ?, offer_custom = ?, rental_price = ?, rental_period_days = ?, purchase_price = ?,
         security_deposit = ?, care_instructions = ?, terms = ?, featured = ?, sort_order = ?,
         updated_at = ?, version = version + 1
       WHERE id = ? AND version = ?`,
      values.name, values.description, values.category_id, values.sizes, values.measurements, values.color, values.design_details,
      values.offer_rental, values.offer_purchase, values.offer_custom, values.rental_price, values.rental_period_days,
      values.purchase_price, values.security_deposit, values.care_instructions, values.terms, values.featured,
      values.sort_order || 0, new Date().toISOString(), req.gown.id, version);
    if (!result.changes) {
      req.flash('error', 'This listing was changed in another window. Your edits were not saved — please review and try again.');
      return res.redirect(`/studio/gowns/${req.gown.id}`);
    }
    req.flash('ok', 'Changes saved.');
    res.redirect(`/studio/gowns/${req.gown.id}`);
  } catch (err) {
    if (err instanceof ValidationError) return renderEdit(req, res, { values: req.body, errors: err.errors, statusCode: 422 });
    next(err);
  }
});

router.get('/:id/preview', loadGown, (req, res) => {
  res.locals.area = 'site';
  renderGown(req, res, req.gown, { preview: true });
});

router.post('/:id/listing', loadGown, (req, res) => {
  const to = String(req.body.listing_status || '');
  if (!LISTING[to]) throw new HttpError(422, 'Unknown listing status.');
  const g = req.gown;
  if (to === 'published') {
    const problems = [];
    if (!g.images.length) problems.push('add at least one photograph');
    if (!g.offer_rental && !g.offer_purchase && !g.offer_custom) problems.push('choose at least one service (rent, buy or made to order)');
    if (problems.length) {
      req.flash('error', `Before publishing, ${problems.join(' and ')}.`);
      return res.redirect(`/studio/gowns/${g.id}`);
    }
  }
  db.run(`UPDATE gowns SET listing_status = ?, published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END,
            updated_at = ?, version = version + 1 WHERE id = ?`,
  to, to, new Date().toISOString(), new Date().toISOString(), g.id);
  recordStatus('gown', g.id, g.listing_status, to, req.user.id, null, false);
  req.flash('ok', { published: 'Published — the gown is now visible on the website.', unpublished: 'Unpublished — hidden from the website.', archived: 'Archived.', draft: 'Moved back to drafts.' }[to]);
  res.redirect(safeNext(req.body.next, `/studio/gowns/${g.id}`));
});

router.post('/:id/availability', loadGown, (req, res) => {
  const to = String(req.body.availability_status || '');
  if (!AVAILABILITY[to]) throw new HttpError(422, 'Unknown availability.');
  db.run('UPDATE gowns SET availability_status = ?, updated_at = ?, version = version + 1 WHERE id = ?', to, new Date().toISOString(), req.gown.id);
  recordStatus('gown', req.gown.id, req.gown.availability_status, to, req.user.id, 'Availability set manually', false);
  req.flash('ok', `Marked as ${AVAILABILITY[to].toLowerCase()}.`);
  res.redirect(`/studio/gowns/${req.gown.id}#availability`);
});

router.post('/:id/delete', loadGown, (req, res) => {
  const g = req.gown;
  const refs = db.one(
    `SELECT (SELECT COUNT(*) FROM rentals WHERE gown_id = ?) + (SELECT COUNT(*) FROM orders WHERE gown_id = ?) AS n`, g.id, g.id).n;
  if (refs) {
    req.flash('error', 'This gown has rental or order records, so it can’t be deleted. Archive it instead to keep those records intact.');
    return res.redirect(`/studio/gowns/${g.id}`);
  }
  if (String(req.body.confirm_name || '').trim() !== g.name) {
    req.flash('error', 'To delete, type the gown’s name exactly.');
    return res.redirect(`/studio/gowns/${g.id}#danger`);
  }
  db.run('DELETE FROM gowns WHERE id = ?', g.id);
  // Files shared with the library or another listing are kept.
  for (const img of g.images) library.releaseKey(img.file_key);
  req.flash('ok', `“${g.name}” was deleted.`);
  res.redirect('/studio/gowns');
});

// ——— Photographs ———
const photoUpload = images.handleUpload(images.uploader({ field: 'photos', maxFiles: 8 }));

router.post('/:id/photos', loadGown, photoUpload, auth.verifyCsrf, async (req, res, next) => {
  try {
    const files = req.files || [];
    if (!files.length) throw new HttpError(422, 'Choose one or more photographs to upload.');
    const kind = ['look', 'detail', 'atelier'].includes(req.body.kind) ? req.body.kind : 'look';
    // Every upload also goes into the library, so it can be reused; identical files are stored once.
    const category = db.one('SELECT name FROM categories WHERE id = ?', req.gown.category_id || 0)?.name;
    const categoryPath = Object.keys(library.CATEGORY_LABELS).find((k) => library.CATEGORY_LABELS[k] === category) || 'unclassified';
    const ids = [];
    for (const f of files) {
      const { row } = await library.add({
        original: f.buffer, sha256: crypto.createHash('sha256').update(f.buffer).digest('hex'),
        source: 'upload', category: categoryPath, title: req.gown.name, kind,
      });
      ids.push(row.id);
    }
    library.attach(req.gown.id, ids);
    db.run('UPDATE gowns SET updated_at = ? WHERE id = ?', new Date().toISOString(), req.gown.id);
    req.flash('ok', `${files.length} photograph${files.length > 1 ? 's' : ''} added.`);
    res.redirect(`/studio/gowns/${req.gown.id}#photographs`);
  } catch (err) { next(err); }
});

function loadImage(req) {
  const img = db.one('SELECT * FROM gown_images WHERE id = ? AND gown_id = ?', Number(req.params.imageId) || 0, req.gown.id);
  if (!img) throw new HttpError(404, 'Photograph not found.');
  return img;
}

router.post('/:id/photos/:imageId', loadGown, (req, res) => {
  const img = loadImage(req);
  const v = form(req.body)
    .text('alt', { max: 300 })
    .text('caption', { max: 300 })
    .oneOf('kind', ['look', 'detail', 'atelier'], { fallback: img.kind })
    .oneOf('presentation', ['frame', 'cutout', 'studio'], { fallback: img.presentation })
    .oneOf('backdrop', BACKDROPS, { fallback: img.backdrop })
    .int('sort_order', { min: 0, max: 999 });
  const values = v.done();
  if (values.presentation === 'cutout' && !img.has_cutout) values.presentation = 'frame';
  if (values.presentation === 'studio' && !img.has_studio) values.presentation = img.has_cutout ? 'cutout' : 'frame';
  db.tx(() => {
    db.run('UPDATE gown_images SET alt = ?, caption = ?, kind = ?, presentation = ?, backdrop = ?, sort_order = COALESCE(?, sort_order) WHERE id = ?',
      values.alt, values.caption, values.kind, values.presentation, values.backdrop, values.sort_order, img.id);
    if (req.body.is_main === '1') {
      db.run('UPDATE gown_images SET is_main = (id = ?) WHERE gown_id = ?', img.id, req.gown.id);
    }
  });
  req.flash('ok', 'Photograph updated.');
  res.redirect(`/studio/gowns/${req.gown.id}#photo-${img.id}`);
});

router.post('/:id/photos/:imageId/cutout', loadGown, async (req, res, next) => {
  try {
    const img = loadImage(req);
    await library.removeBackground(img.file_key, { studioFor: [img.id] });
    req.flash('ok', 'Background removed and placed on the studio canvas. Compare the versions below — check hems, trains and sheer fabric — and switch back to “Full frame” if anything was lost.');
    res.redirect(`/studio/gowns/${req.gown.id}#photo-${img.id}`);
  } catch (err) { next(err); }
});

router.post('/:id/photos/:imageId/cutout/remove', loadGown, (req, res) => {
  const img = loadImage(req);
  const shared = db.one('SELECT 1 FROM gown_images WHERE file_key = ? AND id <> ? LIMIT 1', img.file_key, img.id)
    || db.one('SELECT 1 FROM library_images WHERE file_key = ? LIMIT 1', img.file_key);
  if (shared) {
    // The cut-out also belongs to the library or another listing: stop using it here only.
    db.run("UPDATE gown_images SET presentation = 'frame' WHERE id = ?", img.id);
  } else {
    const fs = require('node:fs');
    const path = require('node:path');
    for (const f of fs.readdirSync(config.storage.gowns)) {
      if (f.startsWith(`${img.file_key}-cut-`) || f.startsWith(`${img.file_key}-studio-`)) fs.rmSync(path.join(config.storage.gowns, f), { force: true });
    }
    db.run("UPDATE gown_images SET has_cutout = 0, has_studio = 0, cut_width = NULL, cut_height = NULL, presentation = 'frame' WHERE id = ?", img.id);
  }
  req.flash('ok', 'Cutout discarded. The original photograph is unchanged.');
  res.redirect(`/studio/gowns/${req.gown.id}#photo-${img.id}`);
});

router.post('/:id/photos/:imageId/delete', loadGown, (req, res) => {
  const img = loadImage(req);
  db.tx(() => {
    db.run('DELETE FROM gown_images WHERE id = ?', img.id);
    if (img.is_main) {
      const next = db.one('SELECT id FROM gown_images WHERE gown_id = ? ORDER BY sort_order, id LIMIT 1', req.gown.id);
      if (next) db.run('UPDATE gown_images SET is_main = 1 WHERE id = ?', next.id);
    }
  });
  library.releaseKey(img.file_key); // still in the library unless it was only ever used here
  req.flash('ok', 'Photograph removed from this listing.');
  res.redirect(`/studio/gowns/${req.gown.id}#photographs`);
});

router.post('/:id/showcase', loadGown, (req, res) => {
  const role = ['masterpiece', 'signature'].includes(req.body.role) ? req.body.role : null;
  showcase.setRole(req.gown.id, role);
  const where = { masterpiece: 'now opens the homepage', signature: 'is now a signature piece on the homepage' }[role];
  req.flash('ok', role
    ? `“${req.gown.name}” ${where}${req.gown.listing_status === 'published' ? '' : ' — it appears once published'}.`
    : 'Removed from the homepage showcase.');
  res.redirect(`/studio/gowns/${req.gown.id}#homepage`);
});

// ——— Units (physical pieces) ———
router.post('/:id/units', loadGown, (req, res) => {
  const v = form(req.body).text('label', { required: true, max: 60, label: 'Label' }).text('size', { max: 40 });
  const values = v.done();
  db.run('INSERT INTO gown_units (gown_id, label, size) VALUES (?, ?, ?)', req.gown.id, values.label, values.size);
  refreshGownAvailability(req.gown.id);
  req.flash('ok', 'Piece added.');
  res.redirect(`/studio/gowns/${req.gown.id}#availability`);
});

router.post('/:id/units/:unitId', loadGown, (req, res) => {
  const unit = db.one('SELECT * FROM gown_units WHERE id = ? AND gown_id = ?', Number(req.params.unitId) || 0, req.gown.id);
  if (!unit) throw new HttpError(404, 'Piece not found.');
  const v = form(req.body)
    .text('label', { required: true, max: 60, label: 'Label' })
    .text('size', { max: 40 })
    .oneOf('status', ['active', 'sold', 'retired'], { fallback: unit.status });
  const values = v.done();
  if (values.status !== 'active' && unit.status === 'active') {
    const holds = db.one("SELECT COUNT(*) AS n FROM rentals WHERE unit_id = ? AND status IN ('awaiting_deposit','confirmed','picked_up')", unit.id).n;
    if (holds) {
      req.flash('error', 'This piece has approved rentals. Resolve them before retiring or selling it.');
      return res.redirect(`/studio/gowns/${req.gown.id}#availability`);
    }
  }
  db.run('UPDATE gown_units SET label = ?, size = ?, status = ? WHERE id = ?',
    values.label, values.size, unit.status === 'reserved_sale' ? unit.status : values.status, unit.id);
  refreshGownAvailability(req.gown.id);
  req.flash('ok', 'Piece updated.');
  res.redirect(`/studio/gowns/${req.gown.id}#availability`);
});

// ——— Availability blocks ———
router.post('/:id/blocks', loadGown, (req, res) => {
  const v = form(req.body)
    .date('start_date', { required: true, label: 'From' })
    .date('end_date', { required: true, label: 'To' })
    .id('unit_id')
    .text('reason', { max: 200 });
  const values = v.done();
  if (values.end_date < values.start_date) throw new ValidationError({ end_date: 'End must be after start.' }, '“To” must be on or after “From”.');
  if (values.unit_id && !db.one('SELECT 1 FROM gown_units WHERE id = ? AND gown_id = ?', values.unit_id, req.gown.id)) {
    throw new HttpError(422, 'Unknown piece.');
  }
  db.run('INSERT INTO availability_blocks (gown_id, unit_id, start_date, end_date, reason) VALUES (?, ?, ?, ?, ?)',
    req.gown.id, values.unit_id, values.start_date, values.end_date, values.reason);
  req.flash('ok', 'Dates blocked. Approved rentals are not affected; new requests for these dates are refused.');
  res.redirect(`/studio/gowns/${req.gown.id}#availability`);
});

router.post('/:id/blocks/:blockId/delete', loadGown, (req, res) => {
  db.run('DELETE FROM availability_blocks WHERE id = ? AND gown_id = ?', Number(req.params.blockId) || 0, req.gown.id);
  req.flash('ok', 'Block removed.');
  res.redirect(`/studio/gowns/${req.gown.id}#availability`);
});

module.exports = router;
