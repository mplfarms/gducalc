// src/core/pdfBuilder.js
//
// Builds the shareable PDF: a two-page report carrying the same numbers,
// the same two charts and the same caveats as the results screen, laid
// out for paper and for the active Brand View.
//
// ---------------------------------------------------------------
// Why the charts are drawn rather than screenshotted
// ---------------------------------------------------------------
// The obvious shortcut is to serialise the on-screen SVG, rasterise it
// to a canvas and drop a PNG into the page. It was rejected for two
// reasons, one practical and one about quality:
//
//   * The on-screen SVGs get every colour from CSS custom properties and
//     the watermark from an external <image href>. An SVG serialised out
//     of the document loses both — it renders unstyled and without the
//     logo — so "just screenshot it" turns into walking the tree
//     inlining computed styles and base64-ing the logo anyway.
//   * A raster chart is a raster chart. This is a document a seed rep
//     emails to a grower who may well print it, and vector lines stay
//     sharp at any zoom or paper size while a 2x PNG does not.
//
// Drawing natively costs more code but matches how Corn Plot Harvest's
// own PDF builds its box plots, so the two apps produce the same class
// of artifact.
//
// ---------------------------------------------------------------
// Layout conventions
// ---------------------------------------------------------------
// US Letter portrait at 612x792 pt with a 36 pt margin and Helvetica,
// all matching Corn Plot Harvest's PDF. Section headers are white on a
// filled brand-accent bar — the same treatment as the .section-header
// bars on the app's own cards — so the printed page reads as the same
// product rather than a generic export.

import { addDays, formatShort } from "./dates.js";
import { sourceLabel } from "./hybridEstimate.js";

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 36;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_H = 26;
const BOTTOM_LIMIT = PAGE_H - MARGIN - FOOTER_H;

// The chart series palette, matching the light-mode values in gdu.css.
// Fixed across Brand Views for the same reason it is on screen: two of
// the three brands are red, and a red "this season" line beside a red
// "abnormally hot" line destroys the one distinction the chart makes.
const SERIES = [
  { key: "cool", rgb: [42, 120, 214], width: 1.2, dash: null, label: "Cool (10th)" },
  { key: "hot", rgb: [235, 104, 52], width: 1.2, dash: null, label: "Hot (90th)" },
  { key: "normal", rgb: [110, 110, 110], width: 1.2, dash: [3, 2], label: "Normal" },
  { key: "lastYear", rgb: [27, 175, 122], width: 1.2, dash: null, label: "Last year" },
  { key: "current", rgb: [20, 20, 20], width: 2, dash: null, label: "This season" },
];

const INK = [22, 36, 28];
const MUTED = [95, 107, 99];
const RULE = [214, 214, 214];

/** Stage-ramp hue, mirroring the per-brand rule in gdu.css. */
function stageRampRgb(brand) {
  return brand && brand.id !== "midwestSeedGenetics" ? [218, 145, 0] : [47, 125, 79];
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return [9, 69, 44];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Alpha-composite over white — lets the band ramp be flat fills with no
 *  transparency state to manage across page breaks. */
function overWhite(rgb, alpha) {
  return rgb.map((c) => Math.round(alpha * c + (1 - alpha) * 255));
}

/**
 * jsPDF's built-in Helvetica is WinAnsi-encoded, and a character outside
 * that set does not error — it silently prints as something else. U+2212
 * MINUS SIGN came out as a double quote, so "−203 GDU" read as
 * `"203 GDU`. Everything else in this report (°, ·, em dash, curly
 * quotes) is inside WinAnsi and is fine; this maps the handful that
 * aren't onto their nearest ASCII equivalent.
 */
const PDF_CHAR_FIXES = [
  [/\u2212/g, "-"], // minus sign -> hyphen
  [/\u2011/g, "-"], // non-breaking hyphen
  [/\u2248/g, "~"], // almost equal to
  [/\u00a0/g, " "], // non-breaking space
];

function pdfSafe(value) {
  let out = String(value);
  for (const [re, to] of PDF_CHAR_FIXES) out = out.replace(re, to);
  return out;
}

function sanitize(s) {
  return String(s || "")
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40);
}

/**
 * @param {Object} args
 * @returns {string} e.g. "GDU-Outlook_NC-09-90-PCE_Missouri-Valley-IA_2026-08-04.pdf"
 */
