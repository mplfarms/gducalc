// test/pdf_pages.mjs
//
// The PDF has a hard TWO-PAGE budget: one sheet, printed double-sided,
// which is what actually gets handed to a grower. A third sheet carrying
// nothing but a footer is a real defect, not a cosmetic one.
//
// ---------------------------------------------------------------
// Why this file exists separately from e2e_smoke.mjs
// ---------------------------------------------------------------
// e2e_smoke.mjs already checks the page count, but only through the app's
// own happy path, and its synthetic weather freezes in all 30 years with
// hybrids well inside the fitted range. That leaves three conditional
// blocks it can NEVER reach:
//
//   * the frost coverage note (fires when under 90% of years froze)
//   * the extrapolation caveat (fires outside the fitted RM / GDU range)
//   * the thin-baseline note (fires when the remaining-season envelope
//     is built from under 20 years)
//
// The v3.5 audit added text to two of those and pushed an RM-estimated
// hybrid onto a third sheet. The e2e suite stayed green throughout. This
// file drives buildPdf directly with each conditional forced on, alone
// and in combination, so the budget is checked where it is actually
// tight rather than only where it is comfortable.
//
// Every case also asserts that the block it is named after ACTUALLY
// RENDERED. Without that a fixture can drift out of the shape the code
// reads — the first version of this file built remainingYearsUsed as a
// 220-element array where the real one is a list of ~30 year numbers, so
// three "thin baseline" cases rendered no thin-baseline note and passed
// anyway. A layout test that silently stops exercising its own branch is
// worse than no test, because it reads as coverage.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { jsPDF } from "jspdf";
import { buildPdf } from "../public/js/core/pdfBuilder.js";
import { buildSeason } from "../public/js/core/season.js";
import { buildDailyIndex, offsetAtTarget } from "../public/js/core/gdu.js";
import { addDays, daysBetween } from "../public/js/core/dates.js";
import { resolve } from "../public/js/core/hybridEstimate.js";
import { stagesForHybrid, datedStages } from "../public/js/core/stages.js";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

// ---------------------------------------------------------------
// Fixture: a sinusoidal year so stage dates land mid-season and the
// stage chart has a realistic amount to draw.
// ---------------------------------------------------------------
function allDays(a, b) {
  const out = [];
  for (let i = 0; i <= daysBetween(a, b); i++) out.push(addDays(a, i));
  return out;
}

const TIME = allDays("1995-01-01", "2026-08-21");
const doy = (d) => daysBetween(`${d.slice(0, 4)}-01-01`, d);
const TMAX = TIME.map((d) => 60 + 32 * Math.sin(((doy(d) - 100) / 365) * 2 * Math.PI) + ((Number(d.slice(0, 4)) % 5) - 2) * 3);
const INDEX = buildDailyIndex([{ time: TIME, tmax: TMAX, tmin: TMAX.map((t) => t - 22), source: "observed" }]);

/** @returns {{pages: number, label: string}} */
function render({ input, kf, thin, noHybrid, planted }, ctor) {
  let hybrid = null;
  if (!noHybrid) {
    const r = resolve(input);
    assert.equal(r.ok, true, `fixture input rejected: ${r.error}`);
    hybrid = {
      label: "TEST 09-90 PCE",
      gduToSilk: r.silk.value,
      gduToBlackLayer: r.blackLayer.value,
      rm: r.rm,
      silk: r.silk,
      blackLayer: r.blackLayer,
      anyEstimated: r.anyEstimated,
      rmOutsideFit: r.rmOutsideFit,
      basisOutsideFit: r.basisOutsideFit,
    };
  }
  const season = buildSeason({
    index: INDEX,
    plantingIso: planted || "2026-05-01",
    gduToSilk: hybrid ? hybrid.gduToSilk : null,
    gduToBlackLayer: hybrid ? hybrid.gduToBlackLayer : null,
    lastKnownIso: "2026-08-21",
    lastObservedIso: "2026-08-06",
  });
  // Forcing the conditionals on directly. Building weather that produces
  // "26 of 30 years froze" is possible but makes the fixture about the
  // weather rather than about the layout.
  if (kf) season.killingFreeze = { ...season.killingFreeze, ...kf };
  // A list of YEAR NUMBERS, which is what buildSeason actually produces.
  // The first version of this filled a 220-element array, whose .length
  // is 220 — so the thin-baseline note it was named after never rendered
  // and three of these cases quietly tested nothing. Same wrong reading
  // the code under test had, which is exactly how the two agreed.
  if (thin) season.remainingYearsUsed = Array.from({ length: thin }, (_, i) => 2025 - i);

  const cur = season.scenarios.find((s) => s.key === "current");
  if (!cur) throw new Error("fixture produced no current-season scenario");
  const stages = hybrid
    ? datedStages(stagesForHybrid(hybrid.gduToSilk, hybrid.gduToBlackLayer), cur.cum, planted || "2026-05-01", cur.solidThroughOffset, { offsetAtTarget, addDays })
    : null;

  const blob = buildPdf({
    jsPDF: ctor || jsPDF,
    season,
    hybrid,
    location: { label: "Missouri Valley, IA", lat: 41.5644, lon: -95.8913 },
    brand: null,
    logoDataUrl: null,
    stages,
    scenarioLabel: "This season",
    generatedOn: "2026-08-06",
    appVersion: "test",
  });
  return blob;
}

