const crypto = require('node:crypto');
const db = require('../db');

// Unambiguous characters for references people read out over the phone.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Human-friendly unique reference, e.g. RN-2610-7KQ4. */
function reference(prefix, table) {
  const now = new Date();
  const ym = `${String(now.getUTCFullYear()).slice(2)}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  for (let i = 0; i < 20; i++) {
    const bytes = crypto.randomBytes(4);
    const code = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
    const ref = `${prefix}-${ym}-${code}`;
    if (!db.one(`SELECT 1 FROM ${table} WHERE reference = ?`, ref)) return ref;
  }
  throw new Error('Could not allocate a reference');
}

function slugify(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'gown';
}

function uniqueSlug(name, table, exceptId = 0) {
  const base = slugify(name);
  let slug = base;
  for (let i = 2; db.one(`SELECT 1 FROM ${table} WHERE slug = ? AND id <> ?`, slug, exceptId); i++) slug = `${base}-${i}`;
  return slug;
}

const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** Centavos → "₱12,500". Returns '' for null so missing prices are never shown as ₱0. */
function money(centavos) {
  if (centavos === null || centavos === undefined || centavos === '') return '';
  return peso.format(Number(centavos) / 100);
}

/** Centavos → "12500" for form inputs. */
function moneyInput(centavos) {
  if (centavos === null || centavos === undefined) return '';
  const v = Number(centavos) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function parseJson(s, fallback = null) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/** Only allow redirects to local paths. */
function safeNext(next, fallback = '/') {
  const s = String(next || '');
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : fallback;
}

module.exports = { reference, slugify, uniqueSlug, money, moneyInput, parseJson, safeNext };