export function pdfFilename({ hybrid, location, generatedOn }) {
  return ["GDU-Outlook", sanitize(hybrid.label), sanitize(location.label), generatedOn].filter(Boolean).join("_") + ".pdf";
}

/**
 * @param {Object} args
 * @param {any} args.jsPDF the constructor, from ui/pdfLibLoader.js
 * @param {Object} args.season buildSeason() output
 * @param {Object} args.hybrid validatedHybrid().value
 * @param {Object} args.location
 * @param {Object|null} args.brand active Brand View
 * @param {string|null} args.logoDataUrl
 * @param {Array} args.stages datedStages() output for the chosen scenario
 * @param {string} args.scenarioLabel which scenario the stage dates use
 * @param {string} args.generatedOn ISO date, passed in so the caller owns
 *   the clock and the output is reproducible in a test
 * @param {string} args.appVersion
 * @returns {Blob}
 */
export function buildPdf({ jsPDF, season, hybrid, location, brand, logoDataUrl, stages, scenarioLabel, generatedOn, appVersion }) {
  const doc = new jsPDF({ unit: "pt", format: [PAGE_W, PAGE_H], orientation: "portrait" });

  // Route every string through pdfSafe once, here, rather than at ~25
  // call sites where one would inevitably get missed.
  const rawText = doc.text.bind(doc);
  doc.text = (txt, x, yy, opts) => rawText(Array.isArray(txt) ? txt.map(pdfSafe) : pdfSafe(txt), x, yy, opts);
  const accent = hexToRgb(brand ? brand.accent : null);
  const chrome = hexToRgb(brand ? brand.chrome : null);

  let y = MARGIN;

  // ---- primitives ------------------------------------------------
  const setFill = (rgb) => doc.setFillColor(rgb[0], rgb[1], rgb[2]);
  const setStroke = (rgb) => doc.setDrawColor(rgb[0], rgb[1], rgb[2]);
  const setText = (rgb) => doc.setTextColor(rgb[0], rgb[1], rgb[2]);

  function dash(pattern) {
    // jsPDF 2.x only; guarded because a dash-less line is a cosmetic
    // loss, not a broken document.
    if (typeof doc.setLineDashPattern === "function") doc.setLineDashPattern(pattern || [], 0);
  }

  /** Every page gets the brand rule at the top edge and the footer. */
  function decoratePage() {
    setFill(chrome);
    doc.rect(0, 0, PAGE_W, 5, "F");
  }

  function newPage() {
    doc.addPage([PAGE_W, PAGE_H], "portrait");
    decoratePage();
    y = MARGIN;
  }

  /**
   * Breaks to a new page when `needed` points won't fit.
   *
   * This is the ONLY thing that starts a page. An earlier draft also
   * called newPage() directly to force the Growth Stages section onto a
   * fresh sheet, which produced a page containing one orphaned caption
   * and nothing else whenever the preceding section happened to overflow
   * first. Sections declare how much room they need instead and let the
   * break fall where it falls.
   */
  function ensureSpace(needed) {
    if (y + needed > BOTTOM_LIMIT) newPage();
  }

  /**
   * Mirrors the app's own .section-header: white on a filled accent bar.
   * `keepWith` is how much of what follows must stay on the same page —
   * without it a header can print at the bottom of one sheet with its
   * chart at the top of the next.
   */
  function sectionHeader(title, keepWith = 0) {
    ensureSpace(34 + keepWith);
    setFill(accent);
    doc.roundedRect(MARGIN, y, CONTENT_W, 18, 3, 3, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    setText([255, 255, 255]);
    doc.text(title, MARGIN + 8, y + 12.5);
    setText(INK);
    y += 26;
  }

  function paragraph(text, { size = 8, color = MUTED, style = "normal", gap = 8 } = {}) {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    setText(color);
    const lines = doc.splitTextToSize(text, CONTENT_W);
    ensureSpace(lines.length * (size + 2) + gap);
    for (const line of lines) {
      doc.text(line, MARGIN, y + size * 0.85);
      y += size + 2;
    }
    y += gap;
    setText(INK);
  }

  // ---- title block -----------------------------------------------
  decoratePage();

  if (logoDataUrl) {
    try {
      const props = doc.getImageProperties(logoDataUrl);
      const maxH = 40;
      const maxW = 130;
      const scale = Math.min(maxW / props.width, maxH / props.height);
      const w = props.width * scale;
      const h = props.height * scale;
      doc.addImage(logoDataUrl, "PNG", MARGIN + CONTENT_W - w, y, w, h);
    } catch (e) {
      // A missing logo must never cost the whole report.
    }
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(19);
  setText(accent);
  doc.text("GDU Outlook", MARGIN, y + 16);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  setText(INK);
  doc.text(doc.splitTextToSize(hybrid.label, CONTENT_W - 150)[0], MARGIN, y + 33);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  setText(MUTED);
  doc.text(`${location.label}  ·  planted ${formatShort(season.plantingIso, { withYear: true })}`, MARGIN, y + 47);
  y += 56;
  setStroke(accent);
  doc.setLineWidth(1.5);
  doc.line(MARGIN, y, MARGIN + CONTENT_W, y);
  doc.setLineWidth(0.5);
  y += 13;

  // ---- hybrid ratings + status ------------------------------------
  sectionHeader("The Hybrid");
  const ratingRows = [
    ["Field", location.label],
    ["Planted", formatShort(season.plantingIso, { withYear: true })],
  ];
  if (hybrid.rm) ratingRows.push(["Relative maturity", `${hybrid.rm} day`]);
  ratingRows.push(
    ["GDUs to silk", `${hybrid.gduToSilk.toLocaleString()}${labelSuffix(hybrid.silk, hybrid.rm)}`],
    ["GDUs to black layer", `${hybrid.gduToBlackLayer.toLocaleString()}${labelSuffix(hybrid.blackLayer, hybrid.rm)}`]
  );
  drawKeyValues(ratingRows);

  if (hybrid.anyEstimated) {
    calloutBox(
      "Some of this hybrid's ratings were estimated from the built-in list, not read off a tech sheet. Every date in this report inherits that — see the method note at the end.",
      hexToRgb(brand ? brand.highlight : "#FEBE10")
    );
  }

  if (season.gduToDate !== null && season.gduToDate !== undefined) {
    const vs = season.gduVsNormal;
    statRow([
      [Math.round(season.gduToDate).toLocaleString(), "GDU accumulated"],
      [vs === null ? "—" : `${vs >= 0 ? "+" : "−"}${Math.abs(Math.round(vs)).toLocaleString()}`, vs >= 0 ? "GDU ahead of normal" : "GDU behind normal"],
      [String(season.observedEndOffset + 1), "days since planting"],
    ]);
    paragraph(`Observed through ${formatShort(season.lastObservedIso, { withYear: true })}, then the 16-day forecast, then projected.`);
  }

  // ---- accumulation chart -----------------------------------------
  sectionHeader("GDU Accumulation", 200);
  drawAccumulationChart();

  // ---- predicted stage dates --------------------------------------
  sectionHeader("Predicted Stage Dates");
  drawScenarioTable();

  // ---- stages ------------------------------------------------------
  // Header + caption + the whole 360pt chart travel together.
  sectionHeader("Growth Stages", 400);
  paragraph(`Dates shown for: ${scenarioLabel}. Planting, Silks and Maturity sit exactly on the hybrid's own numbers; every stage between them is scaled from Iowa State's published GDU ladder and is an estimate.`);
  drawStageChart();

  // ---- frost -------------------------------------------------------
  sectionHeader("Frost Risk", 60);
  drawFrost();

  // ---- method ------------------------------------------------------
  sectionHeader("How These Numbers Were Made");
  for (const line of methodLines()) paragraph(`•  ${line}`, { gap: 3 });

  // ---- footers -----------------------------------------------------
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    setStroke(RULE);
    doc.line(MARGIN, PAGE_H - MARGIN - 16, MARGIN + CONTENT_W, PAGE_H - MARGIN - 16);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    setText(MUTED);
    const left = `${brand ? brand.displayName : "GDU Calculator"}  ·  gducalc.mplfarms.com  ·  generated ${formatShort(generatedOn, { withYear: true })}  ·  ${appVersion}`;
    doc.text(left, MARGIN, PAGE_H - MARGIN - 5);
    doc.text(`Page ${p} of ${pages}`, MARGIN + CONTENT_W, PAGE_H - MARGIN - 5, { align: "right" });
  }

  return doc.output("blob");

  // =================================================================
  // helpers that close over doc/y
  // =================================================================

  function labelSuffix(rv, rm) {
    const src = rv ? sourceLabel(rv, rm) : null;
    return src ? `   (${src})` : "";
  }

  function drawKeyValues(rows) {
    doc.setFontSize(9);
    for (const [k, v] of rows) {
      ensureSpace(16);
      doc.setFont("helvetica", "normal");
      setText(MUTED);
      doc.text(k, MARGIN + 2, y + 8);
      doc.setFont("helvetica", "bold");
      setText(INK);
      doc.text(doc.splitTextToSize(String(v), CONTENT_W - 150)[0], MARGIN + CONTENT_W - 2, y + 8, { align: "right" });
      y += 13;
      setStroke(RULE);
      doc.line(MARGIN, y, MARGIN + CONTENT_W, y);
      y += 3;
    }
    y += 8;
  }

  function calloutBox(text, ruleRgb) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    const lines = doc.splitTextToSize(text, CONTENT_W - 22);
    const h = lines.length * 10 + 12;
    ensureSpace(h + 8);
    setFill([250, 250, 248]);
    doc.rect(MARGIN, y, CONTENT_W, h, "F");
    setFill(ruleRgb);
    doc.rect(MARGIN, y, 3, h, "F");
    setText(INK);
    let ty = y + 14;
    for (const line of lines) {
      doc.text(line, MARGIN + 12, ty);
      ty += 10;
    }
    y += h + 10;
  }

  function statRow(stats) {
    const h = 38;
    ensureSpace(h + 10);
    const gap = 8;
    const w = (CONTENT_W - gap * (stats.length - 1)) / stats.length;
    stats.forEach(([value, label], i) => {
      const x = MARGIN + i * (w + gap);
      setFill([246, 248, 245]);
      doc.roundedRect(x, y, w, h, 3, 3, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      setText(accent);
      doc.text(value, x + w / 2, y + 17, { align: "center" });
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.8);
      setText(MUTED);
      doc.text(doc.splitTextToSize(label.toUpperCase(), w - 8), x + w / 2, y + 28, { align: "center" });
    });
    setText(INK);
    y += h + 12;
  }

  function drawWatermark(x, yTop, w, h) {
    if (!logoDataUrl) return;
    try {
      const props = doc.getImageProperties(logoDataUrl);
      const maxH = Math.min(30, h * 0.16);
      const maxW = Math.min(90, w * 0.28);
      const scale = Math.min(maxW / props.width, maxH / props.height);
      const iw = props.width * scale;
      const ih = props.height * scale;
      const GS = doc.GState || (typeof window !== "undefined" && window.jspdf && window.jspdf.GState);
      if (GS && typeof doc.setGState === "function") {
        doc.setGState(new GS({ opacity: 0.16 }));
        doc.addImage(logoDataUrl, "PNG", x + w - iw - 6, yTop + h - ih - 6, iw, ih);
        doc.setGState(new GS({ opacity: 1 }));
      }
      // No GState support means no watermark rather than an opaque logo
      // sitting on top of the data.
    } catch (e) {
      /* cosmetic only */
    }
  }

  function drawAccumulationChart() {
    const h = 196;
    ensureSpace(h + 40);
    const plot = { x: MARGIN + 34, y, w: CONTENT_W - 34 - 62, h: h - 22 };

    const series = SERIES.map((s) => ({ ...s, scenario: season.scenarios.find((x) => x.key === s.key) })).filter((s) => s.scenario);

    let lastInteresting = Math.max(season.knownEndOffset, 0);
    for (const row of season.rows) {
      for (const o of [row.silkOffset, row.blackLayerOffset]) if (o !== null && o > lastInteresting) lastInteresting = o;
    }
    const xMax = Math.min(season.seasonDays - 1, lastInteresting + 12);

    let yMax = hybrid.gduToBlackLayer;
    for (const s of series) {
      for (let i = 0; i <= xMax; i++) if (Number.isFinite(s.scenario.cum[i]) && s.scenario.cum[i] > yMax) yMax = s.scenario.cum[i];
    }
    yMax = Math.ceil((yMax * 1.04) / 100) * 100;

    const px = (o) => plot.x + (o / xMax) * plot.w;
    const py = (g) => plot.y + plot.h - (g / yMax) * plot.h;

    // grid + y labels
    doc.setFontSize(6.5);
    doc.setFont("helvetica", "normal");
    const step = yMax > 3000 ? 1000 : 500;
    for (let v = 0; v <= yMax; v += step) {
      setStroke(RULE);
      doc.line(plot.x, py(v), plot.x + plot.w, py(v));
      setText(MUTED);
      doc.text(v >= 1000 ? `${v / 1000}k` : String(v), plot.x - 4, py(v) + 2, { align: "right" });
    }
    // x labels at month starts
    for (let o = 0; o <= xMax; o++) {
      const iso = addDays(season.plantingIso, o);
      if (o !== 0 && iso.slice(8, 10) !== "01") continue;
      if (o !== 0 && o < 8) continue;
      setText(MUTED);
      doc.text(o === 0 ? "Plant" : formatShort(iso).split(" ")[0], px(o), plot.y + plot.h + 10, { align: o === 0 ? "left" : "center" });
    }

    // 10th-90th band
    const cool = series.find((s) => s.key === "cool");
    const hot = series.find((s) => s.key === "hot");
    if (cool && hot) {
      const pts = [];
      for (let i = 0; i <= xMax; i++) if (Number.isFinite(hot.scenario.cum[i])) pts.push([px(i), py(hot.scenario.cum[i])]);
      for (let i = xMax; i >= 0; i--) if (Number.isFinite(cool.scenario.cum[i])) pts.push([px(i), py(cool.scenario.cum[i])]);
      if (pts.length > 2) {
        setFill([240, 240, 238]);
        polygon(pts, "F");
      }
    }

    // stage reference lines
    dash([2, 2]);
    setStroke([120, 120, 120]);
    for (const [value, text] of [
      [hybrid.gduToSilk, "Silk"],
      [hybrid.gduToBlackLayer, "Black layer"],
    ]) {
      if (value > yMax) continue;
      doc.line(plot.x, py(value), plot.x + plot.w, py(value));
      doc.setFont("helvetica", "bold");
      doc.setFontSize(6.5);
      setText(INK);
      doc.text(`${text} — ${Math.round(value).toLocaleString()} GDU`, plot.x + 4, py(value) - 3);
    }
    dash([]);

    // series
    const endLabels = [];
    for (const s of series) {
      setStroke(s.rgb);
      doc.setLineWidth(s.width);
      dash(s.dash);
      let started = false;
      let prev = null;
      for (let i = 0; i <= xMax; i++) {
        const v = s.scenario.cum[i];
        if (!Number.isFinite(v)) {
          started = false;
          continue;
        }
        const pt = [px(i), py(v)];
        // Dashed once past the last day backed by real data, matching the
        // on-screen convention that a projection looks different.
        if (started && prev) {
          if (i > s.scenario.solidThroughOffset && !s.dash) dash([2.5, 2.5]);
          doc.line(prev[0], prev[1], pt[0], pt[1]);
        }
        prev = pt;
        started = true;
      }
      dash([]);
      doc.setLineWidth(0.5);

      const endIdx = lastFiniteIdx(s.scenario.cum, xMax);
      if (endIdx >= 0) endLabels.push({ y: py(s.scenario.cum[endIdx]), label: s.label, rgb: s.rgb, bold: s.key === "current" });
    }

    // Direct labels at the right edge, pushed apart so they never print
    // on top of each other — scenarios routinely finish within a few
    // GDU of one another, and on paper there is no hover to fall back on.
    endLabels.sort((a, b) => a.y - b.y);
    const MIN_GAP = 8;
    for (let i = 1; i < endLabels.length; i++) {
      if (endLabels[i].y - endLabels[i - 1].y < MIN_GAP) endLabels[i].y = endLabels[i - 1].y + MIN_GAP;
    }
    const overflow = endLabels.length ? endLabels[endLabels.length - 1].y - (plot.y + plot.h) : 0;
    if (overflow > 0) for (const l of endLabels) l.y -= overflow;
    for (const l of endLabels) {
      doc.setFont("helvetica", l.bold ? "bold" : "normal");
      doc.setFontSize(6.5);
      setText(l.rgb);
      doc.text(l.label, plot.x + plot.w + 4, l.y + 2);
    }

    drawWatermark(plot.x, plot.y, plot.w, plot.h);
    setText(INK);
    y += h + 6;
    paragraph(
      season.knownEndOffset > season.observedEndOffset
        ? `Solid = observed through ${formatShort(season.lastObservedIso)} plus forecast through ${formatShort(season.lastKnownIso)}. Dashed = projected.`
        : "Dashed = projected.",
      { size: 7, gap: 10 }
    );
  }

  function polygon(pts, style) {
    if (typeof doc.lines !== "function") return;
    const deltas = [];
    for (let i = 1; i < pts.length; i++) deltas.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
    doc.lines(deltas, pts[0][0], pts[0][1], [1, 1], style, true);
  }

  function lastFiniteIdx(arr, maxIdx) {
    for (let i = Math.min(maxIdx, arr.length - 1); i >= 0; i--) if (Number.isFinite(arr[i])) return i;
    return -1;
  }

  function drawScenarioTable() {
    const cols = [CONTENT_W * 0.44, CONTENT_W * 0.28, CONTENT_W * 0.28];
    ensureSpace(28);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    setText(MUTED);
    doc.text("SCENARIO", MARGIN, y + 7);
    doc.text(`SILK (${hybrid.gduToSilk.toLocaleString()})`, MARGIN + cols[0], y + 7);
    doc.text(`BLACK LAYER (${hybrid.gduToBlackLayer.toLocaleString()})`, MARGIN + cols[0] + cols[1], y + 7);
    y += 11;
    setStroke(RULE);
    doc.line(MARGIN, y, MARGIN + CONTENT_W, y);
    y += 4;

    for (const row of season.rows) {
      ensureSpace(20);
      const isCurrent = row.key.startsWith("current-");
      if (isCurrent) {
        setFill(accent);
        doc.rect(MARGIN - 4, y - 1, 2, 14, "F");
      }
      doc.setFont("helvetica", isCurrent ? "bold" : "normal");
      doc.setFontSize(8.5);
      setText(INK);
      doc.text(doc.splitTextToSize(row.label, cols[0] - 6)[0], MARGIN, y + 8);
      doc.setFont("helvetica", "normal");
      doc.text(row.silkIso ? formatShort(row.silkIso, { withYear: true }) : "not reached", MARGIN + cols[0], y + 8);
      doc.text(row.blackLayerIso ? formatShort(row.blackLayerIso, { withYear: true }) : "not reached", MARGIN + cols[0] + cols[1], y + 8);
      y += 15;
      setStroke([238, 238, 238]);
      doc.line(MARGIN, y, MARGIN + CONTENT_W, y);
      y += 3;
    }
    y += 6;
    paragraph(
      "The three “this season” rows share identical observed and forecast data and differ only in how the rest of the year turns out. Treat the spread between them as the answer, not any single date.",
      { size: 7 }
    );
  }

  function drawStageChart() {
    const h = 360;
    ensureSpace(h + 16);
    const plot = { x: MARGIN + 34, y, w: CONTENT_W - 40, h };
    const maxGdu = stages[stages.length - 1].gdu;
    const yMax = Math.ceil((maxGdu * 1.02) / 100) * 100;
    const py = (g) => plot.y + plot.h - (g / yMax) * plot.h;
    const ramp = stageRampRgb(brand);

    // y axis
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    const step = yMax > 3000 ? 1000 : 500;
    for (let v = 0; v <= yMax; v += step) {
      setText(MUTED);
      doc.text(v >= 1000 ? `${v / 1000}k` : String(v), plot.x - 4, py(v) + 2, { align: "right" });
    }

    const bandCount = stages.length - 1;
    for (let i = 0; i < bandCount; i++) {
      const from = stages[i];
      const to = stages[i + 1];
      const top = py(to.gdu);
      const bottom = py(from.gdu);
      const bandH = bottom - top;
      setFill(overWhite(ramp, 0.09 + (i / Math.max(1, bandCount - 1)) * 0.42));
      doc.rect(plot.x, top, plot.w, Math.max(bandH, 0.5), "F");
      setStroke([255, 255, 255]);
      doc.setLineWidth(1);
      doc.line(plot.x, top, plot.x + plot.w, top);
      doc.setLineWidth(0.5);

      if (bandH < 9) continue;
      doc.setFont("helvetica", from.anchored ? "bold" : "normal");
      doc.setFontSize(8);
      setText(INK);
      const text = `${from.label}${from.iso ? ` (~ ${formatShort(from.iso, { withYear: true })})` : " (not reached)"}`;
      doc.text(text, plot.x + plot.w / 2, top + bandH / 2 + 3, { align: "center" });
    }

    // maturity caps the stack
    const maturity = stages[stages.length - 1];
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    setText(INK);
    doc.text(
      maturity.iso ? `${maturity.label} (~ ${formatShort(maturity.iso, { withYear: true })})` : `${maturity.label} — not reached`,
      plot.x + plot.w / 2,
      py(maturity.gdu) - 5,
      { align: "center" }
    );

    // progress gutter + today rule
    if (Number.isFinite(season.gduToDate) && season.gduToDate > 0) {
      const capped = Math.min(season.gduToDate, yMax);
      setFill([90, 90, 90]);
      doc.rect(plot.x, py(capped), 9, plot.y + plot.h - py(capped), "F");
      setStroke([201, 74, 74]);
      dash([3, 2]);
      doc.line(plot.x, py(capped), plot.x + plot.w, py(capped));
      dash([]);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7);
      setText(INK);
      doc.text(`${Math.round(season.gduToDate).toLocaleString()} GDU through ${formatShort(season.lastObservedIso)}`, plot.x + plot.w - 3, py(capped) - 4, {
        align: "right",
      });
    }

    y += h + 14;
  }

  function drawFrost() {
    const kf = season.killingFreeze;
    if (!kf || !kf.medianMonthDay) {
      paragraph("No 28 °F freeze appears in this location's 30-year record after August 1, so a killing freeze isn't the limiting factor here.", { color: INK });
      return;
    }
    const yr = season.plantingYear;
    statRow([
      [formatShort(`${yr}-${kf.p10MonthDay}`), "28 °F by this date 1 yr in 10"],
      [formatShort(`${yr}-${kf.medianMonthDay}`), "median 28 °F freeze"],
      [season.lightFrost && season.lightFrost.medianMonthDay ? formatShort(`${yr}-${season.lightFrost.medianMonthDay}`) : "—", "median 32 °F frost"],
    ]);
    paragraph(
      "Read these as the LATE end of the range. Checked against real thermometer records near Missouri Valley, Iowa for 1996–2025, this gridded dataset put the median first 32 °F at Oct 26 where nearby stations measured Oct 19 and Oct 7. GDU accumulation itself checked out to within about 1% of the nearest station; it's the frost dates specifically that run late, because they hinge on one night's minimum rather than a season of averages."
    );
  }

  function methodLines() {
    const yrs = season.yearsUsed || [];
    const lines = [
      "GDU = (min(daily high, 86 °F) + max(daily low, 50 °F)) ÷ 2 − 50 — the modified base-50/86 method US seed companies rate hybrids on. A day below 50 °F counts 0, never a negative; heat above 86 °F adds nothing. Accumulation starts on the planting date itself.",
      `Normal, hot and cool are the 50th, 90th and 10th percentiles of accumulation across ${yrs.length} complete years (${yrs[0]}–${yrs[yrs.length - 1]}) at this exact grid point — an envelope, not a replay of any one year.`,
      `Temperatures: ERA5 reanalysis via Open-Meteo through ${formatShort(season.lastObservedIso, { withYear: true })}, plus Open-Meteo's 16-day forecast. Grid point ${location.lat.toFixed(4)}, ${location.lon.toFixed(4)}.`,
      "Growth stages between Planting, Silks and Maturity are scaled from Iowa State's published GDU ladder for a 2,700-GDU hybrid and are estimates; the three named stages are the hybrid's own figures.",
    ];
    if (hybrid.anyEstimated) {
      const parts = [];
      for (const [name, rv] of [["Silk", hybrid.silk], ["Black layer", hybrid.blackLayer]]) {
        const src = sourceLabel(rv, hybrid.rm);
        if (src) parts.push(`${name} ${rv.value.toLocaleString()} GDU was ${src}`);
      }
      lines.push(
        `${parts.join("; ")}. Estimates come from a least-squares fit on all 72 hybrids in the built-in list, with error measured by leaving each hybrid out of the fit and predicting it. Relative maturity is the weakest basis — the worst hybrid in the list sits 472 GDU off its maturity's trend, about three weeks of grain fill.`
      );
    }
    lines.push("GDU is a heat model, not a crop model. It knows nothing about drought, saturated soils, replant, hail, disease or nitrogen — any of which can move real silk and black layer dates well off these numbers.");
    return lines;
  }
}
