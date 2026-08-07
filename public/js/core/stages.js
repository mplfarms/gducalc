// src/core/stages.js
//
// The corn growth-stage ladder: how many GDUs from planting each stage
// takes, and therefore what date each one lands on for a given season.
//
// ---------------------------------------------------------------
// Where the reference numbers come from
// ---------------------------------------------------------------
// The ladder below is Iowa State's PMR 1009 "Corn Growth and
// Development" table for a 2,700-GDU reference hybrid — the same table
// behind Purdue/Iowa State's U2U Corn GDD tool and reproduced in
// University of Kentucky AGR-202. Six of these are quoted directly in
// that published table:
//
//     V2 200 · V6 475 · V12 870 · VT 1135 · R1 1400 · R6 2700
//
// The rest (VE, V4, V8, V10, V14, and the R2/R3/R4 kernel stages) are
// interpolated onto the same cadence the published points establish —
// roughly 65-70 GDU per leaf through the vegetative stages, and evenly
// spaced kernel stages between silking and the long final stretch to
// black layer. They are marked `interpolated: true` below and the app
// says so on screen. This is the honest state of it: the published table
// does not give every stage, and an app that presented an interpolated
// V8 date with the same confidence as a published R1 date would be
// overstating what it knows.
//
// ---------------------------------------------------------------
// Why the ladder gets rescaled per hybrid
// ---------------------------------------------------------------
// The reference hybrid silks at 1,400 and black-layers at 2,700. A
// 77-day hybrid on the grower's own sheet silks at 970 and black-layers
// at 1,850. Dropping the fixed ladder onto that hybrid would put "Silks"
// at 1,400 GDU — flatly contradicting the 970 the sheet says, and the
// sheet is the better information.
//
// So the ladder is anchored to the two numbers actually known for the
// hybrid: every vegetative stage is scaled by (hybrid silk / 1400), and
// every reproductive stage is placed proportionally along the span
// between silking and black layer. Planting, Silks and Maturity land
// exactly on 0, the hybrid's own GDU-to-silk, and the hybrid's own
// GDU-to-black-layer. The stages in between are proportional estimates.
//
// This is a first-order approximation and worth being plain about: real
// hybrids do not stretch perfectly proportionally, and a long-season
// hybrid puts relatively more of its extra heat into grain fill than
// into leaves. It is, however, far better than a fixed ladder that
// disagrees with the hybrid's own published silk date, and it degrades
// gracefully — the further a stage is from an anchor, the more it is an
// estimate, which is exactly how the app labels it.

/** GDU to silking for the reference hybrid the published ladder describes. */
export const REFERENCE_SILK = 1400;
/** GDU to black layer for that same reference hybrid. */
export const REFERENCE_BLACK_LAYER = 2700;

/**
 * @typedef {Object} StageDef
 * @property {string} key
 * @property {string} label        what the chart prints
 * @property {string} code         V/R notation, e.g. "V6", "R1"
 * @property {number} referenceGdu GDU from planting for the 2,700-GDU reference hybrid
 * @property {boolean} interpolated true when the value is not directly in the published table
 */

