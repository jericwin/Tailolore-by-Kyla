// Organises the photographs in assets/originals:
//   - checks every file against assets/review.json (the image-by-image review)
//   - detects exact and near duplicates
//   - removes backgrounds from the ORIGINAL file (never from a processed copy)
//   - writes a transparent master, a display version on the shared studio
//     background, and close-up crops, into assets/processed/<category>/
//   - writes assets/manifest.json, which the site import uses.
// Originals are never modified. Background removal is skipped when a master
// already exists for the same source bytes; pass --force to redo it.
//
//   npm run assets:organize            (needs REMBG_PATH, see README)
//   npm run assets:organize -- --force
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const config = require('../server/config');
const canvas = require('../server/lib/studio-canvas');
const { slugify } = require('../server/lib/util');

const ASSETS = path.join(config.root, 'assets');
const ORIGINALS = path.join(ASSETS, 'originals');
const PROCESSED = path.join(ASSETS, 'processed');
const MANIFEST = path.join(ASSETS, 'manifest.json');
const IMAGE_EXT = /\.(jpe?g|png|webp|avif|tiff?|heic)$/i;
const force = process.argv.includes('--force');
const rel = (p) => path.relative(config.root, p).split(path.sep).join('/');

async function dHash(file) {
  const { data } = await sharp(file).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += data[y * 9 + x] > data[y * 9 + x + 1] ? '1' : '0';
  return bits;
}
const hamming = (a, b) => [...a].reduce((n, c, i) => n + (c !== b[i] ? 1 : 0), 0);

function rembgBinary() {
  const candidates = [config.rembgPath, path.join(config.root, '.venv-rembg', 'Scripts', 'rembg.exe'), path.join(config.root, '.venv-rembg', 'bin', 'rembg')];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function removeBackground(bin, input, output) {
  const model = process.env.REMBG_MODEL || 'birefnet-general-lite';
  const args = ['i', '-m', model];
  if (process.env.REMBG_ALPHA_MATTING === '1') args.push('-a');
  // One retry: the model occasionally fails to load under memory pressure.
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync(bin, [...args, input, output], { stdio: 'ignore', timeout: 10 * 60_000, windowsHide: true });
      return model;
    } catch (err) {
      if (attempt >= 2) throw err;
    }
  }
}

