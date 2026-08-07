// src/core/frostVerdict.js
//
// The one sentence on the frost card that actually answers the question:
// "will this hybrid finish here, or will a freeze catch it short?"
//
// It lives in core/ rather than in the results screen because the PDF
// needs it too — and did not have it. The printed sheet is the artifact a
// rep hands a grower and the one that outlives the session, and it was
// carrying the three freeze dates with no interpretation of them at all,
// while the screen it was printed from said in red that the hybrid would
// be caught 22 days short of black layer. Two surfaces, one of them
// silent on the most consequential fact.
//
// Returns a tone plus a string rather than a DOM node so both callers can
// render it in their own idiom.

import { daysBetween, formatShort } from "./dates.js";

/**
 * @typedef {{tone: "bad"|"warn"|"good", text: string}} Verdict
 */

/**
 * @param {Object} season buildSeason() output
 * @param {Object|null} hybrid validatedHybrid().value
 * @returns {Verdict|null} null when there is nothing to score against —
 *   no hybrid, or no 1-year-in-10 freeze date at this location
 */
export function frostVerdict(season, hybrid) {
  const kf = season && season.killingFreeze;
  if (!hybrid || !kf || !kf.p10MonthDay) return null;

  const year = season.plantingYear;
  const killEarlyIso = `${year}-${kf.p10MonthDay}`;
  const killMedianIso = kf.medianMonthDay ? `${year}-${kf.medianMonthDay}` : null;

  // Compare against the LATEST black-layer date among the this-season
  // rows (the cool finish) — the risk question is "could this fail", not
  // "does it work if everything goes well".
  const currentRows = season.rows.filter((r) => r.key.startsWith("current-"));
  const pool = currentRows.length ? currentRows : season.rows.filter((r) => r.key === "cool");
  let latest = null;
  for (const r of pool) {
    if (r.blackLayerIso === null) {
      latest = null;
      break;
    }
    if (latest === null || r.blackLayerIso > latest) latest = r.blackLayerIso;
  }

  if (latest === null) {
    return {
      tone: "bad",
      text: `This hybrid doesn't reach black layer at all within the season window in at least one scenario. At ${hybrid.gduToBlackLayer.toLocaleString()} GDU it's too long for this location and planting date.`,
    };
  }

  const marginEarly = daysBetween(latest, killEarlyIso);
  const marginMedian = killMedianIso === null ? null : daysBetween(latest, killMedianIso);

  // Two forms of the same clause: one that can open a sentence and one
  // that can follow a comma. The null-median wording used to be a
  // lowercase fragment dropped in after a full stop, which rendered as
  // "…short of black layer. and the median year never freezes at all."
  //
  // marginMedian is only non-negative in the two later branches. In the
  // bad branch it is unbounded below — a black layer date past the MEDIAN
  // freeze is exactly the state the "after median freeze" badge already
  // flags — and "it has -13 days" is not a sentence, so a negative margin
  // gets its own wording.
  const vsMedian =
    marginMedian === null
      ? "In the median year there is no killing freeze at all"
      : marginMedian < 0
        ? `Even against the median freeze it is ${Math.abs(marginMedian)} days short`
        : `Against the median freeze it has ${marginMedian} days`;
  const vsMedianShort =
    marginMedian === null
      ? "and no killing freeze at all in the median year"
      : marginMedian < 0
        ? `and ${Math.abs(marginMedian)} days short of the median freeze`
        : `${marginMedian} against the median`;

  if (marginEarly < 0) {
    return {
      tone: "bad",
      text: `In a 1-year-in-10 early freeze (${formatShort(killEarlyIso)}) this hybrid would be caught ${Math.abs(marginEarly)} days short of black layer. ${vsMedian}. That's a real risk of an unfinished crop, not a rounding issue.`,
    };
  }
  if (marginEarly < 10) {
    return {
      tone: "warn",
      text: `Only ${marginEarly} days of margin against a 1-year-in-10 early freeze (${formatShort(killEarlyIso)}), ${vsMedianShort}. Tight — a cool September puts this hybrid at risk.`,
    };
  }
  return {
    tone: "good",
    text: `${marginEarly} days of margin even against a 1-year-in-10 early freeze (${formatShort(killEarlyIso)}), ${vsMedianShort}. Comfortable for this location and planting date.`,
  };
}
