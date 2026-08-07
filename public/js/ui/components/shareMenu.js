// src/ui/components/shareMenu.js
//
// The top-bar share button. Same glyph and placement (immediately left
// of the Settings gear) as Corn Plot Harvest's, so a rep who uses that
// app finds this one without looking.
//
// ONE TAP, ONE OUTCOME: it builds the branded PDF report
// (core/pdfBuilder.js) and hands it straight to the OS share sheet,
// falling back to a download where there isn't one. There is deliberately
// no intermediate menu — per explicit request, and because a menu whose
// first item is what everyone wants is just a tax on getting there.
//
// The plain-text summary still exists and still gets used: it rides
// along as the share sheet's `text`, so a message app gets the headline
// numbers in the body with the PDF attached, rather than a bare
// attachment with no context.
//
// (An earlier version offered Print and Copy Summary alongside. The
// print stylesheet in gdu.css is still there and still correct — if
// those are wanted back, they need a menu again, not new plumbing.)

import { h, debounceGuard } from "../dom.js";
import { showToast } from "./toast.js";
import { formatShort, todayIso } from "../../core/dates.js";
import { buildPdf, pdfFilename } from "../../core/pdfBuilder.js";
import { loadJsPdf } from "../pdfLibLoader.js";
import { getLogoDataUrl } from "../logoCache.js";
import { shareOrDownload } from "../fileSave.js";
import { APP_VERSION } from "../../version.js";
import { recordQualityNote } from "../../core/frostText.js";
import { BASELINE_YEARS } from "../../core/season.js";

// The classic box-with-up-arrow share glyph, matching Corn Plot
// Harvest's. stroke="currentColor" so it tracks the top bar's white
// icons in both themes.
const SHARE_ICON_SVG = `
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 3 L12 14" />
  <path d="M8 6.5 L12 3 L16 6.5" />
  <path d="M7 10 H5 V21 H19 V10 H17" />
</svg>
`.trim();

/**
 * A plain-text recap of the result, for the share sheet and the
 * clipboard.
 *
 * NOTE what this deliberately does NOT do: attach a link that reproduces
 * this calculation. Results are derived from inputs held in this
 * device's own local storage, so a URL would open the app on the
 * recipient's phone showing THEIR last calculation, not this one — which
 * is worse than sending no link at all, because it looks like it worked.
 * The text carries the numbers; the attached PDF carries the charts.
 *
 * @param {Object} args
 * @returns {string}
 */
