// The homepage showcase: one "masterpiece" and an ordered list of signature gowns.
// Only published gowns with a photograph are ever shown.
const db = require('../db');
const gowns = require('./gowns');

function rows() {
  return db.all(
    `SELECT s.*, g.name, g.listing_status FROM showcase s JOIN gowns g ON g.id = s.gown_id
      ORDER BY s.role = 'masterpiece' DESC, s.position, s.id`);
}

/** Decorated gowns for the public homepage. */
function forHome() {
  const out = { masterpiece: null, signature: [] };
  const seen = new Set();
  for (const r of rows()) {
    if (r.listing_status !== 'published' || seen.has(r.gown_id)) continue;
    const gown = gowns.byId(r.gown_id);
    if (!gown || !gown.main) continue;
    const image = (r.image_id && gown.images.find((i) => i.id === r.image_id)) || gown.main;
    const detail = gown.images.find((i) => i.kind === 'detail') || null;
    const entry = { ...gown, showImage: image, detail, note: r.note };
    seen.add(r.gown_id);
    if (r.role === 'masterpiece') out.masterpiece = entry;
    else out.signature.push(entry);
  }
  return out;
}

function roleOf(gownId) {
  return db.one('SELECT role FROM showcase WHERE gown_id = ?', gownId)?.role || null;
}

/** Sets a gown's place in the showcase: 'masterpiece', 'signature' or null to remove it. */
function setRole(gownId, role) {
  db.tx(() => {
    if (!role) { db.run('DELETE FROM showcase WHERE gown_id = ?', gownId); return; }
    if (role === 'masterpiece') {
      // The previous masterpiece stays in the showcase as the first signature gown.
      db.run("UPDATE showcase SET role = 'signature', position = -1 WHERE role = 'masterpiece' AND gown_id <> ?", gownId);
    }
    const existing = db.one('SELECT id, role FROM showcase WHERE gown_id = ?', gownId);
    const pos = role === 'signature'
      ? db.one("SELECT COALESCE(MAX(position), 0) + 1 AS n FROM showcase WHERE role = 'signature'").n
      : 0;
    if (!existing) db.run('INSERT INTO showcase (gown_id, role, position) VALUES (?, ?, ?)', gownId, role, pos);
    else if (existing.role !== role) db.run('UPDATE showcase SET role = ?, position = ? WHERE id = ?', role, pos, existing.id);
    renumber();
  });
}

function move(gownId, direction) {
  db.tx(() => {
    const list = db.all("SELECT id, gown_id FROM showcase WHERE role = 'signature' ORDER BY position, id");
    const i = list.findIndex((r) => r.gown_id === gownId);
    const j = i + (direction === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    list.forEach((r, k) => db.run('UPDATE showcase SET position = ? WHERE id = ?', k + 1, r.id));
  });
}

function update(gownId, { imageId = null, note = null }) {
  db.run('UPDATE showcase SET image_id = ?, note = ? WHERE gown_id = ?', imageId, note, gownId);
}

function renumber() {
  db.all("SELECT id FROM showcase WHERE role = 'signature' ORDER BY position, id")
    .forEach((r, k) => db.run('UPDATE showcase SET position = ? WHERE id = ?', k + 1, r.id));
}

module.exports = { rows, forHome, roleOf, setRole, move, update };
