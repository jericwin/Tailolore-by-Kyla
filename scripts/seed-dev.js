// DEVELOPMENT ONLY. Fills the development database with clearly labelled
// sample listings so layouts and workflows can be exercised before Kyla's
// real photographs are added. Refuses to run in production.
//
//   npm run seed:dev            add samples (keeps existing data)
//   npm run seed:dev -- --reset delete the development database first
const fs = require('node:fs');
const crypto = require('node:crypto');
const sharp = require('sharp');
const config = require('../server/config');

if (config.isProd) {
  console.error('Refusing to seed: NODE_ENV is production.');
  process.exit(1);
}
if (process.argv.includes('--reset')) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.databaseFile + suffix, { force: true });
  for (const dir of [config.storage.gowns, config.storage.private]) {
    for (const f of fs.readdirSync(dir)) fs.rmSync(`${dir}/${f}`, { force: true });
  }
  console.log('Development database and stored images removed.');
}

const db = require('../server/db');
const auth = require('../server/lib/auth');
const images = require('../server/lib/images');
const { uniqueSlug } = require('../server/lib/util');

// Typographic test plates — deliberately not pictures of gowns.
function plateSvg({ w, h, bg, fg, label, transparent = false }) {
  const shape = transparent
    ? `<path d="M${w * 0.42} ${h * 0.06} h${w * 0.16} l${w * 0.04} ${h * 0.3} l${w * 0.26} ${h * 0.6} h-${w * 0.76} l${w * 0.26} -${h * 0.6} z" fill="${bg}"/>`
    : `<rect width="100%" height="100%" fill="${bg}"/>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    ${shape}
    <g fill="none" stroke="${fg}" stroke-opacity=".35"><rect x="${w * 0.06}" y="${h * 0.04}" width="${w * 0.88}" height="${h * 0.92}"/></g>
    <text x="50%" y="${transparent ? 70 : 50}%" text-anchor="middle" font-family="Georgia, serif" font-size="${Math.round(w / 11)}" fill="${fg}" font-style="italic">${label}</text>
    <text x="50%" y="${transparent ? 76 : 56}%" text-anchor="middle" font-family="Arial, sans-serif" font-size="${Math.round(w / 34)}" letter-spacing="6" fill="${fg}">SAMPLE PLATE · DEVELOPMENT ONLY</text>
    <text x="50%" y="${transparent ? 80 : 60}%" text-anchor="middle" font-family="Arial, sans-serif" font-size="${Math.round(w / 40)}" fill="${fg}" fill-opacity=".7">${w} × ${h}</text>
  </svg>`);
}

async function addImage(gownId, opts, meta) {
  const png = await sharp(plateSvg(opts)).png().toBuffer();
  const stored = await images.storeGownImage(png);
  let cut = {};
  if (opts.transparent) {
    // Simulates a background-removed image so cut-out layouts can be checked.
    const dims = await images.writeDerivatives(png, config.storage.gowns, stored.key, { suffix: '-cut', alpha: true });
    cut = { has_cutout: 1, cut_width: dims.width, cut_height: dims.height, presentation: 'cutout' };
  }
  db.run(
    `INSERT INTO gown_images (gown_id, file_key, kind, width, height, is_main, sort_order, alt, caption, has_cutout, cut_width, cut_height, presentation, backdrop)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    gownId, stored.key, meta.kind || 'look', stored.width, stored.height, meta.main ? 1 : 0, meta.order || 0,
    'Sample plate (development)', meta.caption || null, cut.has_cutout || 0, cut.cut_width || null, cut.cut_height || null,
    cut.presentation || 'frame', meta.backdrop || 'bone');
}

const PALETTE = [
  ['#e9e1d4', '#161311'], ['#d6c3ad', '#161311'], ['#2a2521', '#efe9df'], ['#5d5f4b', '#efe9df'],
  ['#e6d2c9', '#161311'], ['#cfc6b8', '#161311'], ['#8c8073', '#f7f3ec'],
];

async function main() {
  db.open();
  db.migrate({ log: () => {} });

  const cats = ['Bridal', 'Debut', 'Evening'].map((name, i) => {
    db.run('INSERT OR IGNORE INTO categories (name, slug, sort_order) VALUES (?, ?, ?)', `${name} (sample)`, uniqueSlug(`${name}-sample`, 'categories'), i);
    return db.one('SELECT id FROM categories WHERE name = ?', `${name} (sample)`).id;
  });

  const shapes = [
    { w: 1200, h: 1650 }, { w: 1200, h: 1500 }, { w: 1600, h: 1100 }, { w: 1100, h: 1600 },
    { w: 1200, h: 1700 }, { w: 1200, h: 1200 }, { w: 1100, h: 1500 }, { w: 1300, h: 1700 },
  ];
  for (let i = 0; i < 8; i++) {
    const n = String(i + 1).padStart(2, '0');
    const name = `Sample No. ${n}`;
    const rent = i % 4 !== 3;
    const buy = i % 3 === 0;
    const { lastInsertRowid } = db.run(
      `INSERT INTO gowns (slug, name, description, category_id, sizes, color, design_details, offer_rental, offer_purchase, offer_custom,
         rental_price, rental_period_days, purchase_price, security_deposit, listing_status, availability_status, featured, sort_order, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', 'available', ?, ?, ?)`,
      uniqueSlug(name, 'gowns'), name,
      'Development sample — not a real listing. Replace with Kyla’s gowns before launch.',
      cats[i % 3], i % 2 ? 'S, M' : 'M', 'Sample colour', 'Sample details for layout testing.',
      rent ? 1 : 0, buy ? 1 : 0, i % 2 ? 1 : 0,
      rent ? 100000 + i * 25000 : null, rent ? 3 : null, buy ? 1500000 + i * 100000 : null, rent && i % 2 === 0 ? 200000 : null,
      i === 0 ? 1 : 0, i, new Date().toISOString());
    const gid = Number(lastInsertRowid);
    db.run('INSERT INTO gown_units (gown_id, label) VALUES (?, ?)', gid, 'Piece 1');
    if (i === 1) db.run('INSERT INTO gown_units (gown_id, label) VALUES (?, ?)', gid, 'Piece 2');
    const [bg, fg] = PALETTE[i % PALETTE.length];
    await addImage(gid, { ...shapes[i], bg, fg, label: name, transparent: i === 0 || i === 4 }, { main: true, backdrop: i === 0 ? 'ink' : 'clay' });
    await addImage(gid, { w: 1200, h: 1200, bg: PALETTE[(i + 2) % 7][0], fg: PALETTE[(i + 2) % 7][1], label: 'Detail' }, { kind: 'detail', order: 2, caption: `${name} — detail` });
  }

  const pw = (label) => {
    const p = crypto.randomBytes(9).toString('base64url');
    console.log(`  ${label.padEnd(9)} password: ${p}`);
    return p;
  };
  console.log('Development accounts (passwords are random and shown only now):');
  for (const [email, role, name] of [['studio@dev.local', 'admin', 'Kyla (dev)'], ['customer@dev.local', 'customer', 'Test Customer']]) {
    const hash = await auth.hashPassword(pw(role));
    db.run(`INSERT INTO users (email, password_hash, role, full_name) VALUES (?, ?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash`, email, hash, role, name);
    console.log(`  ${email}`);
  }
  console.log('Sample listings created. Database:', config.databaseFile);
  db.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
