// src/core/frostText.js
//
// The wording shared by every surface that shows frost information: the
// results screen, the PDF and the shared text summary.
//
// These started as one function each in results.js with a copy in
// pdfBuilder.js, and the copies drifted — the PDF gated its whole frost
// section on the median freeze date where the screen gated on the 10th
// percentile, so at a mild location the printed sheet said "No 28 °F
// freeze appears in this location's 30-year record" while the screen on
// the same run showed a 1-in-10 freeze date and a red verdict. Anything
// two surfaces must agree on lives here.

/**
 * What to say when there is no 1-in-10 freeze date to report.
 *
 * Three genuinely different situations, and the middle one used to be
 * told the same thing as the first:
 *
 *   * no usable years at all — every year had a hole in the record
 *     before its first freeze. Saying "no freeze appears in this
 *     location's 30-year record" there is asserting a finding from a
 *     record that could not be read;
 *   * usable years, none of which froze — the real "not the limiting
 *     factor" case;
 *   * some froze, but fewer than one year in ten.
 *
 * @param {Object|null} kf firstFreezeStats() output
 * @returns {string}
 */
export function noFreezeText(kf) {
  if (!kf || !kf.yearsUsed) {
    return "The 30-year record for this grid point has gaps in every year before the first freeze, so there is nothing to base a frost date on. This is a data problem, not a finding — try recalculating later.";
  }
  if (kf.yearsFroze === 0) {
    return `No 28 °F freeze appears in this location's ${kf.yearsUsed}-year record after August 1, so a killing freeze isn't the limiting factor here.`;
  }
  return `Only ${kf.yearsFroze} of the last ${kf.yearsUsed} years saw 28 °F after August 1 — fewer than one year in ten, so there is no 1-year-in-10 date to quote. A killing freeze is not usually the limiting factor at this location.`;
}

/**
 * How often a killing freeze happens at all, when it happens in under
 * 90% of years. Below that the record is thin enough that a reader
 * deserves the count rather than just the percentiles built from it.
 *
 * @returns {string} empty when the coverage is good enough to go unsaid
 */
export function freezeCoverageNote(kf) {
  if (!kf || !kf.yearsUsed || kf.yearsFroze / kf.yearsUsed >= 0.9 || kf.yearsFroze === 0) return "";
  const skipped = kf.yearsSkipped ? ` (${kf.yearsSkipped} more had gaps and were left out)` : "";
  return `${kf.yearsFroze} of ${kf.yearsUsed} years reached 28 °F after August 1${skipped}; years that never froze are counted in these percentiles rather than dropped.`;
}

/**
 * What the solid part of the accumulation curve is made of.
 *
 * Reads the DERIVED coverage dates, not the caller's download horizon:
 * the solid line stops at knownEndOffset, so if a gap cut the record
 * short this sentence has to move with it or it contradicts the gap
 * warning elsewhere on the same screen.
 */
export function solidCaption(season, formatShort) {
  const hasForecast = season.knownEndOffset > season.observedEndOffset;
  const hasObserved = season.observedEndOffset >= 0;
  const tail = season.knownEndOffset >= season.seasonDays - 1 ? "" : " Dashed = projected.";
  if (season.knownEndOffset < 0) return "Dashed = projected.";
  if (hasForecast && !hasObserved) return `Solid = forecast through ${formatShort(season.lastKnownIso)}.${tail}`;
  if (hasForecast) return `Solid = observed through ${formatShort(season.lastObservedIso)} plus forecast through ${formatShort(season.lastKnownIso)}.${tail}`;
  // Observed only. This case used to say nothing at all about the solid
  // line, which lost the reader the one anchor the caption exists for —
  // and it is not rare: it is every past season, every run where the
  // forecast fetch failed, and every run a data gap truncated.
  return `Solid = observed through ${formatShort(season.lastObservedIso)}.${tail}`;
}

