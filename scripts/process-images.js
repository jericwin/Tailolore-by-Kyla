// Batch photo intake — the quickest way to load the gowns from Facebook.
//
// 1. Save each gown's photographs into its own folder:
//      content/incoming/<gown name>/photo1.jpg, photo2.jpg …
//    (A folder may also contain detail-*.jpg files; they are filed as close-ups.)
// 2. Run:  npm run images:process            (originals only)
//          npm run images:process -- --cutout (also remove backgrounds; needs REMBG_PATH)
//
// Each folder becomes a DRAFT listing (or adds photos to an existing gown whose
// name matches). Nothing is published automatically and no prices are invented —
// Kyla completes the details and publishes from the studio.
const fs = require('node:fs');
const path = require('node:path');
const config = require('../server/config');
const db = require('../server/db');
const images = require('../server/lib/images');
const { uniqueSlug } = require('../server/lib/util');

const incoming = path.join(config.root, 'content', 'incoming');
const processed = path.join(config.root, 'content', 'processed');
const wantCutout = process.argv.includes('--cutout');
const EXT = /\.(jpe?g|png|webp|avif|tiff?)$/i;

async function main() {
  db.open();
  db.migrate({ log: () => {} });
  fs.mkdirSync(incoming, { recursive: true });
  const folders = fs.readdirSync(incoming, { withFileTypes: true }).filter((d) => d.isDirectory());
  if (!folders.length) {
    console.log(`No folders in ${incoming}. Create one folder per gown and put its photographs inside.`);
    return;
  }
  if (wantCutout && !images.backgroundRemovalAvailable()) {
    console.warn('REMBG_PATH is not set or not found — continuing without background removal.');
  }

  for (const folder of folders) {
    const dir = path.join(incoming, folder.name);
    const files = fs.readdirSync(dir).filter((f) => EXT.test(f)).sort();
    if (!files.length) continue;
    const name = folder.name.replace(/[-_]+/g, ' ').trim();
    let gown = db.one('SELECT id, name FROM gowns WHERE name = ? COLLATE NOCASE', name);
    if (!gown) {
      const { lastInsertRowid } = db.run(
        "INSERT INTO gowns (slug, name, listing_status) VALUES (?, ?, 'draft')", uniqueSlug(name, 'gowns'), name);
      db.run('INSERT INTO gown_units (gown_id, label) VALUES (?, ?)', lastInsertRowid, 'Piece 1');
      gown = { id: Number(lastInsertRowid), name };
      console.log(`+ draft “${name}”`);
    } else {
      console.log(`~ adding to “${gown.name}”`);
    }
    let order = db.one('SELECT COALESCE(MAX(sort_order), 0) AS n FROM gown_images WHERE gown_id = ?', gown.id).n;
    let hasMain = !!db.one('SELECT 1 FROM gown_images WHERE gown_id = ? AND is_main = 1', gown.id);

    for (const file of files) {
      try {
        const stored = await images.storeGownImage(fs.readFileSync(path.join(dir, file)));
        const kind = /^detail/i.test(file) ? 'detail' : 'look';
        const { lastInsertRowid } = db.run(
          `INSERT INTO gown_images (gown_id, file_key, kind, width, height, is_main, sort_order, alt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          gown.id, stored.key, kind, stored.width, stored.height, hasMain || kind === 'detail' ? 0 : 1, ++order, gown.name);
        if (!hasMain && kind !== 'detail') hasMain = true;
        let note = `${stored.width}×${stored.height}`;
        if (wantCutout && images.backgroundRemovalAvailable() && kind === 'look') {
          const dims = await images.makeCutout(stored.key);
          // Cut-outs are prepared but the original stays on the site until Kyla reviews and switches.
          db.run('UPDATE gown_images SET has_cutout = 1, cut_width = ?, cut_height = ? WHERE id = ?', dims.width, dims.height, lastInsertRowid);
          note += ', cut-out ready for review';
        }
        console.log(`    ${file} → ${note}`);
      } catch (err) {
        console.error(`    ${file} skipped: ${err.message}`);
      }
    }
    const done = path.join(processed, `${folder.name}-${Date.now()}`);
    fs.mkdirSync(processed, { recursive: true });
    fs.renameSync(dir, done);
  }
  console.log('Done. Review the drafts in /studio/gowns, add details and publish.');
}

main().then(() => db.close()).catch((err) => { console.error(err); process.exit(1); });