/** @type {StageDef[]} */
export const STAGE_LADDER = [
  { key: "planting", label: "Planting", code: "", referenceGdu: 0, interpolated: false },
  { key: "emergence", label: "Emergence", code: "VE", referenceGdu: 125, interpolated: true },
  { key: "v2", label: "Two leaves", code: "V2", referenceGdu: 200, interpolated: false },
  { key: "v4", label: "Four leaves", code: "V4", referenceGdu: 345, interpolated: true },
  { key: "v6", label: "Six leaves", code: "V6", referenceGdu: 475, interpolated: false },
  { key: "v8", label: "Eight leaves", code: "V8", referenceGdu: 610, interpolated: true },
  { key: "v10", label: "Ten leaves", code: "V10", referenceGdu: 740, interpolated: true },
  { key: "v12", label: "Twelve leaves", code: "V12", referenceGdu: 870, interpolated: false },
  { key: "v14", label: "Fourteen leaves", code: "V14", referenceGdu: 1000, interpolated: true },
  { key: "v16", label: "Sixteen leaves", code: "V16/VT", referenceGdu: 1135, interpolated: false },
  { key: "silk", label: "Silks", code: "R1", referenceGdu: 1400, interpolated: false },
  { key: "blister", label: "Blister kernels", code: "R2", referenceGdu: 1660, interpolated: true },
  // CODES CORRECTED. These read R3 and "R4/R5" and were wrong: dough is
  // R4 and denting is R5. The GDU VALUES are unchanged and are right —
  // the seed-industry reference this ladder is built on (a 2,700-GDU
  // product) puts blister at ~1,660, dough at 1,925, dent at 2,190-2,450
  // and black layer at ~2,700, which is exactly what is here. Only the
  // stage numbers beside the names were off by one.
  //
  // Worth knowing: published GDU-to-stage tables genuinely disagree.
  // Purdue's extension calendar spaces the reproductive stages
  // differently and would put 1,925 at milk rather than dough. This
  // ladder follows the seed-industry 2,700-GDU reference because that is
  // the same convention the hybrid ratings in this app are published
  // under, and mixing the two would be worse than either. R3 (milk) has
  // no row of its own here.
  { key: "dough", label: "Dough kernels", code: "R4", referenceGdu: 1925, interpolated: true },
  { key: "dent", label: "Denting kernels", code: "R5", referenceGdu: 2190, interpolated: true },
  { key: "maturity", label: "Maturity (black layer)", code: "R6", referenceGdu: 2700, interpolated: false },
];

/**
 * Rescales the ladder onto one hybrid's own silk and black-layer
 * ratings. See the file header for the reasoning.
 *
 * @param {number} gduToSilk
 * @param {number} gduToBlackLayer
 * @returns {Array<StageDef & {gdu: number, anchored: boolean}>}
 *   `gdu` is the threshold for THIS hybrid; `anchored` marks the three
 *   stages that sit exactly on a number the grower supplied rather than
 *   on a scaled estimate.
 */
export function stagesForHybrid(gduToSilk, gduToBlackLayer) {
  const vegScale = gduToSilk / REFERENCE_SILK;
  const repSpan = gduToBlackLayer - gduToSilk;
  const refRepSpan = REFERENCE_BLACK_LAYER - REFERENCE_SILK;

  return STAGE_LADDER.map((stage) => {
    let gdu;
    if (stage.referenceGdu <= REFERENCE_SILK) {
      gdu = stage.referenceGdu * vegScale;
    } else {
      const fraction = (stage.referenceGdu - REFERENCE_SILK) / refRepSpan;
      gdu = gduToSilk + fraction * repSpan;
    }
    return {
      ...stage,
      gdu: Math.round(gdu),
      // Planting, silking and black layer are the grower's own numbers
      // (or zero); everything else is a scaled estimate.
      anchored: stage.key === "planting" || stage.key === "silk" || stage.key === "maturity",
    };
  });
}

/**
 * Attaches a projected date to each stage by walking a cumulative GDU
 * curve. A stage the curve never reaches inside the window gets a null
 * date rather than an extrapolated guess.
 *
 * @param {Array<StageDef & {gdu: number}>} stages from stagesForHybrid()
 * @param {(number|null)[]} cum cumulative GDU by day-offset from planting
 * @param {string} plantingIso
 * @param {number} solidThroughOffset last offset backed by real data
 * @param {{offsetAtTarget: Function, addDays: Function}} fns
 * @returns {Array<StageDef & {gdu: number, offset: number|null, iso: string|null, projected: boolean}>}
 */
export function datedStages(stages, cum, plantingIso, solidThroughOffset, fns) {
  return stages.map((stage) => {
    // Planting is the planting date by definition — not something to
    // look up in a curve that starts at a non-zero first-day total.
    if (stage.key === "planting") {
      return { ...stage, offset: 0, iso: plantingIso, projected: false };
    }
    const offset = fns.offsetAtTarget(cum, stage.gdu);
    return {
      ...stage,
      offset,
      iso: offset === null ? null : fns.addDays(plantingIso, offset),
      projected: offset !== null && offset > solidThroughOffset,
    };
  });
}
