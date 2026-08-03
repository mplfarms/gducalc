// src/core/dates.js
//
// Date helpers for this app. EVERY date in the GDU engine is a plain
// "YYYY-MM-DD" string, never a Date object, and every bit of arithmetic
// below routes through Date.UTC / getUTC* rather than the local-time
// constructors.
//
// That is deliberate, not stylistic. `new Date("2026-05-01")` parses as
// UTC midnight, while `new Date(2026, 4, 1)` parses as LOCAL midnight —
// mixing the two, or doing local-time day arithmetic across a daylight
// saving transition, silently shifts a date by one day. This app adds
// ~200 days to a planting date and crosses the March and November DST
// boundaries every single time it runs, so a local-time `+ 86400000`
// loop would drift by a day twice a season. Doing all arithmetic in UTC
// removes the possibility entirely: a UTC day is always exactly
// 86,400,000 ms.
//
// The one place local time legitimately matters is "what is today for
// the user standing in the field" — see todayIso(), which reads the
// browser's local calendar date and then immediately drops back into
// the string domain.

const MS_PER_DAY = 86400000;

/**
 * @param {string} iso "YYYY-MM-DD"
 * @returns {number} epoch ms at UTC midnight of that date
 */
export function isoToUtcMs(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * @param {number} ms epoch ms
 * @returns {string} "YYYY-MM-DD"
 */
export function utcMsToIso(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/**
 * @param {string} iso
 * @param {number} days may be negative
 * @returns {string} "YYYY-MM-DD"
 */
export function addDays(iso, days) {
  const ms = isoToUtcMs(iso);
  if (!Number.isFinite(ms)) return "";
  return utcMsToIso(ms + days * MS_PER_DAY);
}

/**
 * Whole days from `a` to `b` (positive when b is later).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function daysBetween(a, b) {
  return Math.round((isoToUtcMs(b) - isoToUtcMs(a)) / MS_PER_DAY);
}

/** @returns {string} today's LOCAL calendar date as "YYYY-MM-DD" */
export function todayIso() {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const da = String(now.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/** @param {string} iso @returns {number} 4-digit year */
export function yearOf(iso) {
  return Number(String(iso).slice(0, 4));
}

/** @param {string} iso @returns {string} "MM-DD" */
export function monthDayOf(iso) {
  return String(iso).slice(5, 10);
}

/**
 * Rebuilds an ISO date with the same month/day in a different year.
 * Returns null for Feb 29 in a non-leap year — the caller decides
 * whether to skip that year or slide the date, rather than this
 * silently rolling over to March 1 the way Date's own constructor
 * would.
 * @param {string} monthDay "MM-DD"
 * @param {number} year
 * @returns {string|null}
 */
export function isoForYear(monthDay, year) {
  const iso = `${year}-${monthDay}`;
  const ms = isoToUtcMs(iso);
  if (!Number.isFinite(ms)) return null;
  // Round-trip check catches Feb 29 in a non-leap year (Date.UTC would
  // happily hand back March 1).
  return utcMsToIso(ms) === iso ? iso : null;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Human-readable short form, e.g. "Jul 18" or "Jul 18, 2025".
 * @param {string} iso
 * @param {{withYear?: boolean}} [opts]
 * @returns {string}
 */
export function formatShort(iso, opts) {
  const ms = isoToUtcMs(iso);
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const base = `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return opts && opts.withYear ? `${base}, ${d.getUTCFullYear()}` : base;
}