async function pageCount(blob) {
  const txt = Buffer.from(await blob.arrayBuffer()).toString("latin1");
  return (txt.match(/\/Type\s*\/Page[^s]/g) || []).length;
}

/**
 * A jsPDF that records every string drawn, so a case can prove the block
 * it is named after was on the page rather than assuming it.
 */
function recordingJsPdf(sink) {
  return function Recording(...args) {
    const doc = new jsPDF(...args);
    const realText = doc.text.bind(doc);
    doc.text = (txt, ...rest) => {
      for (const t of Array.isArray(txt) ? txt : [txt]) sink.push(String(t));
      return realText(txt, ...rest);
    };
    return doc;
  };
}

/** Phrases that prove each conditional block was drawn. */
const MARKERS = {
  extrapolation: "Extrapolation warning",
  frostCoverage: "reached 28",
  thinBaseline: "baseline years had complete data",
  verdict: /margin|short of black layer|too long for this location/,
  noFreeze: /no 28 .F freeze|fewer than one year in ten|nothing to base a frost date on/i,
};

// ---------------------------------------------------------------
console.log("\npdfBuilder.js — the two-page budget");
// ---------------------------------------------------------------

const CASES = [
  ["both GDU numbers entered", { input: { gduToSilk: 1250, gduToBlackLayer: 2650 } }, ["verdict"]],
  ["silk entered, black layer estimated", { input: { gduToSilk: 1250 } }, ["verdict"]],
  ["black layer entered, silk estimated", { input: { gduToBlackLayer: 2900 } }, ["verdict"]],
  ["RM only — both numbers estimated", { input: { rm: 100 } }, ["verdict"]],
  ["no hybrid at all", { noHybrid: true }],

  // Each conditional block on its own.
  ["RM only, outside the fitted RM range", { input: { rm: 119 } }, ["extrapolation"]],
  ["RM only, below the fitted RM range", { input: { rm: 76 } }, ["extrapolation"]],
  ["black layer 3,600 — basis outside the fitted range", { input: { gduToBlackLayer: 3600 } }, ["extrapolation"]],
  ["RM only, with the frost coverage note", { input: { rm: 100 }, kf: { yearsUsed: 30, yearsFroze: 26 } }, ["frostCoverage"]],
  ["RM only, with a thin remaining-season baseline", { input: { rm: 100 }, thin: 8 }, ["thinBaseline"]],

  // Every conditional at once — the worst case that can actually ship.
  [
    "RM outside fit + frost coverage note + thin baseline + skipped years",
    { input: { rm: 119 }, kf: { yearsUsed: 28, yearsFroze: 22, yearsSkipped: 2 }, thin: 8 },
    ["extrapolation", "frostCoverage", "thinBaseline", "verdict"],
  ],
  [
    "silk-only estimate + every note",
    { input: { gduToSilk: 1420 }, kf: { yearsUsed: 28, yearsFroze: 22, yearsSkipped: 2 }, thin: 8 },
    ["frostCoverage", "thinBaseline", "verdict"],
  ],

  // The no-p10 frost branch replaces the whole section, so it should be
  // shorter — but it is longer per line, so it gets checked too.
  [
    "a location with no reportable freeze",
    { input: { rm: 119 }, kf: { p10MonthDay: null, medianMonthDay: null, yearsUsed: 30, yearsFroze: 2 }, thin: 8 },
    ["noFreeze"],
  ],
  [
    "a location whose record is entirely holed",
    { input: { rm: 119 }, kf: { p10MonthDay: null, medianMonthDay: null, yearsUsed: 0, yearsFroze: 0, yearsSkipped: 30 } },
    ["noFreeze"],
  ],

  // The verdict is NOT a fixed-height block, which is what the first
  // version of flexBudget assumed. These three are the wordings that wrap
  // to a second line, and none of them was reachable before: the earlier
  // "no median" cases also nulled p10MonthDay, so the p10-present /
  // median-censored combination — the exact state the censoring rewrite
  // was built for — had never been rendered at all.
  [
    "a mild location: a 1-in-10 date but no median freeze",
    { input: { rm: 100 }, kf: { p10MonthDay: "10-10", medianMonthDay: null, yearsUsed: 30, yearsFroze: 8 } },
    ["verdict", "frostCoverage"],
  ],
  [
    "a hybrid too long to finish, at a mild location, with every note",
    { input: { rm: 119 }, planted: "2026-06-15", kf: { p10MonthDay: "09-28", medianMonthDay: null, yearsUsed: 28, yearsFroze: 9, yearsSkipped: 2 }, thin: 8 },
    ["verdict", "frostCoverage", "thinBaseline", "extrapolation"],
  ],
  [
    "a late planting whose cool finish lands past the 1-in-10 freeze",
    { input: { rm: 110 }, planted: "2026-06-10", kf: { p10MonthDay: "10-01", medianMonthDay: "10-18", yearsUsed: 30, yearsFroze: 29 } },
    ["verdict"],
  ],
];

