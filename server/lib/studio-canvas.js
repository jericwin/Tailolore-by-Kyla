// The house "studio" presentation: every isolated garment is placed on the same
// warm-ivory canvas, at the same scale and on the same floor line, with a soft
// contact shadow made from its own silhouette. Used by the batch asset pipeline
// and by the studio dashboard, so old and new photographs match.
const sharp = require('sharp');

const CANVAS = { width: 1600, height: 2000 };
const FLOOR_Y = 0.935;        // where full-length hems rest, as a share of canvas height
const MAX_H = 0.86;           // tallest a figure may be
const MAX_W = 0.84;           // widest a figure may be (wide trains)
const COLORS = { light: '#f6f1e8', mid: '#eee6d9', edge: '#e2d7c6', floor: '#e6dccb' };

/** The shared background (also exported as assets/backgrounds/consistent-product-background.png). */
function backgroundSvg({ width = CANVAS.width, height = CANVAS.height } = {}) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <radialGradient id="light" cx="50%" cy="38%" r="75%">
      <stop offset="0" stop-color="${COLORS.light}"/>
      <stop offset=".62" stop-color="${COLORS.mid}"/>
      <stop offset="1" stop-color="${COLORS.edge}"/>
    </radialGradient>
    <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${COLORS.floor}" stop-opacity="0"/>
      <stop offset="1" stop-color="${COLORS.floor}" stop-opacity=".9"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#light)"/>
  <rect y="${Math.round(height * 0.80)}" width="100%" height="${Math.round(height * 0.20)}" fill="url(#floor)"/>
</svg>`);
}

async function background(opts) {
  return sharp(backgroundSvg(opts)).png().toBuffer();
}

/** Bounding box of visible pixels, and whether the subject was cut off at the photo's bottom edge. */
async function analyse(cutoutPng) {
  const { data, info } = await sharp(cutoutPng).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let top = height, bottom = -1, left = width, right = -1;
  const rowCount = new Uint32Array(height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] > 24) {
        rowCount[y]++;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (bottom < 0) throw new Error('The cut-out is empty.');
  // "Cropped" when a meaningful band of the subject touches the last rows of the photo.
  const edgeRows = Math.max(2, Math.round(height * 0.006));
  let edgeOpaque = 0;
  for (let y = height - edgeRows; y < height; y++) edgeOpaque = Math.max(edgeOpaque, rowCount[y]);
  const croppedBottom = edgeOpaque > (right - left + 1) * 0.12;
  return { width, height, box: { left, top, width: right - left + 1, height: bottom - top + 1 }, croppedBottom };
}

/**
 * Composes a transparent cut-out onto the studio canvas.
 * Returns { buffer (PNG), layout } — layout records the placement for the manifest.
 */
async function compose(cutoutPng) {
  const a = await analyse(cutoutPng);
  const subject = await sharp(cutoutPng).extract(a.box).png().toBuffer();
  const W = CANVAS.width;
  const H = CANVAS.height;

  // Consistent scale: fit within the shared maximum box; cropped (half-length)
  // subjects are allowed to run off the bottom edge like a portrait.
  const maxH = a.croppedBottom ? H * 0.92 : H * MAX_H;
  const scale = Math.min(maxH / a.box.height, (W * MAX_W) / a.box.width);
  const sw = Math.round(a.box.width * scale);
  const sh = Math.round(a.box.height * scale);
  const left = Math.round((W - sw) / 2);
  const top = a.croppedBottom ? H - sh : Math.round(H * FLOOR_Y - sh);
  const scaled = await sharp(subject).resize(sw, sh, { kernel: 'lanczos3' }).png().toBuffer();

  const layers = [];
  if (!a.croppedBottom) {
    // Contact shadow: the silhouette's lowest band, flattened, darkened and blurred.
    const band = Math.max(8, Math.round(sh * 0.09));
    const foot = await sharp(scaled).extract({ left: 0, top: sh - band, width: sw, height: band })
      .ensureAlpha().extractChannel(3).toBuffer();
    const shadowH = Math.max(18, Math.round(sh * 0.035));
    const alpha = await sharp(foot).resize(sw, shadowH, { fit: 'fill' }).blur(Math.max(6, sh * 0.012)).linear(0.42, 0).toBuffer();
    const black = await sharp({ create: { width: sw, height: shadowH, channels: 3, background: '#3a2f26' } }).png().toBuffer();
    const shadow = await sharp(black).joinChannel(alpha).png().toBuffer();
    layers.push({ input: shadow, left, top: Math.round(H * FLOOR_Y - shadowH * 0.55) });
    // A wide, very soft ambient pool so light gowns still read as standing on the floor.
    const pool = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Math.round(H * 0.08)}">
      <defs><radialGradient id="p"><stop offset="0" stop-color="#3a2f26" stop-opacity=".14"/><stop offset="1" stop-color="#3a2f26" stop-opacity="0"/></radialGradient></defs>
      <ellipse cx="${W / 2}" cy="${H * 0.04}" rx="${Math.min(W * 0.46, sw * 0.62)}" ry="${H * 0.03}" fill="url(#p)"/></svg>`);
    layers.push({ input: pool, left: 0, top: Math.round(H * FLOOR_Y - H * 0.04) });
  }
  layers.push({ input: scaled, left, top });

  const buffer = await sharp(await background()).composite(layers).png().toBuffer();
  return { buffer, layout: { canvas: `${W}x${H}`, scale: Number(scale.toFixed(4)), left, top, width: sw, height: sh, croppedBottom: a.croppedBottom } };
}

/** Cleans a raw matte: removes faint haze and tiny islands left by clutter. */
async function cleanMatte(png) {
  const img = sharp(png).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const n = width * height;
  // 1. faint haze → transparent
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] < 10) data[i * 4 + 3] = 0;
  // 2. keep connected regions that are at least 1.5% of the largest one
  const label = new Int32Array(n).fill(-1);
  const sizes = [];
  const stack = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (label[i] !== -1 || data[i * 4 + 3] < 40) continue;
    const id = sizes.length;
    let size = 0; let sp = 0;
    stack[sp++] = i; label[i] = id;
    while (sp) {
      const p = stack[--sp]; size++;
      const x = p % width; const y = (p / width) | 0;
      const nb = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1];
      for (const q of nb) if (q >= 0 && label[q] === -1 && data[q * 4 + 3] >= 40) { label[q] = id; stack[sp++] = q; }
    }
    sizes.push(size);
  }
  const largest = Math.max(0, ...sizes);
  let removed = 0;
  for (let i = 0; i < n; i++) {
    const l = label[i];
    if (l >= 0 && sizes[l] < largest * 0.015) { data[i * 4 + 3] = 0; removed++; }
  }
  const out = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return { buffer: out, removedPixels: removed, regions: sizes.filter((s) => s >= largest * 0.015).length };
}

module.exports = { CANVAS, COLORS, background, backgroundSvg, compose, analyse, cleanMatte };
