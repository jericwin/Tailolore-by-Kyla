// Image intake. Every upload is decoded by sharp (which rejects anything that
// isn't really an image), auto-rotated, stripped of metadata (EXIF, GPS) and
// re-encoded to WebP at a few widths. Original bytes are never served.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const sharp = require('sharp');
const multer = require('multer');
const config = require('../config');
const { HttpError } = require('./errors');
const studioCanvas = require('./studio-canvas');

sharp.cache(false);

const WIDTHS = [480, 960, 1600, 2400];
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif', 'tiff', 'gif']);
const ACCEPTED_MIME = /^image\/(jpeg|png|webp|avif|tiff|gif)$/;

/** Multer middleware keeping files in memory so they can be validated before touching disk. */
function uploader({ field = 'photos', maxFiles = config.upload.maxFiles } = {}) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.upload.maxBytes, files: maxFiles, fields: 80, fieldSize: 64 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!ACCEPTED_MIME.test(file.mimetype)) return cb(new HttpError(422, 'Please upload JPEG, PNG, WebP or AVIF photographs.'));
      cb(null, true);
    },
  }).array(field, maxFiles);
}

/** Wraps multer so its errors become readable messages. */
function handleUpload(mw) {
  return (req, res, next) => mw(req, res, (err) => {
    if (!err) return next();
    if (err instanceof HttpError) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(422, `Each photograph must be under ${Math.round(config.upload.maxBytes / 1048576)} MB.`));
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return next(new HttpError(422, 'Too many photographs at once.'));
    next(new HttpError(400, 'The upload could not be read.'));
  });
}

const newKey = () => `${Date.now().toString(36)}${crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}`;
const KEY_RE = /^[a-z0-9]{10,40}$/i;

async function inspect(buffer) {
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: 80e6 }).metadata();
  } catch {
    throw new HttpError(422, 'One of the files is not a readable image.');
  }
  if (!ACCEPTED_FORMATS.has(meta.format)) throw new HttpError(422, 'Please upload JPEG, PNG, WebP or AVIF photographs.');
  return meta;
}

async function writeDerivatives(input, dir, key, { suffix = '', widths = WIDTHS, quality = 82, alpha = false } = {}) {
  const base = sharp(input, { limitInputPixels: 80e6 }).rotate();
  const meta = await sharp(await base.clone().toBuffer()).metadata();
  for (const w of widths) {
    await base.clone()
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality, alphaQuality: alpha ? 90 : 100, effort: 5, smartSubsample: true })
      .toFile(path.join(dir, `${key}${suffix}-${w}.webp`));
  }
  return { width: meta.width, height: meta.height };
}

/** Stores a gown photograph. Keeps a high-quality master for later background removal. */
async function storeGownImage(buffer) {
  await inspect(buffer);
  const key = newKey();
  const dir = config.storage.gowns;
  const master = await sharp(buffer, { limitInputPixels: 80e6 }).rotate()
    .resize({ width: 3000, height: 3000, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 6 }).toBuffer();
  fs.writeFileSync(path.join(dir, `${key}-master.png`), master);
  const dims = await writeDerivatives(master, dir, key);
  return { key, ...dims };
}

/** Stores a private image (inspiration references). Smaller sizes, never public. */
async function storePrivateImage(buffer) {
  await inspect(buffer);
  const key = newKey();
  const dims = await writeDerivatives(buffer, config.storage.private, key, { widths: [480, 1600], quality: 80 });
  return { key, ...dims };
}

function removeFiles(dir, key) {
  if (!KEY_RE.test(key)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(`${key}-`)) fs.rmSync(path.join(dir, f), { force: true });
  }
}

function backgroundRemovalAvailable() {
  return !!config.rembgPath && fs.existsSync(config.rembgPath);
}