for (const [name, opts, expect = []] of CASES) {
  const drawn = [];
  const pages = await pageCount(render(opts, recordingJsPdf(drawn)));
  const all = drawn.join(" ");
  check(`${name} fits on two sheets`, () => assert.ok(pages <= 2, `ran to ${pages} pages`));
  for (const key of expect) {
    const m = MARKERS[key];
    check(`${name} — the ${key} block is actually on the page`, () =>
      assert.ok(typeof m === "string" ? all.includes(m) : m.test(all), `no ${key} text was drawn`)
    );
  }
}

// ---------------------------------------------------------------
// The measure/draw invariant, checked structurally
// ---------------------------------------------------------------
//
// Two of the blocks flexBudget() reserves for are DRAWN bold and were
// once MEASURED normal — bold is wider, so that silently under-reserves.
// No page-count fixture can feel it: the worst configuration still has
// ~23 pt of slack and the error is ~10.
//
// So this checks the invariant directly instead of hoping a fixture
// trips over it. Each style constant must appear exactly twice — once
// handed to measureParagraph and once spread into the paragraph call —
// which is what makes the two provably the same font, size and weight.
// A source-level check is crude, but the alternative is an invariant
// with nothing holding it.
const SRC = readFileSync(new URL("../public/js/core/pdfBuilder.js", import.meta.url), "utf8");
for (const name of ["VERDICT_STYLE", "THIN_STYLE"]) {
  check(`${name} is measured and drawn from the same constant`, () => {
    assert.match(SRC, new RegExp(`measureParagraph\\([\\s\\S]{0,80}?${name}[,)]`), `${name} is not what measureParagraph is given`);
    assert.match(SRC, new RegExp(`\\.\\.\\.${name}`), `${name} is not spread into the paragraph call`);
  });
}

// And the drift itself: a bold paragraph written with an inline style
// object is one nobody is measuring in the matching weight.
check("no bold paragraph is drawn from an inline style object", () => {
  const inlineBold = SRC.match(/paragraph\([\s\S]{0,200}?style: "bold"/g) || [];
  assert.deepEqual(inlineBold, [], "use a shared style constant so flexBudget can measure the same weight");
});

console.log(`\n${passed} checks passed${failed ? `, ${failed} FAILED` : ""}.`);
process.exit(failed ? 1 : 0);
