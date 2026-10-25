// Studio settings editable by Kyla in /studio/settings.
// Defaults only contain information verified from the official Facebook page;
// everything else starts empty and is hidden on the site until she fills it in.
const db = require('../db');

const DEFAULTS = {
  brand_name: 'Tailored by Kyla',
  location: 'Pakil',
  facebook_url: 'https://www.facebook.com/people/Tailored-by-Kyla/61592753177313/',
  messenger_url: '',
  instagram_url: '',
  contact_email: '',
  contact_phone: '',
  studio_hours: '',
  about_heading: '',
  about_text: '',
  hero_line: 'Made for your moment.',
  rental_terms: '',
  purchase_terms: '',
  custom_terms: '',
  payment_instructions: '',
  // Days between a return and the next pickup of the same piece (cleaning, pressing).
  turnaround_days: '0',
  // Minimum days before the event a customer may still cancel a confirmed rental online. Empty = contact Kyla.
  rental_cancel_days: '',
  // When "1", an approved rental waits for Kyla to record the deposit before it is confirmed.
  deposit_before_confirm: '1',
  // How far ahead customers may request a rental.
  booking_horizon_days: '365',
  // Shown on listing pages when a gown has no photograph yet.
  show_unphotographed: '1',
};

let cache = null;

function all() {
  if (cache) return cache;
  const rows = db.all('SELECT key, value FROM settings');
  cache = { ...DEFAULTS };
  for (const r of rows) cache[r.key] = r.value ?? '';
  return cache;
}

function get(key) {
  return all()[key];
}

function setMany(values) {
  db.tx((d) => {
    const stmt = d.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(values)) {
      if (k in DEFAULTS) stmt.run(k, v == null ? '' : String(v));
    }
  });
  cache = null;
}

function invalidate() { cache = null; }

module.exports = { DEFAULTS, all, get, setMany, invalidate };
