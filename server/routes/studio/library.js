// The asset library (every processed photograph) and the homepage showcase.
const crypto = require('node:crypto');
const express = require('express');
const db = require('../../db');
const auth = require('../../lib/auth');
const config = require('../../config');
const images = require('../../lib/images');
const gowns = require('../../models/gowns');
const library = require('../../models/library');
const showcase = require('../../models/showcase');
const { form } = require('../../lib/validate');
const { uniqueSlug } = require('../../lib/util');
const { recordStatus } = require('../../lib/notify');
const { HttpError } = require('../../lib/errors');

const router = express.Router();
const KINDS = { look: 'Full look', detail: 'Detail / close-up', atelier: 'Atelier / process' };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ——— Library ———
router.get('/library', (req, res) => {
  const category = library.CATEGORY_LABELS[req.query.category] ? req.query.category : '';
  const unused = req.query.unused === '1';
  res.render('studio/library.njk', {
    section: 'library',
    items: library.list({ category, unused }),
    categories: library.categories(),
    filters: { category, unused },
    CATEGORY_LABELS: library.CATEGORY_LABELS,
    KINDS,
    listings: db.all("SELECT id, name, listing_status FROM gowns WHERE listing_status <> 'archived' ORDER BY name"),
    canRemoveBg: images.backgroundRemovalAvailable(),
    uploadMaxMb: Math.round(config.upload.maxBytes / 1048576),
  });
});

function loadItem(req) {
  const row = db.one('SELECT * FROM library_images WHERE id = ?', Number(req.params.id) || 0);
  if (!row) throw new HttpError(404, 'Photograph not found in the library.');
  return row;
}

const libraryUpload = images.handleUpload(images.uploader({ field: 'photos', maxFiles: 12 }));

router.post('/library/upload', libraryUpload, auth.verifyCsrf, async (req, res, next) => {
  try {
    const files = req.files || [];
    if (!files.length) throw new HttpError(422, 'Choose one or more photographs to upload.');
    const category = library.CATEGORY_LABELS[req.body.category] ? req.body.category : 'unclassified';
    const kind = KINDS[req.body.kind] ? req.body.kind : 'look';
    const removeBg = req.body.remove_bg === '1' && images.backgroundRemovalAvailable();
    let added = 0; let duplicates = 0; let cut = 0; const failed = [];
    for (const f of files) {
      const title = f.originalname.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim().slice(0, 120) || null;
      const { row, created } = await library.add({ original: f.buffer, sha256: sha(f.buffer), source: 'upload', category, title, kind });
      if (!created) { duplicates++; continue; }
      added++;
      if (removeBg) {
        try { await library.removeBackground(row.file_key); cut++; } catch (err) { failed.push(f.originalname); }
      }
    }
    const parts = [`${added} photograph${added === 1 ? '' : 's'} added to the library`];
    if (duplicates) parts.push(`${duplicates} already there (skipped)`);
    if (removeBg) parts.push(`background removed from ${cut}`);
    if (failed.length) parts.push(`background removal failed for ${failed.join(', ')} — try again from the photograph`);
    req.flash(failed.length ? 'error' : 'ok', `${parts.join('; ')}.`);
    res.redirect('/studio/library');
  } catch (err) { next(err); }
});

router.post('/library/use', (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  if (!ids.length) {
    req.flash('error', 'Tick one or more photographs first.');
    return res.redirect('/studio/library');
  }
  const rows = ids.map((id) => db.one('SELECT * FROM library_images WHERE id = ?', id)).filter(Boolean);
  if (req.body.action === 'attach') {
    const gown = db.one('SELECT id, name FROM gowns WHERE id = ?', Number(req.body.gown_id) || 0);
    if (!gown) {
      req.flash('error', 'Choose the listing to add the photographs to.');
      return res.redirect('/studio/library');
    }
    const added = library.attach(gown.id, rows.map((r) => r.id));
    req.flash('ok', added.length ? `${added.length} photograph${added.length === 1 ? '' : 's'} added to “${gown.name}”.` : `Those photographs are already in “${gown.name}”.`);
    return res.redirect(`/studio/gowns/${gown.id}#photographs`);
  }
  // A new draft listing, named and categorised from the first photograph. No prices or sizes are invented.
  const first = rows.find((r) => r.kind === 'look') || rows[0];
  const name = first.title || 'New listing';
  const categoryId = first.category && first.category !== 'unclassified' ? library.ensureCategory(first.category) : null;
  const id = db.tx(() => {
    const gid = Number(db.run('INSERT INTO gowns (slug, name, category_id, offer_custom) VALUES (?, ?, ?, 1)',
      uniqueSlug(name, 'gowns'), name, categoryId).lastInsertRowid);
    db.run('INSERT INTO gown_units (gown_id, label) VALUES (?, ?)', gid, 'Piece 1');
    library.attach(gid, rows.map((r) => r.id));
    recordStatus('gown', gid, null, 'draft', req.user.id, 'Listing created from the library', false);
    return gid;
  });
  req.flash('ok', 'Draft created from the library. Check the name, add sizes and prices, then publish.');
  res.redirect(`/studio/gowns/${id}`);
});