/** Writes the manifest; while a run is in progress, unprocessed entries from the last run are kept. */
function writeManifest(items, carryOver = null) {
  const done = new Set(items.map((i) => i.filename));
  const all = carryOver ? [...items, ...[...carryOver.values()].filter((i) => !done.has(i.filename))] : items;
  const manifest = {
    generated: new Date().toISOString(),
    background: { path: 'assets/backgrounds/consistent-product-background.png', canvas: `${canvas.CANVAS.width}x${canvas.CANVAS.height}`, colors: canvas.COLORS },
    counts: all.reduce((acc, i) => ({ ...acc, [i.category]: (acc[i.category] || 0) + 1 }), {}),
    items: all,
  };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function main() {
  const review = JSON.parse(fs.readFileSync(path.join(ASSETS, 'review.json'), 'utf8'));
  const decisions = new Map(review.images.map((r) => [r.file, r]));
  const previous = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : { items: [] };
  const prevBySource = new Map(previous.items.map((i) => [i.filename, i]));
  const bin = rembgBinary();

  fs.mkdirSync(path.join(ASSETS, 'backgrounds'), { recursive: true });
  await sharp(await canvas.background()).png({ compressionLevel: 9 }).toFile(path.join(ASSETS, 'backgrounds', 'consistent-product-background.png'));

  const files = fs.readdirSync(ORIGINALS).filter((f) => IMAGE_EXT.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const items = [];
  const seen = [];

  for (const filename of files) {
    const src = path.join(ORIGINALS, filename);
    const bytes = fs.readFileSync(src);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const meta = await sharp(bytes).metadata();
    const hash = await dHash(src);
    const decision = decisions.get(filename);
    const item = {
      filename,
      original_path: rel(src),
      sha256,
      width: meta.width,
      height: meta.height,
      reviewed: !!decision,
      category: decision ? decision.category : 'unclassified',
      title: decision?.title || null,
      slug: decision ? slugify(decision.title || path.parse(filename).name) : slugify(path.parse(filename).name),
      visible_details: decision?.visible || null,
      publish: !!decision?.publish,
      showcase: decision?.showcase || null,
      showcase_rank: decision?.showcase_rank ?? null,
      people_note: decision?.people || null,
      notes: decision?.notes || (decision ? null : 'Not yet reviewed — placed in unclassified for manual review.'),
      duplicate_of: null,
      background_removal: { status: 'not_requested' },
      transparent_master: null,
      display_path: null,
      details: [],
    };

    // Duplicates: identical bytes, or a near-identical picture at the same proportions.
    const dup = seen.find((s) => s.sha256 === sha256
      || (hamming(s.hash, hash) <= 3 && Math.abs(s.ratio - meta.height / meta.width) < 0.02));
    if (dup) {
      item.duplicate_of = dup.filename;
      item.notes = [item.notes, `Duplicate of ${dup.filename}; not processed or displayed.`].filter(Boolean).join(' ');
      items.push(item);
      continue;
    }
    seen.push({ filename, sha256, hash, ratio: meta.height / meta.width });

    if (item.category === 'brand') { item.background_removal.status = 'not_applicable'; items.push(item); continue; }

    const outDir = path.join(PROCESSED, ...item.category.split('/'));
    fs.mkdirSync(outDir, { recursive: true });
    const masterPath = path.join(outDir, `${item.slug}.png`);
    const displayPath = path.join(outDir, `${item.slug}-studio.jpg`);
    const prev = prevBySource.get(filename);

    if (decision?.remove_background && decision.cutout_ok !== false) {
      const reuse = !force && fs.existsSync(masterPath) && prev?.sha256 === sha256 && prev.background_removal?.status === 'done';
      if (reuse) {
        item.background_removal = { ...prev.background_removal };
        console.log(`= ${filename}: existing transparent master reused`);
      } else if (!bin) {
        item.background_removal = { status: 'pending', reason: 'rembg is not installed (see README → Background removal).' };
        console.log(`! ${filename}: background removal pending — rembg not found`);
      } else {
        const tmp = path.join(os.tmpdir(), `tbk-raw-${sha256.slice(0, 12)}.png`);
        process.stdout.write(`… ${filename}: removing background … `);
        try {
          const model = removeBackground(bin, src, tmp);
          const cleaned = await canvas.cleanMatte(fs.readFileSync(tmp));
          await sharp(cleaned.buffer).png({ compressionLevel: 9 }).toFile(masterPath);
          const a = await canvas.analyse(cleaned.buffer);
          item.background_removal = {
            status: 'done', model, processed_on: new Date().toISOString().slice(0, 10),
            subject_box: a.box, cropped_bottom_in_original: a.croppedBottom,
            kept_regions: cleaned.regions, stray_pixels_removed: cleaned.removedPixels,
          };
          console.log('done');
        } catch (err) {
          item.background_removal = { status: 'failed', reason: String(err.message).split('\n')[0] };
          console.log('failed — the original will be used');
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      }
      if (item.background_removal.status === 'done') {
        item.background_removal.visual_review = decision.cutout_review || 'Not yet inspected — review before publishing.';
        item.transparent_master = rel(masterPath);
        const { buffer, layout } = await canvas.compose(fs.readFileSync(masterPath));
        await sharp(buffer).jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' }).toFile(displayPath);
        item.display_path = rel(displayPath);
        item.display_layout = layout;
      }
    } else if (decision?.cutout_ok === false) {
      item.background_removal = { status: 'rejected', reason: decision.cutout_note || 'Cut-out had unacceptable artifacts; the original photograph is used.' };
    }
    if (!item.display_path) {
      // Unprocessed or rejected: the original, re-encoded, is the display image.
      await sharp(src).rotate().jpeg({ quality: 90, mozjpeg: true }).toFile(displayPath);
      item.display_path = rel(displayPath);
    }

    for (const [i, d] of (decision?.details || []).entries()) {
      const box = {
        left: Math.max(0, d.x), top: Math.max(0, d.y),
        width: Math.min(d.w, meta.width - d.x), height: Math.min(d.h, meta.height - d.y),
      };
      const out = path.join(outDir, `${item.slug}-detail-${i + 1}.jpg`);
      await sharp(src).rotate().extract(box).jpeg({ quality: 90, mozjpeg: true }).toFile(out);
      item.details.push({ path: rel(out), caption: d.caption, crop: box });
    }
    items.push(item);
    // Saved after every image so an interrupted run keeps (and later reuses) finished cut-outs.
    writeManifest(items, prevBySource);
  }

  for (const r of review.images) {
    if (!files.includes(r.file)) console.warn(`review.json lists ${r.file}, which is not in assets/originals.`);
  }

  writeManifest(items);
  const unreviewed = items.filter((i) => !i.reviewed).length;
  console.log(`\n${items.length} files · ${items.filter((i) => i.background_removal.status === 'done').length} cut out · ${unreviewed} awaiting review · manifest → assets/manifest.json`);
}

main().catch((err) => { console.error(err); process.exit(1); });
