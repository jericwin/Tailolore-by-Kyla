// Gown queries shared by the public site, customer area and studio.
const db = require('../db');
const images = require('../lib/images');
const { parseJson } = require('../lib/util');
const availability = require('../lib/availability');

const MEASUREMENT_FIELDS = [
  ['bust', 'Bust'], ['waist', 'Waist'], ['hips', 'Hips'], ['length', 'Length'], ['notes', 'Notes'],
];

/**
 * Adds display URLs for the chosen presentation:
 *   studio — the cut-out on the shared ivory canvas (the house look)
 *   cutout — the cut-out on a coloured backdrop chosen by Kyla
 *   frame  — the original photograph
 * Falls back to the original when the processed version doesn't exist.
 */
function decorateImage(img) {
  let variant = 'frame';
  if (img.presentation === 'studio' && img.has_studio) variant = 'studio';
  else if (img.presentation === 'cutout' && img.has_cutout) variant = 'cut';
  const dims = {
    frame: [img.width, img.height],
    cut: [img.cut_width, img.cut_height],
    studio: [images.STUDIO.width, images.STUDIO.height],
  }[variant];
  const [w, h] = dims;
  return {
    ...img,
    variant,
    useCut: variant === 'cut',
    useStudio: variant === 'studio',
    displayWidth: w,
    displayHeight: h,
    ratio: w && h ? h / w : 4 / 3,
    orientation: !w || !h ? 'portrait' : h / w > 1.15 ? 'portrait' : h / w < 0.87 ? 'landscape' : 'square',
    src: images.src(img.file_key, 960, { variant }),
    srcLarge: images.src(img.file_key, 2400, { variant }),
    srcset: images.srcset(img.file_key, w, { variant }),
    // Original photograph, always available (lightbox and studio comparisons).
    frameSrc: images.src(img.file_key, 960),
    frameLarge: images.src(img.file_key, 2400),
    frameSrcset: images.srcset(img.file_key, img.width),
    cutSrc: img.has_cutout ? images.src(img.file_key, 960, { variant: 'cut' }) : null,
    studioSrc: img.has_studio ? images.src(img.file_key, 960, { variant: 'studio' }) : null,
  };
}

function decorate(g, imgs) {
  if (!g) return null;
  const list = (imgs || []).map(decorateImage);
  const main = list.find((i) => i.is_main) || list[0] || null;
  const measurements = parseJson(g.measurements, {}) || {};
  return {
    ...g,
    images: list,
    main,
    measurements,
    measurementList: MEASUREMENT_FIELDS.filter(([k]) => measurements[k]).map(([k, label]) => ({ key: k, label, value: measurements[k] })),
    canRent: availability.rentable(g),
    canBuy: availability.purchasable(g),
    canCustom: !!g.offer_custom && g.listing_status === 'published',
    services: [g.offer_rental && 'rent', g.offer_purchase && 'buy', g.offer_custom && 'custom'].filter(Boolean),
  };
}

function imagesFor(ids) {
  if (!ids.length) return new Map();
  const rows = db.all(
    `SELECT * FROM gown_images WHERE gown_id IN (${ids.map(() => '?').join(',')})
      ORDER BY gown_id, is_main DESC, sort_order, id`, ...ids);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.gown_id)) map.set(r.gown_id, []);
    map.get(r.gown_id).push(r);
  }
  return map;
}

const BASE_SELECT = `SELECT g.*, c.name AS category_name, c.slug AS category_slug, c.section AS category_section
  FROM gowns g LEFT JOIN categories c ON c.id = g.category_id`;

function byId(id) {
  const g = db.one(`${BASE_SELECT} WHERE g.id = ?`, id);
  return g ? decorate(g, imagesFor([g.id]).get(g.id)) : null;
}

function bySlug(slug, { publishedOnly = true } = {}) {
  const g = db.one(`${BASE_SELECT} WHERE g.slug = ? ${publishedOnly ? "AND g.listing_status = 'published'" : ''}`, slug);
  return g ? decorate(g, imagesFor([g.id]).get(g.id)) : null;
}

/**
 * Published gowns with optional filters:
 * category (slug), service (rent|buy|custom), availability (available|…).
 */
function catalog({ category, section, service, availability: avail, featured, limit } = {}) {
  const where = ["g.listing_status = 'published'"];
  const params = [];
  if (category) { where.push('c.slug = ?'); params.push(category); }
  if (section) { where.push("COALESCE(c.section, 'gowns') = ?"); params.push(section); }
  if (service === 'rent') where.push('g.offer_rental = 1 AND g.rental_price IS NOT NULL');
  if (service === 'buy') where.push('g.offer_purchase = 1 AND g.purchase_price IS NOT NULL');
  if (service === 'custom') where.push('g.offer_custom = 1');
  if (avail) { where.push('g.availability_status = ?'); params.push(avail); }
  if (featured) where.push('g.featured = 1');
  const sql = `${BASE_SELECT} WHERE ${where.join(' AND ')}
    ORDER BY g.featured DESC, g.sort_order, COALESCE(g.published_at, g.created_at) DESC
    ${limit ? `LIMIT ${Number(limit)}` : ''}`;
  const rows = db.all(sql, ...params);
  const imgs = imagesFor(rows.map((r) => r.id));
  return rows.map((r) => decorate(r, imgs.get(r.id)));
}

/** Every public photograph, for the gallery. */
function galleryImages({ category, kind } = {}) {
  const where = ["g.listing_status = 'published'"];
  const params = [];
  if (category) { where.push('c.slug = ?'); params.push(category); }
  if (kind) { where.push('i.kind = ?'); params.push(kind); }
  return db.all(
    `SELECT i.*, g.name AS gown_name, g.slug AS gown_slug, c.name AS category_name, c.slug AS category_slug
       FROM gown_images i JOIN gowns g ON g.id = i.gown_id LEFT JOIN categories c ON c.id = g.category_id
      WHERE ${where.join(' AND ')}
      ORDER BY g.featured DESC, g.sort_order, i.is_main DESC, i.sort_order, i.id`, ...params).map(decorateImage);
}

function categories({ withPublishedOnly = false } = {}) {
  if (!withPublishedOnly) return db.all('SELECT * FROM categories ORDER BY sort_order, name');
  return db.all(
    `SELECT c.*, COUNT(g.id) AS gown_count FROM categories c
       JOIN gowns g ON g.category_id = c.id AND g.listing_status = 'published'
      GROUP BY c.id ORDER BY c.sort_order, c.name`);
}

module.exports = { byId, bySlug, catalog, galleryImages, categories, decorate, decorateImage, imagesFor, MEASUREMENT_FIELDS };
