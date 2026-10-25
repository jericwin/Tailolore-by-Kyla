const express = require('express');
const db = require('../db');
const gowns = require('../models/gowns');
const showcase = require('../models/showcase');
const availability = require('../lib/availability');
const { today, addDays, isValidDate } = require('../lib/dates');
const { HttpError } = require('../lib/errors');
const settings = require('../lib/settings');

const router = express.Router();

const SERVICES = { rent: 'To rent', buy: 'To buy', custom: 'Made to order' };
const AVAIL_FILTERS = { available: 'Available now', reserved: 'Reserved', rented: 'Currently rented', sold: 'Sold' };

const SECTIONS = {
  gowns: { label: 'Women’s gowns', line: 'Evening and pageant gowns' },
  menswear: { label: 'Menswear', line: 'Formal sets for pageants and occasions' },
  costumes: { label: 'Costumes', line: 'Statement and heritage-inspired pieces' },
  other: { label: 'Other pieces', line: '' },
};

/** Collection sections that actually contain published pieces, with a few pictures each. */
function sectionsWithPieces(all) {
  return Object.entries(SECTIONS).map(([key, s]) => {
    const pieces = all.filter((g) => (g.category_section || 'gowns') === key);
    return { key, ...s, count: pieces.length, images: pieces.filter((g) => g.main).slice(0, 3).map((g) => g.main) };
  }).filter((s) => s.count);
}

router.get('/', (req, res) => {
  const all = gowns.catalog();
  const curated = showcase.forHome();
  const withPhotos = all.filter((g) => g.main);
  // The showcase masterpiece opens the site; without one, the first gown with a photograph.
  const lead = curated.masterpiece || withPhotos[0] || null;
  // On the cover the garment stands on dark ink, so use its transparent cut-out when there is one.
  const cover = lead && lead.main ? coverImage(lead.showImage || lead.main) : null;
  const signature = curated.signature.length
    ? curated.signature
    : withPhotos.filter((g) => g !== lead).slice(0, 6).map((g) => ({ ...g, showImage: g.main }));
  // Close-ups from the showcased gowns are woven into the signature layout,
  // each a few plates after its own gown: G G D G G G D G …
  const closeUps = signature.map((g) => g.detail && { ...g.detail, gown: g }).filter(Boolean).slice(0, 2);
  // Plate numbers continue from the cover (Pl. 01).
  const plates = signature.slice(0, 8).map((g, i) => ({ type: 'gown', gown: g, image: g.showImage, no: i + 2 }));
  [2, 6].forEach((at, k) => { if (closeUps[k] && plates.length >= at) plates.splice(at, 0, { type: 'detail', gown: closeUps[k].gown, image: closeUps[k] }); });
  res.render('public/home.njk', {
    lead, cover, plates,
    leadImage: lead ? lead.showImage || lead.main : null,
    leadDetail: lead ? lead.detail || (lead.images || []).find((i) => i.kind === 'detail') || null : null,
    sections: sectionsWithPieces(all),
    totalGowns: all.length,
    names: all.map((g) => g.name),
  });
});

function coverImage(img) {
  if (!img.has_cutout) return img;
  return gowns.decorateImage({ ...img, presentation: 'cutout', backdrop: 'ink' });
}

router.get('/collection', (req, res) => {
  const filters = {
    section: SECTIONS[req.query.section] ? req.query.section : '',
    category: typeof req.query.category === 'string' ? req.query.category : '',
    service: SERVICES[req.query.service] ? req.query.service : '',
    availability: AVAIL_FILTERS[req.query.availability] ? req.query.availability : '',
  };
  const list = gowns.catalog(filters);
  const wish = req.user
    ? new Set(db.all('SELECT gown_id FROM wishlist WHERE user_id = ?', req.user.id).map((r) => r.gown_id))
    : new Set();
  const cats = gowns.categories({ withPublishedOnly: true });
  res.render('public/collection.njk', {
    gowns: list.map((g) => ({ ...g, wished: wish.has(g.id) })),
    filters,
    // Within a section, only that section's categories are offered.
    categories: filters.section ? cats.filter((c) => c.section === filters.section) : cats,
    sections: sectionsWithPieces(gowns.catalog()),
    SECTIONS,
    SERVICES,
    AVAIL_FILTERS,
    anyFilter: !!(filters.section || filters.category || filters.service || filters.availability),
  });
});

router.get('/gowns/:slug', (req, res, next) => {
  const gown = gowns.bySlug(req.params.slug);
  if (!gown) return next(new HttpError(404, 'This gown is not in the collection.'));
  renderGown(req, res, gown, { preview: false });
});

function renderGown(req, res, gown, { preview, errors = {}, values = {}, service = null, formError = null, statusCode = 200 }) {
  const related = gown.category_id
    ? gowns.catalog({ category: gown.category_slug }).filter((g) => g.id !== gown.id).slice(0, 3)
    : [];
  const wished = req.user
    ? !!db.one('SELECT 1 FROM wishlist WHERE user_id = ? AND gown_id = ?', req.user.id, gown.id)
    : false;
  const sizes = (gown.sizes || '').split(',').map((s) => s.trim()).filter(Boolean);
  res.status(statusCode).render('public/gown.njk', {
    gown, related, wished, preview, sizes, errors, values, formError,
    minDate: today(),
    maxDate: addDays(today(), Number(settings.get('booking_horizon_days')) || 365),
    service: service || (['rent', 'buy', 'custom'].includes(req.query.service) ? req.query.service : null),
  });
}

router.get('/gallery', (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category : '';
  const kind = ['look', 'detail', 'atelier'].includes(req.query.kind) ? req.query.kind : '';
  res.render('public/gallery.njk', {
    images: gowns.galleryImages({ category, kind }),
    categories: gowns.categories({ withPublishedOnly: true }),
    filters: { category, kind },
    hasDetails: !!db.one(`SELECT 1 FROM gown_images i JOIN gowns g ON g.id = i.gown_id
                           WHERE g.listing_status = 'published' AND i.kind = 'detail' LIMIT 1`),
  });
});

router.get('/atelier', (req, res) => {
  res.render('public/atelier.njk', { totalGowns: gowns.catalog().length });
});

router.get('/commission', (req, res) => {
  const basedOn = typeof req.query.gown === 'string' ? gowns.bySlug(req.query.gown) : null;
  res.render('public/commission.njk', {
    basedOn: basedOn && basedOn.offer_custom ? basedOn : null,
    values: { contact_name: req.user?.fullName, contact_email: req.user?.email, contact_phone: req.user?.phone },
    errors: {},
    minDate: today(),
  });
});

/** Public availability for the date picker: only dates, never who booked them. */
router.get('/api/gowns/:id/availability', (req, res, next) => {
  const gown = db.one("SELECT * FROM gowns WHERE id = ? AND listing_status = 'published'", Number(req.params.id) || 0);
  if (!gown || !availability.rentable(gown)) return next(new HttpError(404, 'Not available for rental.'));
  const from = isValidDate(String(req.query.from)) && req.query.from >= today() ? req.query.from : today();
  const horizon = addDays(today(), Number(settings.get('booking_horizon_days')) || 365);
  let to = isValidDate(String(req.query.to)) ? req.query.to : addDays(from, 120);
  if (to > horizon) to = horizon;
  if (to < from) to = from;
  res.set('Cache-Control', 'no-store');
  res.json({
    from, to, today: today(), horizon,
    periodDays: gown.rental_period_days,
    unavailable: availability.unavailableDays(gown.id, from, to),
  });
});

module.exports = router;
module.exports.renderGown = renderGown;
