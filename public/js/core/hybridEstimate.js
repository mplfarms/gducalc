// src/core/hybridEstimate.js
//
// Fills in a hybrid's missing GDU rating so a calculation can still run
// when only part of the information is at hand — one of the two GDU
// numbers, or just a relative maturity.
//
// ---------------------------------------------------------------
// Where the models come from
// ---------------------------------------------------------------
// Ordinary least squares fitted on all 72 hybrids in this app's own
// list (public/data/hybrids.json), exactly as supplied — including
// 89-58 SSPRORIB, the known RM outlier. Nothing was trimmed to make the
// fit look better.
//
// Quoted errors below are LEAVE-ONE-OUT: each hybrid was predicted by a
// model fitted on the other 71 and never on itself. That is the honest
// number. In-sample error would read roughly 10% lower and would be
// measuring the fit's memory rather than its accuracy.
//
//   estimate               median   p90    worst
//   silk from black layer    19     53     102
//   black layer from silk    40    140     276
//   silk from RM             24     67     248
//   black layer from RM      45    150     472
//
// ---------------------------------------------------------------
// Two consequences worth stating plainly
// ---------------------------------------------------------------
// 1. A REAL GDU NUMBER BEATS RM, always. Deriving black layer from a
//    known silk rating (median 40 GDU off) is better than deriving it
//    from RM (45), and deriving silk from a known black layer (19) is
//    much better than from RM (24) — because the paired GDU number is
//    specific to that hybrid, while RM only locates it in a maturity
//    band that holds a 200+ GDU spread. resolve() below therefore
//    always prefers a GDU-based estimate when one is available, and
//    only falls back to RM when neither GDU number was given.
//
// 2. RM IS A WEAK PREDICTOR OF BLACK LAYER. R² is 0.83 and the worst
//    miss in the list is 472 GDU — roughly three weeks of grain fill.
//    42W96 TRERIB (RM 96) is rated 2,849 where the RM-96 fit says
//    2,378. An RM-only estimate is a reasonable default for a hybrid
//    whose sheet you don't have; it is not a substitute for the sheet,
//    and the app labels every estimated value as such on every screen
//    it appears on.
//
// A quadratic in RM was tested and rejected: it moved black-layer RMSE
// from 88.4 to 87.7 GDU, which is not a real improvement, and it bends
// badly outside the fitted range. Linear it is.

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
  silkFromRm: { slope: 7.5526, intercept: 492.2, medianErr: 24, p90Err: 67, maxErr: 248 },
  blFromRm: { slope: 20.2059, intercept: 445.9, medianErr: 45, p90Err: 150, maxErr: 472 },
  blFromSilk: { slope: 2.3868, intercept: -507.45, medianErr: 40, p90Err: 140, maxErr: 276 },
  silkFromBl: { slope: 0.3769, intercept: 317.65, medianErr: 19, p90Err: 53, maxErr: 102 },
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