function runRembg(inputFile, outputFile) {
  // BiRefNet-lite gave the cleanest edges on the atelier's photographs (tulle, fringe, trains).
  const model = process.env.REMBG_MODEL || 'birefnet-general-lite';
  const args = ['i', '-m', model];
  if (process.env.REMBG_ALPHA_MATTING === '1') args.push('-a', '-ae', '10');
  args.push(inputFile, outputFile);
  return new Promise((resolve, reject) => {
    execFile(config.rembgPath, args, { timeout: 10 * 60_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Background removal failed: ${stderr || err.message}`));
      resolve();
    });
  });
}

/** Stores a transparent cut-out (PNG buffer) for key and builds its studio-canvas version. */
async function storeCutout(key, cutPng) {
  if (!KEY_RE.test(key)) throw new HttpError(400, 'Unknown image.');
  const dir = config.storage.gowns;
  fs.writeFileSync(path.join(dir, `${key}-cut-master.png`), cutPng);
  const cut = await writeDerivatives(cutPng, dir, key, { suffix: '-cut', alpha: true, quality: 86 });
  const studio = await makeStudio(key);
  return { cut, studio };
}

/** Places a stored cut-out on the shared studio canvas ("-studio" derivatives). */
async function makeStudio(key) {
  const master = path.join(config.storage.gowns, `${key}-cut-master.png`);
  if (!fs.existsSync(master)) throw new HttpError(404, 'There is no cut-out for this photograph yet.');
  const { buffer } = await studioCanvas.compose(fs.readFileSync(master));
  return writeDerivatives(buffer, config.storage.gowns, key, { suffix: '-studio', widths: WIDTHS.slice(0, 3), quality: 84 });
}

/**
 * Removes the background from a stored gown image with rembg (local, MIT-licensed),
 * always starting from the original master — never from an earlier cut-out.
 * The original is kept so the studio can switch back if delicate edges suffer.
 */
async function makeCutout(key) {
  if (!KEY_RE.test(key)) throw new HttpError(400, 'Unknown image.');
  if (!backgroundRemovalAvailable()) throw new HttpError(501, 'Background removal is not configured on this server.');
  const master = path.join(config.storage.gowns, `${key}-master.png`);
  if (!fs.existsSync(master)) throw new HttpError(404, 'The original photograph is missing.');
  const tmp = path.join(os.tmpdir(), `tbk-cut-${key}-${Date.now()}.png`);
  try {
    await runRembg(master, tmp);
    const cleaned = await studioCanvas.cleanMatte(fs.readFileSync(tmp));
    // Trim to the figure with a little air so trains and hems are never cropped.
    const trimmed = await sharp(cleaned.buffer).trim({ threshold: 2 }).toBuffer({ resolveWithObject: true });
    const pad = Math.round(Math.max(trimmed.info.width, trimmed.info.height) * 0.03);
    const padded = await sharp(trimmed.data)
      .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toBuffer();
    const { cut } = await storeCutout(key, padded);
    return cut;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const VARIANT_SUFFIX = { frame: '', cut: '-cut', studio: '-studio' };
const STUDIO = { width: studioCanvas.CANVAS.width, height: studioCanvas.CANVAS.height };

/** srcset for a stored image. variant: 'frame' (original), 'cut' or 'studio'. */
function srcset(key, width, { variant = 'frame', prefix = '/media/g/' } = {}) {
  // Every named width exists on disk, but files are never enlarged, so a small
  // original yields several identical files; list each real width once.
  const seen = new Set();
  const suffix = VARIANT_SUFFIX[variant] || '';
  const widths = variant === 'studio' ? WIDTHS.slice(0, 3) : WIDTHS;
  return widths.flatMap((w) => {
    const actual = Math.min(w, width || w);
    if (seen.has(actual)) return [];
    seen.add(actual);
    return [`${prefix}${key}${suffix}-${w}.webp ${actual}w`];
  }).join(', ');
}

function src(key, w = 960, { variant = 'frame', prefix = '/media/g/' } = {}) {
  const width = variant === 'studio' && w > 1600 ? 1600 : w;
  return `${prefix}${key}${VARIANT_SUFFIX[variant] || ''}-${width}.webp`;
}

module.exports = {
  WIDTHS, KEY_RE, uploader, handleUpload, storeGownImage, storePrivateImage, removeFiles,
  makeCutout, makeStudio, storeCutout, STUDIO, backgroundRemovalAvailable, srcset, src, inspect, writeDerivatives, newKey,
};
