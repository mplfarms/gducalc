// src/core/hybridEstimate.js
//
// Fills in a hybrid's missing GDU rating so a calculation can still run
// when only part of the information is at hand — one of the two GDU
// numbers, or just a relative maturity.
//
// ---------------------------------------------------------------
// Where the models come from
// ---------------------------------------------------------------
// Ordinary least squares fitted on all 133 hybrids in this app's own
// list (public/data/hybrids.json), exactly as supplied — including
// 89-58 SSPRORIB, the known RM outlier. Nothing was trimmed to make the
// fit look better.
//
// Refitted on every change to the list, because it is fitted ON that
// list: 72 -> 134 on the big refresh, 134 -> 132 when the two bare-TRE
// entries were dropped as exact duplicates of their TRERIB counterparts
// (identical RM, silk and black layer, so they were double-weighting two
// hybrids for nothing), and 132 -> 133 when 14-36 PCE was added.
//
// Quoted errors below are LEAVE-ONE-OUT: each hybrid was predicted by a
// model fitted on the other 132 and never on itself. That is the honest
// number. In-sample error would read roughly 10% lower and would be
// measuring the fit's memory rather than its accuracy.
//
//   estimate               median   p90    worst    R2
//   silk from black layer    25     58     116     0.852
//   black layer from silk    46    169     264     0.852
//   silk from RM             29     58     187     0.811
//   black layer from RM      47    146     389     0.869
//
// ---------------------------------------------------------------
// Two consequences worth stating plainly
// ---------------------------------------------------------------
// 1. A REAL GDU NUMBER IS PREFERRED OVER RM. Silk from a known black
//    layer (median 25 GDU off) beats silk from RM (29). For black layer
//    the two are close — 46 from a known silk against 47 from RM — where
//    on the old 72-hybrid list silk was the clearer winner. The preference still stands, but on the honest grounds
//    that a paired GDU rating is specific to THAT hybrid while RM only
//    locates it in a maturity band holding a 200+ GDU spread, not on a
//    meaningful accuracy gap. resolve() below prefers a GDU-based
//    estimate when one is available and falls back to RM otherwise.
//
// 2. RM IS A WEAK PREDICTOR OF BLACK LAYER. R² is 0.869 and the worst
//    leave-one-out miss in the list is 389 GDU — roughly two and a half
//    weeks of grain fill. That miss is 89-58 SSPRORIB (RM 89), rated
//    2,592 where the shipped RM-89 fit says 2,210, an in-sample residual
//    of 382; held out of its own fit it lands 389 off. Both numbers are
//    the same hybrid, and the leave-one-out one is what gets quoted. An RM-only estimate is a reasonable default for a
//    hybrid whose sheet you don't have; it is not a substitute for the
//    sheet, and the app labels every estimated value as such on every
//    screen it appears on.
//
// A quadratic in RM was tested and rejected on the original list: it
// moved black-layer RMSE from 88.4 to 87.7 GDU, which is not a real
// improvement, and it bends badly outside the fitted range. Linear it
// is.

/**
 * How many hybrids the shipped models were fitted on.
 *
 * Exported rather than written into each screen's copy because it was
 * quoted in five places and three of them were still saying 72 after the
 * list had been replaced twice. A unit test pins this to the catalog's
 * real length, so a data refresh that forgets the refit fails the build
 * instead of shipping a stale accuracy claim.
 */
export const FITTED_N = 133;

/** RM range the models were actually fitted over. */
export const RM_FITTED_MIN = 77;
export const RM_FITTED_MAX = 118;

/** Hard input bounds — outside these, a typed value is a typo, not a hybrid. */
export const RM_MIN = 60;
export const RM_MAX = 135;
export const SILK_MIN = 400;
export const SILK_MAX = 2200;
export const BL_MIN = 900;
export const BL_MAX = 4000;

/**
 * y = slope*x + intercept, with leave-one-out |error| percentiles in GDU.
 * @typedef {{slope: number, intercept: number, medianErr: number, p90Err: number, maxErr: number}} Model
 */

/** @type {Object<string, Model>} */
export const MODELS = {
  silkFromRm: { slope: 8.1765, intercept: 417.33, medianErr: 29, p90Err: 58, maxErr: 187 },
  blFromRm: { slope: 21.5603, intercept: 291.38, medianErr: 47, p90Err: 146, maxErr: 389 },
  blFromSilk: { slope: 2.3519, intercept: -452.57, medianErr: 46, p90Err: 169, maxErr: 264 },
  silkFromBl: { slope: 0.3623, intercept: 348.9, medianErr: 25, p90Err: 58, maxErr: 116 },
};

