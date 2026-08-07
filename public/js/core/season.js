// src/core/season.js
//
// Turns a daily temperature record + a planting date + a hybrid's GDU
// ratings into the set of scenario curves the app draws and tables.
// Still pure (no fetch, no DOM) — weather.js does the network, this
// does the reasoning.
//
// ---------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------
// Five curves, all cumulative GDU from the SAME planting date so they
// are directly comparable:
//
//   current  — this season: observed GDUs to date, then the 16-day
//              forecast, then a projection to finish the season out.
//              Drawn solid up to the last real/forecast day and dashed
//              after it, because those are different kinds of number
//              and the chart should not pretend otherwise.
//   lastYear — the previous season's ACTUAL accumulation from the same
//              planting date. A real year, not a statistic.
//   normal   — 50th percentile of the baseline years.
//   hot      — 90th percentile ("abnormally hot").
//   cool     — 10th percentile ("abnormally cool").
//
// The three percentile curves are pointwise order statistics across
// years (see gdu.js's envelopeFromCalendarDate) — an envelope, not a
// replay of any particular year.
//
// The current-season projection is spliced on using the percentile of
// REMAINING accumulation from the day after the last known day, not by
// summing "normal daily rates". That distinction matters: percentiles
// do not add, so summing 90th-percentile daily values would produce a
// season total far hotter than any 90th-percentile season ever was.
// Anchoring the envelope at the splice date and adding the whole
// remaining-accumulation percentile keeps the statistics honest.
//
// Three finishes are computed for the current season (normal / hot /
// cool rest-of-season) because "when will this hybrid black layer"
// genuinely has a range of answers in early August, and quoting a
// single date would overstate what the data supports.

import { addDays, daysBetween, isoForYear, monthDayOf, yearOf } from "./dates.js";
import { accumulate, envelopeFromCalendarDate, firstFreezeStats, offsetAtTarget } from "./gdu.js";

/** Season window length. ~7 months covers even a 120-day-RM hybrid in a
 *  cold year plus the whole frost-risk tail. */
export const SEASON_DAYS = 220;

/** How many completed years feed the normal / hot / cool envelopes. */
export const BASELINE_YEARS = 30;

const dateFns = { addDays, isoForYear };

/**
 * @param {number} plantingYear
 * @returns {number[]} the BASELINE_YEARS completed years before it
 */
export function baselineYearsFor(plantingYear) {
  const years = [];
  for (let y = plantingYear - BASELINE_YEARS; y <= plantingYear - 1; y++) years.push(y);
  return years;
}

/**
 * @typedef {Object} Scenario
 * @property {string} key
 * @property {string} label
 * @property {(number|null)[]} cum cumulative GDU by day-offset from planting
 * @property {number} solidThroughOffset last offset backed by observed or
 *   forecast data (everything after it is projected); SEASON_DAYS-1 for a
 *   fully historical scenario, -1 when nothing is observed.
 * @property {boolean} isProjection whether any part of the curve is modeled
 */

/**
 * Builds every scenario curve plus the derived stage dates.
 *
 * @param {Object} args
 * @param {Object<string, import('./gdu.js').DayRecord>} args.index daily record map
 * @param {string} args.plantingIso "YYYY-MM-DD"
 * @param {number} args.gduToSilk
 * @param {number} args.gduToBlackLayer
 * @param {string} args.lastKnownIso last date in `index` with data (forecast end)
 * @param {string} args.lastObservedIso last date backed by OBSERVED (not forecast) data
 * @returns {Object} full result bundle — see the return statement.
 */
