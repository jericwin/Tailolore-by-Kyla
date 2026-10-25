// Builds the brand assets served from /public:
//  - copies the self-hosted font files out of node_modules
//  - turns the supplied logo.jpg (white on black) into transparent PNGs in
//    ivory and ink, plus separate monogram / wordmark crops and favicons.
// Run with: npm run brand:assets
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const out = (...p) => path.join(root, 'public', ...p);

const FONTS = [
  ['@fontsource-variable/bodoni-moda/files/bodoni-moda-latin-standard-normal.woff2', 'bodoni-moda.woff2'],
  ['@fontsource-variable/bodoni-moda/files/bodoni-moda-latin-standard-italic.woff2', 'bodoni-moda-italic.woff2'],
  ['@fontsource-variable/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2', 'hanken-grotesk.woff2'],
  ['@fontsource-variable/hanken-grotesk/files/hanken-grotesk-latin-wght-italic.woff2', 'hanken-grotesk-italic.woff2'],
  ['@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2', 'ibm-plex-mono.woff2'],
];

// Ink and ivory match the palette tokens in public/css/base.css.
const COLORS = { ivory: [244, 239, 230], ink: [22, 19, 17] };

// Regions of the 2000×2000 source logo.
const REGIONS = {
  full: null,
  monogram: { left: 780, top: 700, width: 480, height: 400 },
  wordmark: { left: 270, top: 1180, width: 1330, height: 300 },
};

async function tintedFromLuminance(src, region, rgb) {
  let img = sharp(src).greyscale();
  if (region) img = img.extract(region);
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const rgba = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    // Lift the black floor of the JPEG so compression noise becomes fully transparent.
    const a = Math.max(0, Math.min(255, Math.round((data[i * info.channels] - 18) * 1.08)));
    rgba[i * 4] = rgb[0];
    rgba[i * 4 + 1] = rgb[1];
    rgba[i * 4 + 2] = rgb[2];
    rgba[i * 4 + 3] = a;
  }
  return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .trim({ threshold: 1 });
}

async function main() {
  const src = [path.join(root, 'assets', 'originals', 'logo.jpg'), path.join(root, 'assets', 'logo.jpg'), path.join(root, 'logo.jpg')].find((p) => fs.existsSync(p));
  if (!src) throw new Error('logo.jpg not found in project root');

  fs.mkdirSync(out('fonts'), { recursive: true });
  for (const [from, to] of FONTS) {
    fs.copyFileSync(path.join(root, 'node_modules', from), out('fonts', to));
  }

  fs.mkdirSync(out('img', 'brand'), { recursive: true });
  for (const [name, region] of Object.entries(REGIONS)) {
    for (const [colorName, rgb] of Object.entries(COLORS)) {
      const img = await tintedFromLuminance(src, region, rgb);
      const width = name === 'monogram' ? 400 : 1200;
      await img.resize({ width, withoutEnlargement: true }).png({ compressionLevel: 9 })
        .toFile(out('img', 'brand', `${name}-${colorName}.png`));
    }
  }

  // Favicons: ivory monogram on ink, echoing the original logo.
  const mono = await (await tintedFromLuminance(src, REGIONS.monogram, COLORS.ivory))
    .resize({ width: 380, height: 380, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  const ink = { r: COLORS.ink[0], g: COLORS.ink[1], b: COLORS.ink[2], alpha: 1 };
  const base = sharp({ create: { width: 512, height: 512, channels: 4, background: ink } })
    .composite([{ input: mono, gravity: 'center' }]).png();
  const icon = await base.toBuffer();
  await sharp(icon).resize(180).toFile(out('img', 'brand', 'apple-touch-icon.png'));
  await sharp(icon).resize(64).toFile(out('img', 'brand', 'favicon-64.png'));
  await sharp(icon).resize(512).toFile(out('img', 'brand', 'icon-512.png'));

  // Social preview card.
  const word = await (await tintedFromLuminance(src, REGIONS.full, COLORS.ivory))
    .resize({ width: 760 }).png().toBuffer();
  await sharp({ create: { width: 1200, height: 630, channels: 4, background: ink } })
    .composite([{ input: word, gravity: 'center' }]).jpeg({ quality: 86 })
    .toFile(out('img', 'brand', 'og-card.jpg'));

  console.log('Brand assets written to public/fonts and public/img/brand');
}

main().catch((err) => { console.error(err); process.exit(1); });
