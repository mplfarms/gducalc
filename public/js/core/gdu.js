// src/core/gdu.js
//
// The GDU engine. Pure functions only — no fetch, no DOM, no globals —
// so every number this app puts on screen can be unit-tested against
// hand-worked examples (see test/unit_gdu.mjs).
//
// ---------------------------------------------------------------
// The formula
// ---------------------------------------------------------------
// Corn GDUs (a.k.a. GDDs, heat units) use the "modified growing degree
// day" method, base 50 °F with an 86 °F upper cutoff — the same method
// every US seed company rates its hybrids on, so a hybrid's published
// "GDUs to black layer" is directly comparable to what this computes:
//
//   Thigh = clamp(daily max temp, 50, 86)
//   Tlow  = clamp(daily min temp, 50, 86)
//   GDU   = (Thigh + Tlow) / 2 - 50
//
// Clamping BOTH ends to [50, 86] is what makes this the *modified*
// method and is the part most often gotten wrong. Two consequences
// worth stating plainly, because they surprise people looking at the
// output:
//   * A day that never gets above 50 °F contributes exactly 0 — not a
//     negative number. Corn does not un-develop on a cold day.
//   * A 100 °F day contributes no more than a 86 °F day (max 36 GDU).
//     Corn's development rate plateaus; heat beyond 86 °F stresses the
//     plant rather than speeding it up. This is why a blistering July
//     adds fewer GDUs than people expect.
//
// ---------------------------------------------------------------
// Accumulation window
// ---------------------------------------------------------------
// Accumulation starts ON the planting date (the planting day's own GDUs
// are counted), matching Iowa State's and the Iowa Environmental
// Mesonet's convention. This is a real choice, not an accident: the
// alternative (start the day after) runs ~15-25 GDU lower for the whole
// season, which is under a day of development but IS a visible
// difference if someone cross-checks this against a tool that made the
// other choice. It's stated on the Method card in the app for exactly
// that reason.

export const GDU_BASE_F = 50;
export const GDU_CAP_F = 86;

/** Max GDUs a single day can contribute — (86+86)/2-50. Used for sanity checks. */
export const GDU_MAX_PER_DAY = (GDU_CAP_F + GDU_CAP_F) / 2 - GDU_BASE_F; // 36

/**
 * Modified growing degree days for one day, base 50 / cap 86, in °F.
 * @param {number|null} tmaxF
 * @param {number|null} tminF
 * @returns {number|null} null when either input is missing/non-finite —
 *   callers must decide what a data gap means rather than having a
 *   silent 0 quietly depress a season total.
 */