export function buildSeason({ index, plantingIso, gduToSilk, gduToBlackLayer, lastKnownIso, lastObservedIso }) {
  const plantingYear = yearOf(plantingIso);
  const plantingMonthDay = monthDayOf(plantingIso);
  const years = baselineYearsFor(plantingYear);

  // ---- climatological envelope from the planting date ----
  const env = envelopeFromCalendarDate(index, plantingMonthDay, years, SEASON_DAYS, dateFns);

  // ---- last year's actual ----
  const lastYearStart = isoForYear(plantingMonthDay, plantingYear - 1);
  const lastYearAcc = lastYearStart
    ? accumulate(index, lastYearStart, SEASON_DAYS, addDays)
    : { cum: new Array(SEASON_DAYS).fill(null), complete: false, lastCompleteOffset: -1 };

  // ---- this season: observed + forecast, then projected ----
  const known = accumulate(index, plantingIso, SEASON_DAYS, addDays);
  // Clamp to lastKnownIso rather than trusting the index to simply run
  // out. In production the two agree (the index ends at the forecast's
  // last day), but the index also holds 30 years of history, and for a
  // planting date in a PAST season it would happily accumulate the
  // entire window from the archive — which would then be presented as
  // "known" data with a projection spliced after it. Making the caller's
  // stated horizon authoritative keeps "known" meaning exactly what the
  // chart's solid-line legend claims it means.
  // Clamped to the season window, because the season IS the window. For a
  // 2024 planting date looked up in 2026 the raw horizon is ~800 days;
  // leaving it unclamped made "the record stopped short of the horizon"
  // permanently true and lit a data-gap warning on every complete
  // historical season.
  const horizonOffset = lastKnownIso
    ? Math.min(daysBetween(plantingIso, lastKnownIso), SEASON_DAYS - 1)
    : SEASON_DAYS - 1;
  // Floor at -1 ("nothing known yet") rather than letting a planting
  // date far in the future produce a large negative offset.
  const knownEndOffset = Math.max(-1, Math.min(known.lastCompleteOffset, horizonOffset));
  for (let i = knownEndOffset + 1; i < SEASON_DAYS; i++) known.cum[i] = null;

  // How much of the known curve is real observation vs. forecast — the
  // chart draws forecast days differently from observed ones.
  const observedEndOffset =
    lastObservedIso && daysBetween(plantingIso, lastObservedIso) >= 0
      ? Math.min(daysBetween(plantingIso, lastObservedIso), knownEndOffset)
      : -1;

  /** @type {{normal: (number|null)[], hot: (number|null)[], cool: (number|null)[]}} */
  const currentFinishes = { normal: null, hot: null, cool: null };
  let remainingEnv = null;

  if (knownEndOffset >= 0) {
    const base = known.cum[knownEndOffset];
    const spliceIso = addDays(plantingIso, knownEndOffset + 1);
    const remainingDays = SEASON_DAYS - (knownEndOffset + 1);
    if (remainingDays > 0) {
      remainingEnv = envelopeFromCalendarDate(index, monthDayOf(spliceIso), years, remainingDays, dateFns);
    }
    for (const [key, band] of [
      ["normal", "p50"],
      ["hot", "p90"],
      ["cool", "p10"],
    ]) {
      const curve = known.cum.slice();
      if (remainingEnv) {
        for (let j = 0; j < remainingDays; j++) {
          const add = remainingEnv[band][j];
          curve[knownEndOffset + 1 + j] = add === null ? null : base + add;
        }
      }
      currentFinishes[key] = curve;
    }
  }

  /** @type {Scenario[]} */
  const scenarios = [];
  if (knownEndOffset >= 0) {
    scenarios.push({
      key: "current",
      label: `This Season (${plantingYear})`,
      cum: currentFinishes.normal,
      solidThroughOffset: knownEndOffset,
      observedThroughOffset: observedEndOffset,
      isProjection: knownEndOffset < SEASON_DAYS - 1,
    });
  }
  scenarios.push(
    {
      key: "lastYear",
      label: `Last Year (${plantingYear - 1})`,
      cum: lastYearAcc.cum,
      solidThroughOffset: lastYearAcc.lastCompleteOffset,
      observedThroughOffset: lastYearAcc.lastCompleteOffset,
      isProjection: false,
    },
    {
      key: "hot",
      label: "Abnormally Hot (90th pct)",
      cum: env.p90,
      solidThroughOffset: SEASON_DAYS - 1,
      observedThroughOffset: SEASON_DAYS - 1,
      isProjection: false,
    },
    {
      key: "normal",
      label: `Normal (${BASELINE_YEARS}-yr median)`,
      cum: env.p50,
      solidThroughOffset: SEASON_DAYS - 1,
      observedThroughOffset: SEASON_DAYS - 1,
      isProjection: false,
    },
    {
      key: "cool",
      label: "Abnormally Cool (10th pct)",
      cum: env.p10,
      solidThroughOffset: SEASON_DAYS - 1,
      observedThroughOffset: SEASON_DAYS - 1,
      isProjection: false,
    }
  );

  // ---- stage dates per scenario ----
  const rows = [];

  if (knownEndOffset >= 0) {
    for (const [key, label] of [
      ["normal", "This season — normal finish"],
      ["hot", "This season — hot finish"],
      ["cool", "This season — cool finish"],
    ]) {
      rows.push(
        makeRow(`current-${key}`, label, currentFinishes[key], plantingIso, gduToSilk, gduToBlackLayer, knownEndOffset, observedEndOffset)
      );
    }
  }
  rows.push(
    makeRow("lastYear", `Last year (${plantingYear - 1}) actual`, lastYearAcc.cum, plantingIso, gduToSilk, gduToBlackLayer, SEASON_DAYS - 1, SEASON_DAYS - 1),
    // These three describe the LOCATION's climate, not this season, so
    // their dates are neither observed, forecast nor projected — see the
    // "climatology" case in basisFor's comment.
    makeRow("hot", "Abnormally hot year (90th pct)", env.p90, plantingIso, gduToSilk, gduToBlackLayer, SEASON_DAYS - 1, -1, "climatology"),
    makeRow("normal", `Normal (${BASELINE_YEARS}-yr median)`, env.p50, plantingIso, gduToSilk, gduToBlackLayer, SEASON_DAYS - 1, -1, "climatology"),
    makeRow("cool", "Abnormally cool year (10th pct)", env.p10, plantingIso, gduToSilk, gduToBlackLayer, SEASON_DAYS - 1, -1, "climatology")
  );

  // ---- this season, collapsed to one honest answer per stage ----
  const currentStage = knownEndOffset >= 0 ? summarizeCurrent(rows, plantingIso, observedEndOffset, knownEndOffset) : null;

  // ---- frost ----
  const killingFreeze = firstFreezeStats(index, years, 28, dateFns);
  const lightFrost = firstFreezeStats(index, years, 32, dateFns);

  // ---- to-date summary ----
  const gduToDate = knownEndOffset >= 0 && observedEndOffset >= 0 ? known.cum[observedEndOffset] : null;
  const normalToDate = observedEndOffset >= 0 ? env.p50[observedEndOffset] : null;

  return {
    plantingIso,
    plantingYear,
    // The daily record itself rides along. Stage-band temperature
    // averages need per-day highs and lows, but which days belong to
    // which band depends on the hybrid's ladder and the scenario being
    // viewed — both of which live in the UI layer, not here. Handing back
    // the index the season was built from is cheaper and less tangled
    // than threading a second copy through every caller, and it is a
    // reference to the object the caller already passed in, not a copy.
    index,
    scenarios,
    rows,
    env,
    lastYearAcc,
    knownEndOffset,
    observedEndOffset,
    // DERIVED, not echoed. The caller tells us how far its download ran,
    // but a hole in the middle of the record stops `accumulate` early, and
    // everything downstream — "GDU through <date>", "observed through
    // <date> plus forecast through <date>", the PDF header — reads these
    // two fields as the dates the numbers actually cover. Passing the
    // caller's optimistic end back out would label a total that stops at
    // May 30 with "Through Jul 1" and claim a forecast that was discarded.
    // Deriving from the offsets that were really used makes the label and
    // the number agree by construction.
    lastKnownIso: knownEndOffset >= 0 ? addDays(plantingIso, knownEndOffset) : null,
    lastObservedIso: observedEndOffset >= 0 ? addDays(plantingIso, observedEndOffset) : null,
    // True when a gap cut the record short of the window the caller could
    // have covered, so the UI can say "the record stops here" instead of
    // silently showing a stale date.
    //
    // Gated on horizonOffset >= 0, which is what separates "a hole in the
    // data" from "the planting date has not arrived yet" — a future
    // planting has a negative horizon and nothing is wrong with it. And
    // deliberately NOT gated on knownEndOffset >= 0: a hole ON the
    // planting day itself leaves knownEndOffset at -1, which is the most
    // truncated case there is and used to produce no warning at all.
    truncatedByGap: horizonOffset >= 0 && knownEndOffset < horizonOffset,
    requestedKnownIso: lastKnownIso,
    requestedObservedIso: lastObservedIso,
    currentStage,
    yearsUsed: env.yearsUsed,
    // How many years actually fed the REMAINING-season envelope — the one
    // the three "this season" finishes are built from. It is not always
    // the same as yearsUsed (a different window can be short of data at
    // a different set of years), and if it collapses toward 1 the three
    // finishes converge for a reason that has nothing to do with the
    // weather. Surfaced so the UI can say so instead of showing three
    // identical dates that look like a bug.
    remainingYearsUsed: remainingEnv ? remainingEnv.yearsUsed : [],
    killingFreeze,
    lightFrost,
    gduToDate,
    normalToDate,
    gduVsNormal: gduToDate !== null && normalToDate !== null ? gduToDate - normalToDate : null,
    seasonDays: SEASON_DAYS,
  };
}