function apply(model, x) {
  return Math.round(model.slope * x + model.intercept);
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @typedef {Object} ResolvedValue
 * @property {number} value
 * @property {"entered"|"fromRm"|"fromSilk"|"fromBlackLayer"} source
 * @property {Model|null} model  null when the value was entered
 */

/**
 * Works out the pair of GDU numbers to calculate with, from whatever the
 * user supplied.
 *
 * Accepts any of: both GDU numbers, either one alone, or a relative
 * maturity alone. Returns which values were entered and which were
 * estimated (and from what), so every screen downstream can label them
 * rather than presenting an estimate as a measurement.
 *
 * @param {{gduToSilk?: any, gduToBlackLayer?: any, rm?: any}} input
 * @returns {{ok: true, silk: ResolvedValue, blackLayer: ResolvedValue, rm: number|null, rmOutsideFit: boolean, anyEstimated: boolean} | {ok: false, error: string}}
 */
export function resolve(input) {
  const rawSilk = num(input && input.gduToSilk);
  const rawBl = num(input && input.gduToBlackLayer);
  const rawRm = num(input && input.rm);

  // Range checks first, so a typo is reported as a typo rather than
  // quietly producing a plausible-looking estimate from it.
  if (rawSilk !== null && (rawSilk < SILK_MIN || rawSilk > SILK_MAX)) {
    return { ok: false, error: `GDUs to silk of ${rawSilk.toLocaleString()} is outside anything real (${SILK_MIN}–${SILK_MAX}). Check the number.` };
  }
  if (rawBl !== null && (rawBl < BL_MIN || rawBl > BL_MAX)) {
    return { ok: false, error: `GDUs to black layer of ${rawBl.toLocaleString()} is outside anything real (${BL_MIN}–${BL_MAX}). Check the number.` };
  }
  if (rawRm !== null && (rawRm < RM_MIN || rawRm > RM_MAX)) {
    return { ok: false, error: `A relative maturity of ${rawRm} day is outside anything real (${RM_MIN}–${RM_MAX}). Check the number.` };
  }

  if (rawSilk === null && rawBl === null && rawRm === null) {
    return { ok: false, error: "Enter GDUs to silk, GDUs to black layer, or a relative maturity — any one of the three is enough." };
  }

  /** @type {ResolvedValue} */
  let silk;
  /** @type {ResolvedValue} */
  let blackLayer;

  if (rawSilk !== null) silk = { value: rawSilk, source: "entered", model: null };
  if (rawBl !== null) blackLayer = { value: rawBl, source: "entered", model: null };

  // A GDU number is specific to THIS hybrid; RM only places it in a
  // maturity band. So a paired GDU number always wins as the basis for
  // an estimate, and RM is the fallback of last resort.
  if (!silk) {
    if (rawBl !== null) silk = { value: apply(MODELS.silkFromBl, rawBl), source: "fromBlackLayer", model: MODELS.silkFromBl };
    else silk = { value: apply(MODELS.silkFromRm, rawRm), source: "fromRm", model: MODELS.silkFromRm };
  }
  if (!blackLayer) {
    if (rawSilk !== null) blackLayer = { value: apply(MODELS.blFromSilk, rawSilk), source: "fromSilk", model: MODELS.blFromSilk };
    else blackLayer = { value: apply(MODELS.blFromRm, rawRm), source: "fromRm", model: MODELS.blFromRm };
  }

  // Silking always precedes black layer. With the fitted slopes this
  // can only be violated by a hand-entered pair, but the guard covers
  // an estimate too rather than trusting the algebra to hold forever.
  if (silk.value >= blackLayer.value) {
    if (silk.source === "entered" && blackLayer.source === "entered") {
      return { ok: false, error: "GDUs to silk must be lower than GDUs to black layer — check the two numbers." };
    }
    return { ok: false, error: "Those inputs produce a silk rating at or past black layer, which can't happen. Check the numbers." };
  }

  return {
    ok: true,
    silk,
    blackLayer,
    rm: rawRm,
    // The models were fitted over RM 77–118. Outside that they're
    // extrapolating, which is worth saying out loud.
    rmOutsideFit: rawRm !== null && (rawRm < RM_FITTED_MIN || rawRm > RM_FITTED_MAX),
    anyEstimated: silk.source !== "entered" || blackLayer.source !== "entered",
  };
}

/**
 * Short provenance label for a resolved value, e.g. "estimated from RM".
 * @param {ResolvedValue} rv
 * @param {number|null} rm
 * @returns {string|null} null when the value was entered outright
 */
export function sourceLabel(rv, rm) {
  switch (rv.source) {
    case "fromRm":
      return `estimated from ${rm} day RM`;
    case "fromSilk":
      return "estimated from GDUs to silk";
    case "fromBlackLayer":
      return "estimated from GDUs to black layer";
    default:
      return null;
  }
}

/**
 * How much to trust an estimate, in the units it's quoted in.
 * @param {ResolvedValue} rv
 * @returns {string|null}
 */
export function accuracyNote(rv) {
  if (!rv.model) return null;
  return `typically within ±${rv.model.medianErr} GDU, ±${rv.model.p90Err} in 1 case out of 10`;
}
