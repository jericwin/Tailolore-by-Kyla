// Calendar-date helpers. Event, pickup and return dates are plain 'YYYY-MM-DD'
// strings interpreted in Manila time, so no timezone arithmetic is needed on them.
const config = require('../config');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Today's date in Manila. */
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

function addDays(s, n) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Inclusive number of days between two dates. */
function spanDays(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5) + 1;
}

function daysUntil(s) {
  return spanDays(today(), s) - 1;
}

const longFmt = new Intl.DateTimeFormat('en-PH', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortFmt = new Intl.DateTimeFormat('en-PH', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const stampFmt = new Intl.DateTimeFormat('en-PH', {
  day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: config.timezone,
});

function formatDate(s, style = 'long') {
  if (!s) return '';
  if (!isValidDate(String(s).slice(0, 10))) return String(s);
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
  return (style === 'short' ? shortFmt : longFmt).format(d);
}

function formatStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : stampFmt.format(d);
}

module.exports = { isValidDate, today, addDays, spanDays, daysUntil, formatDate, formatStamp };