/**
 * What KIND of number a stage date is. This is the distinction the app
 * was previously missing, and it is the whole reason three "this season"
 * rows could show the same date and look broken:
 *
 *   "actual"    — the crop passed this stage on a day we have OBSERVED
 *                 weather for. It already happened. It is not a
 *                 prediction and it cannot differ between scenarios,
 *                 because all three scenarios share the same history.
 *   "forecast"  — inside the 16-day outlook. Barely uncertain, and again
 *                 identical across scenarios, since they share the
 *                 forecast too.
 *   "projected" — past the last known day. This is the only region where
 *                 a normal / hot / cool finish can possibly diverge.
 *   "climatology" — not about this season at all. The 30-year median /
 *                 90th / 10th percentile rows describe what a normal,
 *                 hot or cool YEAR looks like at this location; there is
 *                 no observation and no forecast behind them. They were
 *                 previously labelled "forecast" because they were fed
 *                 observedThroughOffset = -1 and a full-length known
 *                 horizon, which made every day of them look like it sat
 *                 inside a 16-day outlook. Nothing rendered that label
 *                 yet, so nothing was visibly wrong — but the field was
 *                 there to be believed by the next thing that read it.
 *
 * @param {number|null} offset
 * @param {number} observedThroughOffset
 * @param {number} knownThroughOffset
 * @returns {"actual"|"forecast"|"projected"|null}
 */
