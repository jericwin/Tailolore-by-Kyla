// The asset library: every processed photograph the studio can use in a listing.
// Files are stored once (by file_key) and may be attached to several listings.
const db = require('../db');
const config = require('../config');
const images = require('../lib/images');

const CATEGORY_LABELS = {
  'gowns/evening-gowns': 'Evening gowns',
  'gowns/pageant-gowns': 'Pageant gowns',
  'gowns/ball-gowns': 'Ball gowns',
  'gowns/debut-gowns': 'Debut gowns',
  'gowns/wedding-gowns': 'Wedding gowns',
  'menswear/pageant-formalwear': 'Pageant formalwear',
  'menswear/formalwear': 'Formalwear',
  'menswear/suits': 'Suits',
  costumes: 'Costumes',
  'national-costumes': 'National costumes',
  'couple-outfits': 'Couple outfits',
  'other-fashion': 'Other fashion',
  unclassified: 'To review',
};
const SECTION_OF = (category) => {
  const top = String(category || '').split('/')[0];
  if (top === 'gowns') return 'gowns';
  if (top === 'menswear') return 'menswear';
  if (top === 'costumes' || top === 'national-costumes') return 'costumes';
  return 'other';
};

function label(category) {
  return CATEGORY_LABELS[category] || String(category || 'Uncategorised').split('/').pop().replace(/-/g, ' ');
}

/** Stores an original (and optionally its transparent cut-out) as a library image. */
async function add({ original, cutPng = null, sha256 = null, source = 'upload', sourceFile = null, category = null, title = null, kind = 'look', caption = null, notes = null, peopleNote = null }) {
  if (sha256) {
    const existing = db.one('SELECT * FROM library_images WHERE sha256 = ?', sha256);
    if (existing) return { row: existing, created: false };
  }
  const stored = await images.storeGownImage(original);
  let cut = null; let studio = null;
  if (cutPng) ({ cut, studio } = await images.storeCutout(stored.key, cutPng));
  const { lastInsertRowid } = db.run(
    `INSERT INTO library_images (file_key, sha256, source, source_file, category, title, kind, caption, width, height,
       has_cutout, cut_width, cut_height, has_studio, notes, people_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    stored.key, sha256, source, sourceFile, category, title, kind, caption, stored.width, stored.height,
    cut ? 1 : 0, cut?.width || null, cut?.height || null, studio ? 1 : 0, notes, peopleNote);
  return { row: db.one('SELECT * FROM library_images WHERE id = ?', lastInsertRowid), created: true };
}

/** Attaches library images to a listing; studio presentation is preferred when available. */
function attach(gownId, libraryIds) {
  const rows = libraryIds.map((id) => db.one('SELECT * FROM library_images WHERE id = ?', id)).filter(Boolean);
  let order = db.one('SELECT COALESCE(MAX(sort_order), 0) AS n FROM gown_images WHERE gown_id = ?', gownId).n;
  let hasMain = !!db.one('SELECT 1 FROM gown_images WHERE gown_id = ? AND is_main = 1', gownId);
  const added = [];
  for (const r of rows) {
    if (db.one('SELECT 1 FROM gown_images WHERE gown_id = ? AND file_key = ?', gownId, r.file_key)) continue;
    const main = !hasMain && r.kind === 'look';
    const { lastInsertRowid } = db.run(
      `INSERT INTO gown_images (gown_id, file_key, has_cutout, has_studio, presentation, kind, alt, caption, width, height,
         cut_width, cut_height, is_main, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      gownId, r.file_key, r.has_cutout, r.has_studio, r.has_studio ? 'studio' : 'frame', r.kind,
      r.title || null, r.caption, r.width, r.height, r.cut_width, r.cut_height, main ? 1 : 0, ++order);
    if (main) hasMain = true;
    added.push(Number(lastInsertRowid));
  }
  return added;
}

/**
 * Removes the background of a stored photograph (always from its original master)
 * and records the new cut-out and studio versions everywhere the file is used.
 * Listings that show it switch to the studio presentation only when asked.
 */
async function removeBackground(key, { studioFor = [] } = {}) {
  const cut = await images.makeCutout(key);
  db.tx(() => {
    db.run('UPDATE library_images SET has_cutout = 1, cut_width = ?, cut_height = ?, has_studio = 1 WHERE file_key = ?',
      cut.width, cut.height, key);
    db.run('UPDATE gown_images SET has_cutout = 1, cut_width = ?, cut_height = ?, has_studio = 1 WHERE file_key = ?',
      cut.width, cut.height, key);
    for (const id of studioFor) db.run("UPDATE gown_images SET presentation = 'studio' WHERE id = ?", id);
  });
  return cut;
}

/** Library rows with how many listings use each one. */
function list({ category = '', unused = false } = {}) {
  const where = [];
  const params = [];
  if (category) { where.push('l.category = ?'); params.push(category); }
  if (unused) where.push('NOT EXISTS (SELECT 1 FROM gown_images gi WHERE gi.file_key = l.file_key)');
  return db.all(
    `SELECT l.*,
            (SELECT GROUP_CONCAT(g.id || ':' || g.name, '|') FROM gown_images gi JOIN gowns g ON g.id = gi.gown_id
              WHERE gi.file_key = l.file_key) AS used_by
       FROM library_images l ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY l.category, l.kind, l.id`, ...params)
    .map((r) => ({
      ...r,
      label: label(r.category),
      usedBy: (r.used_by || '').split('|').filter(Boolean).map((s) => { const i = s.indexOf(':'); return { id: Number(s.slice(0, i)), name: s.slice(i + 1) }; }),
      thumb: images.src(r.file_key, 480, { variant: r.has_studio ? 'studio' : 'frame' }),
      frame: images.src(r.file_key, 960),
      cutout: r.has_cutout ? images.src(r.file_key, 960, { variant: 'cut' }) : null,
      studio: r.has_studio ? images.src(r.file_key, 960, { variant: 'studio' }) : null,
    }));
}

function categories() {
  return db.all('SELECT category, COUNT(*) AS n FROM library_images GROUP BY category ORDER BY category')
    .map((r) => ({ ...r, label: label(r.category) }));
}

/** True when a stored file is still referenced by a listing or the library. */
function keyInUse(key) {
  return !!(db.one('SELECT 1 FROM gown_images WHERE file_key = ? LIMIT 1', key)
    || db.one('SELECT 1 FROM library_images WHERE file_key = ? LIMIT 1', key));
}

/** Deletes a stored photograph's files only if nothing references it any more. */
function releaseKey(key) {
  if (!keyInUse(key)) images.removeFiles(config.storage.gowns, key);
}

/** Ensures a category row exists for a manifest category path; returns its id. */
function ensureCategory(categoryPath) {
  const name = label(categoryPath);
  const existing = db.one('SELECT id FROM categories WHERE name = ?', name);
  if (existing) return existing.id;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const order = db.one('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM categories').n;
  return Number(db.run('INSERT INTO categories (name, slug, sort_order, section) VALUES (?, ?, ?, ?)',
    name, slug, order, SECTION_OF(categoryPath)).lastInsertRowid);
}

module.exports = { add, attach, list, removeBackground, categories, keyInUse, releaseKey, ensureCategory, label, SECTION_OF, CATEGORY_LABELS };