export function buildSummary({ season, hybrid, location, rows }) {
  const lines = [];
  lines.push(hybrid ? `GDU outlook — ${hybrid.label}` : "GDU accumulation");
  lines.push(`${location.label} · planted ${formatShort(season.plantingIso, { withYear: true })}`);

  if (hybrid) {
    const est = [];
    if (hybrid.silk && hybrid.silk.source !== "entered") est.push("silk");
    if (hybrid.blackLayer && hybrid.blackLayer.source !== "entered") est.push("black layer");
    lines.push(
      `Rated ${hybrid.gduToSilk.toLocaleString()} GDU to silk, ${hybrid.gduToBlackLayer.toLocaleString()} to black layer` +
        (est.length ? ` (${est.join(" and ")} estimated, not from a tech sheet)` : "")
    );
  }

  if (season.gduToDate !== null && season.gduToDate !== undefined) {
    const vs = season.gduVsNormal;
    lines.push(
      `\n${Math.round(season.gduToDate).toLocaleString()} GDU through ${formatShort(season.lastObservedIso, { withYear: true })}` +
        (vs === null ? "" : `, ${Math.abs(Math.round(vs)).toLocaleString()} ${vs >= 0 ? "ahead of" : "behind"} normal`)
    );
  }

  const cs = hybrid ? season.currentStage : null;
  if (cs) {
    lines.push("\nThis season:");
    lines.push(`  silk ${stageText(cs.silk)}`);
    lines.push(`  black layer ${stageText(cs.blackLayer)}`);
  }

  if (rows && rows.length) lines.push(cs ? "\nFor comparison:" : "\nPredicted dates:");
  for (const row of rows || []) {
    const silk = row.silkIso ? formatShort(row.silkIso, { withYear: true }) : "not reached";
    const bl = row.blackLayerIso ? formatShort(row.blackLayerIso, { withYear: true }) : "not reached";
    lines.push(`  ${row.label}: silk ${silk}, black layer ${bl}`);
  }

  // Gated on the p10, not the median. A null median can mean "fewer than
  // half the years froze", which is exactly when the 1-in-10 date is the
  // number worth sharing — gating on the median dropped the freeze line
  // entirely at those locations.
  const kf = season.killingFreeze;
  if (kf && kf.p10MonthDay) {
    const oneInTen = `1 year in 10 sees 28 °F by ${formatShort(`${season.plantingYear}-${kf.p10MonthDay}`)}`;
    // Two separate sentences rather than substituting a phrase into a
    // slot that expects a date — "Median first 28 °F freeze no freeze in
    // over half of years" was going out in the body of a message a rep
    // sends a grower.
    lines.push(
      kf.medianMonthDay
        ? `\nMedian first 28 °F freeze ${formatShort(`${season.plantingYear}-${kf.medianMonthDay}`)}; ${oneInTen}.`
        : `\n${capitalize(oneInTen)}. Fewer than half the last ${kf.yearsUsed} years froze at all, so there is no median freeze date.`
    );
  }

  // Same caveat the screen and the PDF carry. A text summary forwarded
  // without the attachment was the one surface with no data-quality
  // warning on it at all.
  const quality = recordQualityNote(season, BASELINE_YEARS);
  if (quality) lines.push(`\n${quality}`);

  lines.push("\nGDU is a heat model — it knows nothing about drought, replant, hail or disease.");
  lines.push("Generated by the GDU Calculator.");
  return lines.join("\n");
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * One collapsed stage line, carrying the same basis distinction the
 * screen and the PDF make: a date already reached cannot move, and only
 * a projected one gets a range.
 */
function stageText(s) {
  if (!s) return "not reached";
  const label = s.basis === "actual" ? "reached" : s.basis === "forecast" ? "in forecast" : "projected";
  let out = `${formatShort(s.iso, { withYear: true })} (${label})`;
  if (s.basis === "projected") {
    if (!s.reachedInEveryScenario) out += ", not reached in a cool finish";
    else if (s.spreadDays > 0) out += `, ${formatShort(s.earliestIso)}–${formatShort(s.latestIso)} hot to cool`;
  }
  return out;
}

/**
 * Builds the top-bar share button. One tap builds and shares the PDF.
 * @param {() => Object|null} getContext supplies the current
 *   season/hybrid/etc at click time, so the button can't capture stale
 *   data from a render that happened before the weather finished loading.
 * @returns {HTMLElement}
 */
export function createShareButton(getContext) {
  return h(
    "button",
    {
      type: "button",
      className: "top-bar-btn top-bar-btn-share",
      "aria-label": "Share PDF report",
      onclick: debounceGuard(() => shareReport(getContext())),
    },
    h("span", { className: "top-bar-share-icon", html: SHARE_ICON_SVG })
  );
}

/**
 * Builds the PDF and gets it out of the browser. Exported so a test can
 * drive it without synthesising a tap.
 * @param {Object|null} ctx
 */
export async function shareReport(ctx) {
  if (!ctx) {
    showToast("Nothing to share yet — the results are still loading.", { type: "error" });
    return;
  }

  // Building the document takes a beat on a phone, and a tap that looks
  // like it did nothing is worse than a slow tap that says so.
  const busy = showToast("Building the PDF…", { duration: 0 });
  try {
    const [jsPDF, logoDataUrl] = await Promise.all([
      loadJsPdf(),
      // A missing logo costs a watermark, not the report.
      ctx.brand ? getLogoDataUrl(ctx.brand).catch(() => null) : Promise.resolve(null),
    ]);
    const generatedOn = todayIso();
    const blob = buildPdf({ jsPDF, ...ctx, logoDataUrl, generatedOn, appVersion: APP_VERSION });
    busy.dismiss();
    await shareOrDownload(blob, pdfFilename({ hybrid: ctx.hybrid, location: ctx.location, generatedOn }), "application/pdf", {
      title: ctx.hybrid ? `GDU outlook — ${ctx.hybrid.label}` : `GDU accumulation — ${ctx.location.label}`,
      text: buildSummary(ctx),
    });
  } catch (e) {
    busy.dismiss();
    console.error("[share] PDF build failed", e);
    showToast(e && e.message ? e.message : "Couldn't build the PDF.", { type: "error" });
  }
}