/**
 * Where the temperatures came from.
 *
 * Uses the REQUESTED horizon when a forecast contributed, because that
 * line is about the download. "Entirely on the books" is only true when
 * the WHOLE season window is known — an earlier version keyed on "the
 * forecast did not extend the curve", which is also true when the
 * forecast fetch failed and when a gap truncated the record, so it
 * announced a completed season one bullet above the bullet reporting the
 * forecast failure.
 */
export function temperatureProvenance(season, formatShort) {
  if (season.knownEndOffset > season.observedEndOffset) {
    return `Temperatures: ERA5 reanalysis via Open-Meteo for history and the current season through ${formatShort(season.requestedObservedIso, {
      withYear: true,
    })}, plus Open-Meteo's 16-day forecast through ${formatShort(season.requestedKnownIso)}.`;
  }
  const through = formatShort(season.lastObservedIso, { withYear: true });
  if (season.knownEndOffset >= season.seasonDays - 1) {
    return `Temperatures: ERA5 reanalysis via Open-Meteo through ${through}. This season is entirely on the books, so no forecast was needed.`;
  }
  return `Temperatures: ERA5 reanalysis via Open-Meteo through ${through}. No forecast is included in this run, so everything after that date is projected from the 30-year record rather than forecast.`;
}

/**
 * "There is a hole in the weather record."
 *
 * Two placements: the screen puts it directly under the GDU total it
 * qualifies (or in a card of its own when the gap left no total at all),
 * while the PDF and the shared text fold it into one data-quality line.
 * Same sentence in all three.
 */
export function gapNoteText(season) {
  if (!season.truncatedByGap) return "";
  return season.lastKnownIso
    ? "the weather record has a gap partway through this season, so the accumulated total stops before today rather than guessing across it"
    : "the weather record has a gap starting on the planting date, so nothing has accumulated";
}

/** Below this a percentile is not really a percentile. */
export const MIN_TRUSTWORTHY_YEARS = 20;

/**
 * WHAT is thin about the baseline, with no lead-in — the screen and the
 * PDF introduce it differently ("Thin baseline for this location — …"
 * versus "Data quality: the baseline is thin — …") and returning the
 * bare clause is what lets both do that without either one performing
 * string surgery on the other's wording.
 *
 * Two separate problems, because the whole-season rows and the
 * remaining-season envelope come from different windows and can be thin
 * independently; either one alone is worth saying.
 *
 * @returns {string} empty when the baseline is fine
 */
export function thinBaselineText(season, baselineYears) {
  const rest = (season.remainingYearsUsed || []).length;
  const whole = (season.yearsUsed || []).length;
  const parts = [];
  if (whole > 0 && whole < MIN_TRUSTWORTHY_YEARS) parts.push(`the whole-season rows come from ${whole} complete years, not ${baselineYears}`);
  // "come from 8 years", not "come from 8". The bare numeral only reads
  // when the whole-season clause precedes it and lends it the noun — and
  // the common case is a full 30-year whole-season baseline with a thin
  // remaining envelope, where this clause stands alone.
  if (season.currentStage !== null && rest > 0 && rest < MIN_TRUSTWORTHY_YEARS) parts.push(`the hot and cool finishes come from ${rest} years`);
  if (!parts.length) return "";
  return `${parts.join(", and ")}, and percentiles off a short record are indicative rather than a real 10th-to-90th`;
}

/**
 * Both of the above as one sentence, for the surfaces that have no room
 * to place them contextually.
 *
 * Both used to be screen-only, so the printed sheet — the artifact that
 * outlives the session and gets handed to a grower — was the silent one.
 * That is the same shape as the missing frost verdict, fixed the same
 * way.
 *
 * @returns {string} empty when the record is fine
 */
export function recordQualityNote(season, baselineYears) {
  const thin = thinBaselineText(season, baselineYears);
  const parts = [gapNoteText(season), thin ? `the baseline is thin — ${thin}` : ""].filter(Boolean);
  if (!parts.length) return "";
  return `Data quality: ${parts.join("; ")}. This usually means the weather archive has gaps at this grid point; a location a few miles away may have a fuller record.`;
}