export function dailyGdu(tmaxF, tminF) {
  if (tmaxF === null || tmaxF === undefined || tminF === null || tminF === undefined) return null;
  const a = Number(tmaxF);
  const b = Number(tminF);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  // Defensive: a reanalysis/forecast row with min > max is nonsense, but
  // it would silently produce the same answer either way once both are
  // clamped and averaged. Ordering them makes that explicit rather than
  // accidental.
  const hi = clamp(Math.max(a, b), GDU_BASE_F, GDU_CAP_F);
  const lo = clamp(Math.min(a, b), GDU_BASE_F, GDU_CAP_F);
  return (hi + lo) / 2 - GDU_BASE_F;
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * @typedef {Object} DayRecord
 * @property {number|null} tmax  daily max, °F
 * @property {number|null} tmin  daily min, °F
 * @property {number|null} gdu   modified GDU for the day
 * @property {"observed"|"forecast"} source
 */

/**
 * Builds the date-keyed record map every other function here consumes.
 *
 * LATER SOURCES WIN on a duplicate date, so pass them in ascending order
 * of trust: forecast first, observed history second. The forecast API's
 * first day is "today", which the archive also covers, and the observed
 * value is the better of the two — passing observed last is what makes
 * it win. (Getting this backwards is not a crash, it is a silent ~0.5
 * GDU error on a single day, which is exactly the kind of thing that
 * survives review; it was caught by cross-checking a live run against an
 * independent calculation.)
 * @param {Array<{time: string[], tmax: (number|null)[], tmin: (number|null)[], source: "observed"|"forecast"}>} series
 * @returns {Object<string, DayRecord>} keyed by "YYYY-MM-DD"
 */
export function buildDailyIndex(series) {
  /** @type {Object<string, DayRecord>} */
  const index = {};
  for (const s of series || []) {
    const times = (s && s.time) || [];
    for (let i = 0; i < times.length; i++) {
      const tmax = s.tmax ? s.tmax[i] : null;
      const tmin = s.tmin ? s.tmin[i] : null;
      const gdu = dailyGdu(tmax, tmin);
      // A row with no usable temperature is skipped entirely rather than
      // stored as a null-GDU day: storing it would let it overwrite a
      // GOOD value already present from an earlier source (the archive
      // trails "today" by a few hours some mornings and can hand back a
      // null tail), which is the opposite of what the caller wants.
      if (gdu === null) continue;
      index[times[i]] = { tmax, tmin, gdu, source: s.source || "observed" };
    }
  }
  return index;
}

/**
 * Cumulative GDU by day-offset from a start date.
 * @param {Object<string, DayRecord>} index
 * @param {string} startIso planting date (counted — see file header)
 * @param {number} days how many day-offsets to return (0 .. days-1)
 * @param {(iso: string, offset: number) => string} addDaysFn injected to
 *   keep this module free of any import (dates.js is passed in by the
 *   caller) — see callers in season.js.
 * @returns {{cum: (number|null)[], complete: boolean, lastCompleteOffset: number}}
 *   `cum[i]` is total GDU from startIso through startIso+i inclusive, or
 *   null once the data runs out. `complete` is true only if every day in
 *   the window had data.
 */
export function accumulate(index, startIso, days, addDaysFn) {
  const cum = new Array(days).fill(null);
  let total = 0;
  let lastCompleteOffset = -1;
  let broke = false;
  for (let i = 0; i < days; i++) {
    const iso = addDaysFn(startIso, i);
    const rec = index[iso];
    if (!rec || rec.gdu === null) {
      broke = true;
      continue; // leave nulls from here on; do not carry a stale total forward
    }
    if (broke) continue; // a gap mid-window invalidates everything after it
    total += rec.gdu;
    cum[i] = total;
    lastCompleteOffset = i;
  }
  return { cum, complete: lastCompleteOffset === days - 1, lastCompleteOffset };
}

/**
 * Linear-interpolation percentile (the same definition as numpy's
 * default and Excel's PERCENTILE.INC), so a "90th percentile" quoted
 * from this app matches what someone gets checking it in a spreadsheet.
 * @param {number[]} values unsorted; must be non-empty
 * @param {number} p 0..1
 * @returns {number|null}
 */
export function percentile(values, p) {
  const sorted = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (sorted.length - 1) * clamp(p, 0, 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * Percentile envelope of cumulative GDU accumulated from the same
 * calendar date (MM-DD) across many years.
 *
 * This one function serves both of the app's envelope needs:
 *   * "what does a normal/hot/cool season look like from planting" —
 *     anchor at the planting date's MM-DD;
 *   * "how much more heat is left after today" — anchor at today's
 *     MM-DD (see season.js's projection splice).
 *
 * Percentiles are taken across YEARS at each day-offset independently.
 * The resulting P90 curve is therefore not any single real year — it is
 * the 90th-percentile accumulation level at each point in the season.
 * That is the correct thing to draw for "an abnormally hot year", and
 * it stays monotonically non-decreasing (each year's own cumulative
 * curve is non-decreasing, and taking an order statistic pointwise
 * preserves that), so it can never appear to lose heat.
 *
 * A year is dropped entirely if its window is not fully covered by the
 * data, rather than contributing a short curve that would drag the
 * upper offsets down.
 *
 * @param {Object<string, DayRecord>} index
 * @param {string} monthDay "MM-DD"
 * @param {number[]} years
 * @param {number} days window length in days
 * @param {{addDays: Function, isoForYear: Function}} dateFns
 * @returns {{offsets: number[], p10: number[], p50: number[], p90: number[], mean: number[], yearsUsed: number[], perYear: Object<number, number[]>}}
 */
export function envelopeFromCalendarDate(index, monthDay, years, days, dateFns) {
  /** @type {Object<number, number[]>} */
  const perYear = {};
  const yearsUsed = [];
  for (const y of years) {
    const startIso = dateFns.isoForYear(monthDay, y);
    if (!startIso) continue; // Feb 29 in a non-leap year — skip, don't slide
    const { cum, complete } = accumulate(index, startIso, days, dateFns.addDays);
    if (!complete) continue;
    perYear[y] = cum;
    yearsUsed.push(y);
  }

  const offsets = [];
  const p10 = [];
  const p50 = [];
  const p90 = [];
  const mean = [];
  for (let i = 0; i < days; i++) {
    const col = yearsUsed.map((y) => perYear[y][i]);
    offsets.push(i);
    p10.push(percentile(col, 0.1));
    p50.push(percentile(col, 0.5));
    p90.push(percentile(col, 0.9));
    mean.push(col.length ? col.reduce((a, b) => a + b, 0) / col.length : null);
  }
  return { offsets, p10, p50, p90, mean, yearsUsed, perYear };
}

/**
 * First day-offset at which a cumulative curve reaches `target`.
 *
 * Returns the offset of the first day whose END-of-day total is at or
 * above the target — i.e. "the crop hits this stage on this date" — and
 * null if the curve never gets there within the window. Nulls inside
 * the curve (data gap / not-yet-projected tail) terminate the search
 * rather than being skipped, so a crossing is never reported from the
 * far side of a hole in the data.
 * @param {(number|null)[]} cum
 * @param {number} target
 * @returns {number|null}
 */
export function offsetAtTarget(cum, target) {
  if (!Number.isFinite(target)) return null;
  for (let i = 0; i < cum.length; i++) {
    const v = cum[i];
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    if (v >= target) return i;
  }
  return null;
}

/**
 * Average daily high and low across a run of days, for the stretch the
 * crop spent in one growth stage.
 *
 * OBSERVED DAYS ONLY. If any day in the span is a forecast day, or is
 * missing from the index at all, this returns null and the caller shows
 * nothing. That is deliberate and it is the whole design of this
 * function: a stage the crop has not finished living through does not
 * have an average temperature yet, and averaging the part that HAS
 * happened would print a number under a label claiming to describe the
 * whole stage. A blank is honest; a partial average dressed as a full
 * one is not.
 *
 * Returns the mean of the daily maxima and the mean of the daily minima
 * rather than a single 24-hour mean, because the single mean hides the
 * two things that matter agronomically: a 78 °F average is a benign
 * 88/68 week, a pollination-scorching 95/61, or a 86/70 stretch of warm
 * nights burning sugars through grain fill.
 *
 * @param {Object<string, DayRecord>} index
 * @param {string} startIso the planting date offsets are measured from
 * @param {number} firstOffset first day of the stage, inclusive
 * @param {number} lastOffset last day of the stage, inclusive
 * @param {(iso: string, offset: number) => string} addDaysFn
 * @returns {{avgHigh: number, avgLow: number, days: number}|null}
 */
export function bandMeanTemps(index, startIso, firstOffset, lastOffset, addDaysFn) {
  if (!Number.isFinite(firstOffset) || !Number.isFinite(lastOffset)) return null;
  if (lastOffset < firstOffset) return null;
  let hiSum = 0;
  let loSum = 0;
  let n = 0;
  for (let i = firstOffset; i <= lastOffset; i++) {
    const rec = index[addDaysFn(startIso, i)];
    if (!rec) return null;
    // Anything not measured is not history. buildDailyIndex tags the
    // 16-day outlook "forecast", so this one check covers both "hasn't
    // happened" and "is only predicted".
    if (rec.source !== "observed") return null;
    if (!Number.isFinite(rec.tmax) || !Number.isFinite(rec.tmin)) return null;
    hiSum += Math.max(rec.tmax, rec.tmin);
    loSum += Math.min(rec.tmax, rec.tmin);
    n++;
  }
  if (n === 0) return null;
  return { avgHigh: hiSum / n, avgLow: loSum / n, days: n };
}

/**
 * Distribution of the first fall freeze date, computed from the same
 * daily record the GDU numbers come from — no extra data source.
 *
 * "First freeze" is the first day on or after `fromMonthDay` (Aug 1 by
 * default; searching from Jan 1 would obviously return a January date)
 * whose daily MINIMUM temperature is at or below `thresholdF`.
 *
 * Corn stops accumulating GDUs at a killing freeze whether or not it has
 * reached black layer, which is the entire reason this is here: a black
 * layer date the app projects for AFTER this date is a warning, not a
 * prediction. 28 °F is the usual killing-freeze threshold for corn; 32 °F
 * is a first light frost, which damages leaf tissue and slows (but does
 * not immediately stop) grain fill.
 *
 * Returns a p10 date alongside the median because the median is the
 * wrong number to make a decision on: a hybrid that black-layers exactly
 * on the median freeze date gets caught one year in two. p10 answers the
 * question that actually matters — "how early does this location freeze
 * in a bad year" — and it is what the app's frost verdict is scored
 * against.
 *
 * ACCURACY NOTE, measured rather than assumed. Compared against real
 * COOP/ASOS thermometer records around Missouri Valley, Iowa over
 * 1996-2025, this reanalysis runs LATE on frost: ERA5 put the median
 * first 32 °F at Oct 26 where Council Bluffs and Omaha measured Oct 19
 * and the more rural Atlantic and Sioux City measured Oct 7. A ~9-25 km
 * grid cell averages away the radiative cooling that makes a low spot in
 * a field frost first, so the model's nighttime minima are too warm.
 * Treat every date this returns as the LATE end of the range, and see
 * the frost card in results.js, which says so on screen. (The same
 * comparison found GDU accumulation itself to be accurate — within about
 * 1% of the nearest station — so this bias is specific to frost, which
 * depends on a single night's minimum rather than a season of averages.)
 *
 * @param {Object<string, DayRecord>} index
 * @param {number[]} years
 * @param {number} thresholdF
 * @param {{addDays: Function, isoForYear: Function}} dateFns
 * @param {string} [fromMonthDay]
 * @param {number} [searchDays]
 * @returns {{medianMonthDay: string|null, p10MonthDay: string|null, earliestMonthDay: string|null, yearsUsed: number}}
 */
export function firstFreezeStats(index, years, thresholdF, dateFns, fromMonthDay = "08-01", searchDays = 140) {
  const offsets = [];
  for (const y of years) {
    const startIso = dateFns.isoForYear(fromMonthDay, y);
    if (!startIso) continue;
    for (let i = 0; i < searchDays; i++) {
      const rec = index[dateFns.addDays(startIso, i)];
      if (!rec || rec.tmin === null || !Number.isFinite(rec.tmin)) continue;
      if (rec.tmin <= thresholdF) {
        offsets.push(i);
        break;
      }
    }
  }
  if (offsets.length === 0) {
    return { medianMonthDay: null, p10MonthDay: null, earliestMonthDay: null, yearsUsed: 0 };
  }
  // Any non-leap reference year works for turning an Aug-1 offset back
  // into a month/day; 2001 covers Aug-Dec with no leap-day ambiguity.
  const refStart = dateFns.isoForYear(fromMonthDay, 2001);
  // Round rather than interpolate — half a day is not a meaningful frost
  // date, and a whole-number offset maps cleanly to a calendar day.
  const toMonthDay = (offset) => dateFns.addDays(refStart, Math.round(offset)).slice(5, 10);
  return {
    medianMonthDay: toMonthDay(percentile(offsets, 0.5)),
    p10MonthDay: toMonthDay(percentile(offsets, 0.1)),
    earliestMonthDay: toMonthDay(Math.min(...offsets)),
    yearsUsed: offsets.length,
  };
}