router.post('/library/:id', (req, res) => {
  const row = loadItem(req);
  const values = form(req.body)
    .text('title', { max: 120 })
    .text('caption', { max: 300 })
    .oneOf('kind', Object.keys(KINDS), { fallback: row.kind })
    .oneOf('category', Object.keys(library.CATEGORY_LABELS), { fallback: row.category })
    .done();
  db.run('UPDATE library_images SET title = ?, caption = ?, kind = ?, category = ? WHERE id = ?',
    values.title, values.caption, values.kind, values.category, row.id);
  req.flash('ok', 'Photograph details saved.');
  res.redirect(`/studio/library#lib-${row.id}`);
});

router.post('/library/:id/cutout', async (req, res, next) => {
  try {
    const row = loadItem(req);
    await library.removeBackground(row.file_key);
    req.flash('ok', 'Background removed. Compare the original and studio versions — check hems, trains and sheer fabric before using it.');
    res.redirect(`/studio/library#lib-${row.id}`);
  } catch (err) { next(err); }
});

router.post('/library/:id/delete', (req, res) => {
  const row = loadItem(req);
  if (db.one('SELECT 1 FROM gown_images WHERE file_key = ? LIMIT 1', row.file_key)) {
    req.flash('error', 'This photograph is used by a listing. Remove it from the listing first.');
    return res.redirect(`/studio/library#lib-${row.id}`);
  }
  db.run('DELETE FROM library_images WHERE id = ?', row.id);
  library.releaseKey(row.file_key);
  req.flash('ok', 'Photograph removed from the library. The original in the assets folder is untouched.');
  res.redirect('/studio/library');
});

// ——— Showcase ———
router.get('/showcase', (req, res) => {
  const entries = showcase.rows().map((r) => {
    const gown = gowns.byId(r.gown_id);
    return gown && { ...r, gown, shown: (r.image_id && gown.images.find((i) => i.id === r.image_id)) || gown.main };
  }).filter(Boolean);
  const inShowcase = new Set(entries.map((e) => e.gown_id));
  res.render('studio/showcase.njk', {
    section: 'showcase',
    masterpiece: entries.find((e) => e.role === 'masterpiece') || null,
    signature: entries.filter((e) => e.role === 'signature'),
    candidates: gowns.catalog().filter((g) => g.main && !inShowcase.has(g.id)),
  });
});

router.post('/showcase/add', (req, res) => {
  const gown = gowns.byId(Number(req.body.gown_id) || 0);
  if (!gown) throw new HttpError(422, 'Choose a gown to add.');
  showcase.setRole(gown.id, req.body.role === 'masterpiece' ? 'masterpiece' : 'signature');
  req.flash('ok', `“${gown.name}” added to the homepage showcase.`);
  res.redirect('/studio/showcase');
});

router.post('/showcase/:gownId', (req, res) => {
  const gown = gowns.byId(Number(req.params.gownId) || 0);
  if (!gown || !showcase.roleOf(gown.id)) throw new HttpError(404, 'That gown is not in the showcase.');
  const action = String(req.body.action || 'save');
  if (action === 'up' || action === 'down') showcase.move(gown.id, action);
  else if (action === 'remove') showcase.setRole(gown.id, null);
  else if (action === 'masterpiece' || action === 'signature') showcase.setRole(gown.id, action);
  else {
    const values = form(req.body).text('note', { max: 240 }).done();
    const imageId = Number(req.body.image_id) || null;
    showcase.update(gown.id, { imageId: imageId && gown.images.some((i) => i.id === imageId) ? imageId : null, note: values.note });
  }
  req.flash('ok', {
    remove: `“${gown.name}” removed from the showcase. Its listing is unchanged.`,
    masterpiece: `“${gown.name}” now opens the homepage.`,
    signature: `“${gown.name}” moved to the signature pieces.`,
  }[action] || 'Showcase updated.');
  res.redirect(`/studio/showcase#sc-${gown.id}`);
});

module.exports = router;
