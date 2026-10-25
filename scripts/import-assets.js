// Loads assets/manifest.json into the website:
//   - every processed photograph (original + transparent cut-out + studio version,
//     and close-up crops) becomes a library image the studio can browse and reuse
//   - each reviewed garment becomes a listing in its category
//     (published when the review says so, otherwise a draft)
//   - showcase roles from the review fill the homepage showcase.
// Safe to rerun: images are matched by the source file's SHA-256 and listings
// by their manifest entry, so nothing is duplicated and Kyla's edits are kept.
// No prices, sizes or materials are created — listings offer "made to order"
// enquiries until Kyla adds rental or purchase details in the studio.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../server/config');
const db = require('../server/db');
const library = require('../server/models/library');
const showcase = require('../server/models/showcase');
const { uniqueSlug } = require('../server/lib/util');
const { recordStatus } = require('../server/lib/notify');

const abs = (p) => path.join(config.root, p);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function main() {
  db.open();
  db.migrate({ log: () => {} });
  const manifest = JSON.parse(fs.readFileSync(abs('assets/manifest.json'), 'utf8'));
  const items = manifest.items.filter((i) => i.reviewed && !i.duplicate_of && i.category !== 'brand' && i.category !== 'unclassified');
  let created = 0; let reused = 0; let listings = 0;

  for (const item of items) {
    const original = fs.readFileSync(abs(item.original_path));
    const cutPng = item.transparent_master && item.background_removal.status === 'done' ? fs.readFileSync(abs(item.transparent_master)) : null;
    const look = await library.add({
      original, cutPng, sha256: item.sha256, source: 'manifest', sourceFile: item.original_path,
      category: item.category, title: item.title, kind: 'look', notes: item.notes, peopleNote: item.people_note,
    });
    look.created ? created++ : reused++;

    const detailRows = [];
    for (const d of item.details || []) {
      const buf = fs.readFileSync(abs(d.path));
      const r = await library.add({
        original: buf, sha256: sha(buf), source: 'manifest', sourceFile: d.path,
        category: item.category, title: item.title, kind: 'detail', caption: d.caption,
      });
      r.created ? created++ : reused++;
      detailRows.push(r.row);
    }

    // One listing per garment, created once; later runs only fill in missing photographs.
    let gown = db.one('SELECT * FROM gowns WHERE source_asset = ?', item.original_path);
    if (!gown) {
      const categoryId = library.ensureCategory(item.category);
      const status = item.publish ? 'published' : 'draft';
      const { lastInsertRowid } = db.run(
        `INSERT INTO gowns (slug, name, category_id, design_details, offer_custom, listing_status, published_at, source_asset)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        uniqueSlug(item.title, 'gowns'), item.title, categoryId, item.visible_details, status,
        status === 'published' ? new Date().toISOString() : null, item.original_path);
      gown = db.one('SELECT * FROM gowns WHERE id = ?', lastInsertRowid);
      db.run('INSERT INTO gown_units (gown_id, label) VALUES (?, ?)', gown.id, 'Piece 1');
      recordStatus('gown', gown.id, null, status, null, `Imported from ${item.original_path}`, false);
      listings++;
      console.log(`+ ${status.padEnd(9)} ${item.title}`);
    }
    library.attach(gown.id, [look.row.id, ...detailRows.map((r) => r.id)]);

    if (item.showcase && gown.listing_status === 'published' && !showcase.roleOf(gown.id)) {
      showcase.setRole(gown.id, item.showcase);
    }
  }

  // Order signature gowns by the curated rank.
  const ranked = items.filter((i) => i.showcase === 'signature').sort((a, b) => (a.showcase_rank ?? 99) - (b.showcase_rank ?? 99));
  ranked.forEach((i, k) => {
    const g = db.one('SELECT id FROM gowns WHERE source_asset = ?', i.original_path);
    if (g) db.run("UPDATE showcase SET position = ? WHERE gown_id = ? AND role = 'signature' AND position >= 0", k + 1, g.id);
  });

  console.log(`\nLibrary: ${created} added, ${reused} already present · ${listings} new listing(s).`);
  console.log('Review drafts and add rental/purchase details in /studio/gowns; manage the homepage in /studio/showcase.');
  db.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