function basisFor(offset, observedThroughOffset, knownThroughOffset) {
  if (offset === null) return null;
  if (offset <= observedThroughOffset) return "actual";
  if (offset <= knownThroughOffset) return "forecast";
  return "projected";
}

function makeRow(key, label, cum, plantingIso, gduToSilk, gduToBlackLayer, solidThroughOffset, observedThroughOffset, basisOverride = null) {
  const basisOf = (offset) => (offset === null ? null : basisOverride || basisFor(offset, observedThroughOffset, solidThroughOffset));
  const silkOffset = offsetAtTarget(cum, gduToSilk);
  const blOffset = offsetAtTarget(cum, gduToBlackLayer);
  const finalIdx = lastNonNull(cum);
  return {
    key,
    label,
    silkOffset,
    silkIso: silkOffset === null ? null : addDays(plantingIso, silkOffset),
    silkIsProjected: silkOffset !== null && silkOffset > solidThroughOffset,
    silkBasis: basisOf(silkOffset),
    blackLayerOffset: blOffset,
    blackLayerIso: blOffset === null ? null : addDays(plantingIso, blOffset),
    blackLayerIsProjected: blOffset !== null && blOffset > solidThroughOffset,
    blackLayerBasis: basisOf(blOffset),
    seasonTotal: finalIdx === -1 ? null : cum[finalIdx],
  };
}

/**
 * Collapses the three "this season" rows into one answer per stage.
 *
 * The three finishes are NOT three independent predictions — they share
 * every observed and forecast day and diverge only in the projected
 * tail. Presenting them as three table rows implied a disagreement that
 * often does not exist: a stage the crop already passed is one date, and
 * printing it three times under "normal / hot / cool" reads as a fault
 * in the app rather than as the arithmetic truth that history does not
 * have scenarios.
 *
 * So: one date (the normal finish), a range where the scenarios actually
 * differ, and an explicit basis saying whether the date is observation,
 * forecast, or projection.
 *
 * @returns {{silk: StageSummary|null, blackLayer: StageSummary|null}}
 * @typedef {Object} StageSummary
 * @property {string} iso           the normal-finish date
 * @property {number} offset
 * @property {string} basis         "actual" | "forecast" | "projected"
 * @property {string|null} earliestIso  hot finish (null if it never gets there)
 * @property {string|null} latestIso    cool finish (null if it never gets there)
 * @property {number|null} spreadDays   latest − earliest, null if either is unreached
 * @property {boolean} reachedInEveryScenario
 */
function summarizeCurrent(rows, plantingIso, observedEndOffset, knownEndOffset) {
  const byKey = {};
  for (const r of rows) if (r.key.startsWith("current-")) byKey[r.key.slice("current-".length)] = r;
  const build = (offsetField, isoField, basisField) => {
    const normal = byKey.normal;
    if (!normal || normal[offsetField] === null) return null;
    const hot = byKey.hot ? byKey.hot[offsetField] : null;
    const cool = byKey.cool ? byKey.cool[offsetField] : null;
    const all = [hot, normal[offsetField], cool].filter((v) => v !== null);
    const reachedInEveryScenario = hot !== null && cool !== null;
    // Hot finishes earliest and cool latest, but take min/max rather than
    // trusting that ordering — a degenerate envelope could tie them, and
    // an assumption is a worse thing to ship than two extra comparisons.
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    return {
      iso: normal[isoField],
      offset: normal[offsetField],
      basis: normal[basisField],
      earliestIso: addDays(plantingIso, lo),
      latestIso: reachedInEveryScenario ? addDays(plantingIso, hi) : null,
      spreadDays: reachedInEveryScenario ? hi - lo : null,
      reachedInEveryScenario,
    };
  };
  return {
    silk: build("silkOffset", "silkIso", "silkBasis"),
    blackLayer: build("blackLayerOffset", "blackLayerIso", "blackLayerBasis"),
  };
}

function lastNonNull(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null && arr[i] !== undefined && Number.isFinite(arr[i])) return i;
  }
  return -1;
}
