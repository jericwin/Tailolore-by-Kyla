// Rental availability. A rental occupies its unit from pickup to return plus
// the studio's turnaround days. Manual blocks occupy exactly their range.
// All checks used for decisions run inside a write transaction (db.tx).
const db = require('../db');
const settings = require('./settings');
const { RENTAL_HOLDING } = require('./status');
const { addDays, today } = require('./dates');

const HOLDING_SQL = RENTAL_HOLDING.map((s) => `'${s}'`).join(', ');

function turnaround() {
  const n = Number(settings.get('turnaround_days'));
  return Number.isInteger(n) && n >= 0 && n <= 30 ? n : 0;
}

/**
 * Returns the id of an active unit that is free from pickup to return (inclusive),
 * or null. excludeRentalId lets an existing rental be re-checked against others.
 */
function findFreeUnit(gownId, pickup, ret, { excludeRentalId = 0, preferUnitId = null } = {}) {
  const t = turnaround();
  const newEnd = addDays(ret, t);
  const units = db.all(
    `SELECT u.id FROM gown_units u
      WHERE u.gown_id = ? AND u.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM rentals r
           WHERE r.unit_id = u.id AND r.id <> ? AND r.status IN (${HOLDING_SQL})
             AND r.pickup_date <= ? AND date(r.return_date, ?) >= ?)
        AND NOT EXISTS (
          SELECT 1 FROM availability_blocks b
           WHERE b.gown_id = u.gown_id AND (b.unit_id IS NULL OR b.unit_id = u.id)
             AND b.start_date <= ? AND b.end_date >= ?)
      ORDER BY u.id`,
    gownId, excludeRentalId, newEnd, `+${t} days`, pickup, ret, pickup);
  if (!units.length) return null;
  if (preferUnitId && units.some((u) => u.id === preferUnitId)) return preferUnitId;
  return units[0].id;
}

/**
 * Days (YYYY-MM-DD) in [from, to] on which no unit of the gown could be picked up.
 * Exposes no customer information — only dates.
 */
function unavailableDays(gownId, from, to) {
  const t = turnaround();
  const units = db.all("SELECT id FROM gown_units WHERE gown_id = ? AND status = 'active'", gownId);
  const days = [];
  if (!units.length) {
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    return days;
  }
  const busy = new Map(units.map((u) => [u.id, new Set()]));
  const mark = (unitId, start, end) => {
    const set = busy.get(unitId);
    if (!set) return;
    for (let d = start < from ? from : start; d <= end && d <= to; d = addDays(d, 1)) set.add(d);
  };
  const rentals = db.all(
    `SELECT unit_id, pickup_date, return_date FROM rentals
      WHERE gown_id = ? AND unit_id IS NOT NULL AND status IN (${HOLDING_SQL})
        AND date(return_date, ?) >= ? AND pickup_date <= ?`, gownId, `+${t} days`, from, to);
  for (const r of rentals) mark(r.unit_id, r.pickup_date, addDays(r.return_date, t));
  const blocks = db.all(
    'SELECT unit_id, start_date, end_date FROM availability_blocks WHERE gown_id = ? AND end_date >= ? AND start_date <= ?',
    gownId, from, to);
  for (const b of blocks) {
    if (b.unit_id) mark(b.unit_id, b.start_date, b.end_date);
    else for (const u of units) mark(u.id, b.start_date, b.end_date);
  }
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (units.every((u) => busy.get(u.id).has(d))) days.push(d);
  }
  return days;
}

/** Whether a gown can take rental requests at all, independent of dates. */
function rentable(gown) {
  return !!(gown && gown.offer_rental && gown.rental_price != null && gown.listing_status === 'published'
    && !['sold', 'unavailable'].includes(gown.availability_status));
}

function purchasable(gown) {
  return !!(gown && gown.offer_purchase && gown.purchase_price != null && gown.listing_status === 'published'
    && ['available', 'reserved'].includes(gown.availability_status)
    && db.one("SELECT COUNT(*) AS n FROM gown_units WHERE gown_id = ? AND status = 'active'", gown.id).n > 0);
}

/** Validates a requested rental window against the listing's rules. Returns an error map. */
function checkWindow(gown, { event_date, pickup_date, return_date }) {
  const errors = {};
  const t = today();
  const horizon = addDays(t, Number(settings.get('booking_horizon_days')) || 365);
  if (pickup_date && pickup_date < t) errors.pickup_date = 'Pickup can’t be in the past.';
  if (event_date && event_date > horizon) errors.event_date = 'That date is beyond the current booking calendar. Please message Kyla.';
  if (pickup_date && event_date && pickup_date > event_date) errors.pickup_date = 'Pickup must be on or before the event.';
  if (return_date && event_date && return_date < event_date) errors.return_date = 'Return must be on or after the event.';
  if (!Object.keys(errors).length && gown.rental_period_days && pickup_date && return_date) {
    const span = Math.round((Date.parse(return_date) - Date.parse(pickup_date)) / 864e5) + 1;
    if (span > gown.rental_period_days) {
      errors.return_date = `This gown is rented for up to ${gown.rental_period_days} day${gown.rental_period_days > 1 ? 's' : ''}, pickup to return.`;
    }
  }
  return errors;
}

/** Recomputes the gown's display availability from its units and current rentals. */
function refreshGownAvailability(gownId) {
  const gown = db.one('SELECT availability_status FROM gowns WHERE id = ?', gownId);
  if (!gown || gown.availability_status === 'unavailable') return;
  const counts = db.one(
    `SELECT SUM(status = 'active') AS active, SUM(status = 'reserved_sale') AS reserved,
            SUM(status = 'sold') AS sold, COUNT(*) AS total FROM gown_units WHERE gown_id = ?`, gownId);
  let next = 'available';
  if (counts.total > 0 && counts.active === 0) next = counts.reserved > 0 ? 'reserved' : 'sold';
  else if (counts.active > 0) {
    const out = db.one(
      `SELECT COUNT(DISTINCT unit_id) AS n FROM rentals WHERE gown_id = ? AND status = 'picked_up'`, gownId).n;
    if (out >= counts.active) next = 'rented';
  }
  if (next !== gown.availability_status) {
    db.run('UPDATE gowns SET availability_status = ?, updated_at = ? WHERE id = ?', next, new Date().toISOString(), gownId);
  }
}

module.exports = { findFreeUnit, unavailableDays, rentable, purchasable, checkWindow, refreshGownAvailability, turnaround };
