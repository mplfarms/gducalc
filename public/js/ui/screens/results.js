// src/ui/screens/results.js
//
// The answer screen. Order is deliberate — the things a person actually
// asked for come first, the caveats come after but are never hidden:
//
//   1. Where / what / when (so a screenshot is self-explanatory)
//   2. Where this season stands right now vs. normal
//   3. The chart
//   4. Predicted silk and black layer under every scenario
//   5. Frost risk — the one result that can invalidate the others
//   6. Method and data provenance
//
// Section 5 is not decoration. Corn stops accumulating GDUs at a killing
// freeze whether or not it has reached black layer, so a projected black
// layer date that lands after the median first-freeze date is a warning
// about the hybrid being too long for the location, not a prediction
// that it will finish.

import { h, mount } from "../dom.js";
import { createTopBar } from "../components/topBar.js";
import { createShareButton } from "../components/shareMenu.js";
import { navigate } from "../router.js";
import * as inputStore from "../stores/inputStore.js";
import * as brandStore from "../stores/brandStore.js";
import { getBrand } from "../brand.js";
import { loadTemperatureData, toSeries } from "../../core/weather.js";
import { buildDailyIndex, offsetAtTarget, bandTempStats } from "../../core/gdu.js";
import { buildSeason, baselineYearsFor, BASELINE_YEARS } from "../../core/season.js";
import { addDays, formatShort, yearOf } from "../../core/dates.js";
import { renderGduChart, buildChartLegend } from "../chart.js";
import { renderStageChart, currentStage } from "../stageChart.js";
import { sourceLabel, accuracyNote, extrapolationCaveat, FITTED_N } from "../../core/hybridEstimate.js";
import { stagesForHybrid, datedStages } from "../../core/stages.js";
import { frostVerdict } from "../../core/frostVerdict.js";
import { noFreezeText, freezeCoverageNote, solidCaption, temperatureProvenance, gapNoteText, thinBaselineText } from "../../core/frostText.js";

// Both charts render into containers they have to measure, so each hands
// back a handle that has to be torn down when the screen is rebuilt —
// otherwise their ResizeObservers keep firing against detached nodes.
/** @type {{destroy: () => void}[]} */
let activeCharts = [];

// Which scenario the Stages and Data sections date against. Module-level
// so it survives the card rebuild that changing it triggers; deliberately
// not persisted, since it's a "what if" toggle rather than a setting.
let activeScenarioKey = null;

// What the share menu serialises. Populated once the weather has loaded
// and the season is built; read at CLICK time rather than captured at
// render time, so tapping share during the load can't hand out a
// half-built object.
let shareContext = null;

function destroyCharts() {
  for (const c of activeCharts) c.destroy();
  activeCharts = [];
}

export function render(container) {
  destroyCharts();
  shareContext = null;

  const state = inputStore.getState();
  const hybridCheck = inputStore.validatedHybrid();

  // A hybrid is optional; a location and a planting date are not.
  if (!state.location || !state.plantingIso || !hybridCheck.ok) {
    // Reachable by a stale #/results hash (a bookmark, a PWA relaunch)
    // rather than by the Calculate button.
    mount(
      container,
      h("div", { className: "screen" }, [
        createTopBar({ title: "Results", onBack: () => navigate("calculator"), backLabel: "Back" }),
        h("main", { className: "screen-body" }, [
          h("section", { className: "card" }, [
            h("h3", { className: "section-header" }, "Missing Inputs"),
            h("p", {}, "Set a field location and a planting date first."),
            h("button", { type: "button", className: "btn btn-primary btn-block", onclick: () => navigate("calculator") }, "Back to Inputs"),
          ]),
        ]),
      ])
    );
    return;
  }

  const hybrid = hybridCheck.value; // null when no hybrid was entered
  resetCardState();
  const body = h("main", { className: "screen-body" }, [
    identityCard(state, hybrid),
    h("section", { className: "card" }, [h("p", { className: "gdu-loading" }, "Loading 30 years of weather for this location…")]),
  ]);

  mount(
    container,
    h("div", { className: "screen" }, [
      createTopBar({
        title: "GDU Outlook",
        onBack: () => navigate("calculator"),
        backLabel: "Back to inputs",
        right: createShareButton(() => shareContext),
      }),
      body,
    ])
  );

  loadAndPaint(container, body, state, hybrid);
}

/**
 * The masthead: brand mark, the hybrid, and the field and date under it.
 *
 * Deliberately NOT collapsible and deliberately NOT a header bar — it is
 * the report's identity, the first thing read in a screenshot and the
 * thing a grower looks at to confirm this is about their field. It
 * mirrors the plot-summary row in Corn Plot Harvest so the two apps read
 * as one product.
 *
 * No chevron: the row it is modeled on is a navigation target, this is a
 * title. An arrow that goes nowhere is worse than no arrow.
 */
function identityCard(state, hybrid) {
  const brand = getBrand(brandStore.getState().selectedBrand);
  const meta = [state.location.label, `Planted ${formatShort(state.plantingIso, { withYear: true })}`, hybrid && hybrid.rm ? `${hybrid.rm} day` : null]
    .filter(Boolean)
    .join("  ·  ");
  return h("section", { className: "card gdu-identity" }, [
    brand ? h("img", { className: "gdu-identity-logo", src: brand.logo, alt: brand.displayName }) : null,
    h("div", { className: "gdu-identity-text" }, [
      h("div", { className: "gdu-identity-title" }, hybrid ? hybrid.label : "GDU Accumulation"),
      h("div", { className: "gdu-identity-meta" }, meta),
    ]),
  ]);
}

function headerCard(state, hybrid) {
  if (!hybrid) {
    return collapsibleCard("details", "Details", [
      h("div", { className: "plot-details-summary-row" }, [
        h("span", { className: "plot-details-summary-label" }, "Field"),
        h("span", { className: "plot-details-summary-value" }, state.location.label),
      ]),
      h("div", { className: "plot-details-summary-row" }, [
        h("span", { className: "plot-details-summary-label" }, "Planted"),
        h("span", { className: "plot-details-summary-value" }, formatShort(state.plantingIso, { withYear: true })),
      ]),
      h(
        "p",
        { className: "field-note" },
        "No hybrid entered, so there are no silk or black layer dates to predict — this is the heat itself, for this location and planting date."
      ),
      h("button", { type: "button", className: "btn btn-secondary btn-block", onclick: () => navigate("calculator") }, "Add a Hybrid for Stage Dates"),
    ]);
  }
  return collapsibleCard("details", "Details", [
    h("div", { className: "plot-details-summary-row" }, [
      h("span", { className: "plot-details-summary-label" }, "Field"),
      h("span", { className: "plot-details-summary-value" }, state.location.label),
    ]),
    h("div", { className: "plot-details-summary-row" }, [
      h("span", { className: "plot-details-summary-label" }, "Planted"),
      h("span", { className: "plot-details-summary-value" }, formatShort(state.plantingIso, { withYear: true })),
    ]),
    hybrid.rm
      ? h("div", { className: "plot-details-summary-row" }, [
          h("span", { className: "plot-details-summary-label" }, "Maturity"),
          h("span", { className: "plot-details-summary-value" }, `${hybrid.rm} day`),
        ])
      : null,
    ratingRow("GDUs to silk", hybrid.silk, hybrid.rm),
    ratingRow("GDUs to black layer", hybrid.blackLayer, hybrid.rm),
    hybrid.anyEstimated
      ? h(
          "p",
          { className: "gdu-estimate-banner" },
          "Some of this hybrid's ratings were estimated, not read off a tech sheet — every date below inherits that. See “How these numbers were made” at the bottom for how far off an estimate typically runs."
        )
      : null,
  ]);
}

/**
 * One rating line, marked when the value was estimated rather than
 * entered. An estimate that looks identical to a measured number on the
 * screen people screenshot and forward is the whole problem, so the tag
 * travels with the value.
 */
function ratingRow(label, rv, rm) {
  const src = rv ? sourceLabel(rv, rm) : null;
  return h("div", { className: "plot-details-summary-row" }, [
    h("span", { className: "plot-details-summary-label" }, label),
    h("span", { className: "plot-details-summary-value" }, [
      h("span", {}, `${(rv ? rv.value : 0).toLocaleString()}`),
      src ? h("span", { className: "field-locked-tag gdu-tag-estimated" }, "est.") : null,
      src ? h("span", { className: "gdu-rating-src" }, src) : null,
    ]),
  ]);
}

async function loadAndPaint(container, body, state, hybrid) {
  const plantingYear = yearOf(state.plantingIso);
  const startYear = baselineYearsFor(plantingYear)[0];

  const res = await loadTemperatureData(state.location.lat, state.location.lon, startYear);

  // The screen may have been navigated away from while the fetch was in
  // flight — don't paint over whatever replaced it.
  if (!container.contains(body)) return;

  if (!res.ok) {
    replaceTail(body, [
      h("section", { className: "card" }, [
        h("h3", { className: "section-header" }, "Couldn't Load Weather Data"),
        h("p", {}, res.error),
        h("p", { className: "field-note" }, "This needs a connection — the 30-year history is pulled live from Open-Meteo. Once it loads for a location it's cached for the rest of the day."),
        h("button", { type: "button", className: "btn btn-secondary btn-block", onclick: () => navigate("results") }, "Try Again"),
      ]),
    ]);
    return;
  }

  const observed = toSeries(res.archive, "observed");
  const forecast = res.forecast ? toSeries(res.forecast, "forecast") : { time: [], tmax: [], tmin: [], source: "forecast" };
  // Forecast FIRST, observed SECOND. buildDailyIndex lets the later
  // source win, and the two overlap on exactly one day — "today", which
  // the archive also covers. The reanalysis value for today is the
  // better of the two, so observed has to be passed last to win.
  const index = buildDailyIndex([forecast, observed]);

  const lastObservedIso = observed.time.length ? observed.time[observed.time.length - 1] : null;
  const lastKnownIso = forecast.time.length ? forecast.time[forecast.time.length - 1] : lastObservedIso;

  const season = buildSeason({
    index,
    plantingIso: state.plantingIso,
    // Null targets simply produce rows with no crossings — see
    // offsetAtTarget, which returns null for a non-finite target. The
    // rows aren't rendered without a hybrid anyway.
    gduToSilk: hybrid ? hybrid.gduToSilk : null,
    gduToBlackLayer: hybrid ? hybrid.gduToBlackLayer : null,
    lastKnownIso,
    lastObservedIso,
  });

  // Everything the PDF and the text summary need, captured once the
  // season exists. The stage list and its scenario label come from the
  // same helper the on-screen stage chart uses, so the PDF can never
  // disagree with what the user is looking at.
  const forShare = hybrid ? stagesForView(season, hybrid) : null;
  shareContext = {
    season,
    hybrid,
    location: state.location,
    // The three current-* rows are collapsed out here for the same reason
    // the screen and the PDF collapse them: they share identical observed
    // and forecast data, so their dates are frequently identical, and
    // three identical rows in a text message reads as a fault in the app.
    // buildSummary prints this season from season.currentStage instead.
    rows: hybrid ? season.rows.filter((r) => !r.key.startsWith("current-")) : [],
    brand: getBrand(brandStore.getState().selectedBrand),
    stages: forShare ? forShare.dated : null,
    scenarioLabel: forShare ? (season.rows.find((r) => r.key === forShare.key) || {}).label || "Normal" : null,
  };

  // Order is the reading order of the report: what the hybrid is, where
  // the season stands, the curve, where the crop IS, then the tables and
  // caveats. Growth Stages sits ABOVE Predicted Stage Dates because
  // "where is my corn right now" is the question a rep is actually asked
  // in a field; the date table is what they check afterwards.
  const cards = [headerCard(state, hybrid)];
  const status = statusCard(season, state, res);
  if (status) cards.push(status);
  // statusCard is where the gap warning belongs, but statusCard is
  // exactly what a gap can suppress: a hole on or before the planting day
  // leaves nothing accumulated, statusCard returns null, and the most
  // broken case on the screen was the one that explained itself least.
  // Wrapped in a card of its own: everything else in .screen-body is a
  // <section class="card">, so a bare <p> here rendered as an orange line
  // floating in the gap between two cards.
  else if (season.truncatedByGap) cards.push(h("section", { className: "card" }, [h("h3", { className: "section-header" }, "Incomplete Weather Record"), gapNotice(season)]));
  cards.push(chartCard(season, hybrid));
  // Everything below needs a hybrid's two GDU ratings to mean anything.
  if (hybrid) {
    const stageParts = stageSection(season, hybrid);
    cards.push(stageParts.stages, tableCard(season, hybrid), stageParts.data);
  }
  cards.push(frostCard(season, hybrid));
  cards.push(methodCard(season, res, state, hybrid));

  replaceTail(body, cards);
}

// ---------------------------------------------------------------
// Collapsible cards
// ---------------------------------------------------------------
//
// Every result card folds. The screen is one long scrollable report and
// most of it is reference material a rep already knows — what they want
// on arrival is where the season stands, the curve, and where the crop
// is. Everything else is there when asked for.
//
// Open/closed state lives here at module scope, NOT in localStorage.
// Changing the scenario rebuilds every card, and a user who opened Data
// to read it should not have it slam shut underneath them. But it is
// also a per-visit view state, not a setting: coming back to the screen
// starts from the defaults again, so a screenshot taken tomorrow looks
// like the one taken today.
const CARD_DEFAULT_OPEN = {
  details: false,
  status: true,
  chart: true,
  stages: true,
  table: false,
  data: false,
  frost: false,
  method: false,
};

/** @type {Object<string, boolean>} */
let cardOpen = { ...CARD_DEFAULT_OPEN };

function resetCardState() {
  cardOpen = { ...CARD_DEFAULT_OPEN };
}

/**
 * A card whose header bar toggles its body.
 *
 * The whole header is the control — a 44px-tall bar is a far better
 * target than a chevron glyph, and it means the affordance is the thing
 * people already read. The chevron is drawn as an SVG that rotates, so
 * it never depends on a font shipping a particular arrow.
 *
 * @param {string} key stable id used to remember open/closed across a rebuild
 * @param {string} title
 * @param {Array} children card body
 * @param {{className?: string}} [opts]
 */
function collapsibleCard(key, title, children, opts = {}) {
  const open = cardOpen[key] !== false;
  const bodyId = `gdu-card-${key}`;
  const body = h("div", { className: "gdu-card-body", id: bodyId }, children);
  body.hidden = !open;

  const chevron = svgChevron();
  const header = h(
    "button",
    {
      type: "button",
      className: "section-header gdu-card-toggle",
      "aria-expanded": open ? "true" : "false",
      "aria-controls": bodyId,
      onclick: () => {
        const nowOpen = body.hidden;
        body.hidden = !nowOpen;
        cardOpen[key] = nowOpen;
        header.setAttribute("aria-expanded", nowOpen ? "true" : "false");
        header.classList.toggle("gdu-card-toggle-open", nowOpen);
      },
    },
    [h("span", { className: "gdu-card-title" }, title), chevron]
  );
  if (open) header.classList.add("gdu-card-toggle-open");

  return h("section", { className: `card${opts.className ? ` ${opts.className}` : ""}` }, [header, body]);
}

function svgChevron() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "gdu-card-chevron");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M6 9l6 6 6-6");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2.4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

/** Swaps everything after the header card for `nodes`. */
function replaceTail(body, nodes) {
  while (body.children.length > 1) body.removeChild(body.lastChild);
  for (const n of nodes) body.appendChild(n);
}

// ---------------------------------------------------------------
// Where the season stands right now
// ---------------------------------------------------------------
function statusCard(season, state, res) {
  if (season.observedEndOffset < 0 || season.gduToDate === null) return null;

  const daysIn = season.observedEndOffset + 1;
  const vs = season.gduVsNormal;
  const vsText = vs === null ? "—" : `${vs >= 0 ? "+" : "−"}${Math.abs(Math.round(vs)).toLocaleString()}`;
  const vsLabel = vs === null ? "vs normal" : vs >= 0 ? "GDU ahead of normal" : "GDU behind normal";

  // Translate the GDU gap into days, which is the unit people actually
  // think in. Uses the normal curve's own local slope around today
  // rather than a season-average rate, so an August gap is measured in
  // August days (~24 GDU) not May days (~14).
  const daysEquivalent = gapInDays(season, vs);

  return collapsibleCard("status", "Where This Season Stands", [
    h("div", { className: "summary-stats" }, [
      stat(Math.round(season.gduToDate).toLocaleString(), "GDU accumulated"),
      stat(vsText, vsLabel),
      stat(String(daysIn), "days since planting"),
    ]),
    h(
      "p",
      { className: "field-note" },
      daysEquivalent === null
        ? `Through ${formatShort(season.lastObservedIso, { withYear: true })}${res.cached ? " (cached earlier today)" : ""}.`
        : `Through ${formatShort(season.lastObservedIso, { withYear: true })}${res.cached ? " (cached earlier today)" : ""} — roughly ${daysEquivalent} ${daysEquivalent === 1 ? "day" : "days"} ${vs >= 0 ? "ahead of" : "behind"} a normal year at this point.`
    ),
    // A hole in the weather record stops accumulation cold. Better to say
    // so than to let the total look current when it is not.
    season.truncatedByGap ? gapNotice(season) : null,
  ]);
}

/**
 * The one place the "your weather record has a hole in it" wording lives.
 * Two callers: inside the status card when there is a total to caveat,
 * and standing alone when the gap left no total at all.
 */
function gapNotice(season) {
  // The shared sentence plus the one thing only the screen can offer —
  // the exact date it stopped on, and the suggestion to try again.
  const where = season.lastKnownIso ? ` The last day on the books is ${formatShort(season.lastKnownIso, { withYear: true })}.` : "";
  return h("p", { className: "field-note field-note-warn" }, `${capitalizeFirst(gapNoteText(season))}.${where} Recalculate later to pick up the missing days.`);
}

function capitalizeFirst(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Converts a GDU surplus/deficit into "days ahead/behind" using the
 * normal curve's slope near today. Returns null when the slope is too
 * small to divide by meaningfully (late season, cold weather).
 */
function gapInDays(season, gap) {
  if (gap === null || season.observedEndOffset < 7) return null;
  const i = season.observedEndOffset;
  const a = season.env.p50[Math.max(0, i - 7)];
  const b = season.env.p50[i];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const perDay = (b - a) / 7;
  if (perDay < 2) return null;
  return Math.round(Math.abs(gap) / perDay);
}

function stat(value, label) {
  return h("div", { className: "summary-stat" }, [
    h("div", { className: "summary-stat-value" }, value),
    h("div", { className: "summary-stat-label" }, label),
  ]);
}

// ---------------------------------------------------------------
// Chart
// ---------------------------------------------------------------

function chartCard(season, hybrid) {
  const holder = h("div", { className: "gdu-chart-holder" });
  const card = collapsibleCard("chart", "GDU Accumulation", [
    holder,
    buildChartLegend(season),
    h(
      "p",
      { className: "box-plot-caption" },
      // The DERIVED dates, deliberately. This sentence describes the solid
      // line, and the solid line is drawn to knownEndOffset — so if a gap
      // cut the record short, the caption has to move with it or it
      // contradicts the gap notice two cards up. The method card, which
      // describes what was downloaded, is the place for the requested
      // horizon.
      `${solidCaption(season, formatShort)} Drag across the chart to read values.`
    ),
  ]);
  // The chart measures its container, so it has to be attached first.
  requestAnimationFrame(() => {
    if (holder.isConnected) activeCharts.push(renderGduChart(holder, season, hybrid, getBrand(brandStore.getState().selectedBrand)));
  });
  return card;
}

// ---------------------------------------------------------------
// Scenario table
// ---------------------------------------------------------------
// The three "this season" scenarios share every observed and forecast
// day and can only diverge in the projected tail. Printing them as three
// table rows made identical values look like a fault in the app when
// they were arithmetic necessity — a stage the crop already passed has
// exactly one date, and history does not have scenarios. So this season
// gets ONE row per stage, carrying the date, what kind of number it is,
// and the hot-to-cool range where there genuinely is one.
function tableCard(season, hybrid) {
  const cs = season.currentStage;
  const rows = [];

  if (cs) {
    rows.push(
      h("tr", { className: "gdu-row-current" }, [
        h("td", { className: "gdu-scenario-name" }, `This season (${season.plantingYear})`),
        h("td", {}, currentStageCell(cs.silk, season)),
        h("td", {}, currentStageCell(cs.blackLayer, season)),
      ])
    );
  }

  for (const row of season.rows) {
    if (row.key.startsWith("current-")) continue;
    rows.push(
      h("tr", {}, [
        h("td", { className: "gdu-scenario-name" }, row.label),
        h("td", {}, stageCell(row.silkIso, row.silkOffset, row.silkIsProjected)),
        h("td", {}, stageCell(row.blackLayerIso, row.blackLayerOffset, row.blackLayerIsProjected, season, hybrid)),
      ])
    );
  }

  return collapsibleCard("table", "Predicted Stage Dates", [
    h("div", { className: "gdu-table-wrap" }, [
      h("table", { className: "gdu-table" }, [
        h("thead", {}, h("tr", {}, [h("th", {}, "Scenario"), h("th", {}, `Silk (${hybrid.gduToSilk.toLocaleString()})`), h("th", {}, `Black layer (${hybrid.gduToBlackLayer.toLocaleString()})`)])),
        h("tbody", {}, rows),
      ]),
    ]),
    h("p", { className: "field-note" }, STAGE_BASIS_NOTE),
    thinEnvelopeWarning(season),
  ]);
}

const STAGE_BASIS_NOTE =
  "The “this season” row shows one date because that is how many the data supports. A stage marked reached already happened — it is read off observed weather, so a hot or cool rest-of-year cannot move it. Forecast means it lands inside the 16-day outlook, which is near-certain but not measured. Only a projected date carries a range, and that range (hot finish to cool finish) is the honest answer, not the single date in front of it. The rows below it are whole seasons for comparison: last year as it actually ran, and what the 30-year record does from this same planting date.";

// A percentile band built from a handful of years is not a percentile
// band. If the remaining-season envelope thins out, the three finishes
// converge for a data reason rather than a weather reason, and the app
// has to say so rather than let it read as agreement.
// Both envelopes are checked, not just the projection's. The
// whole-season one feeds the Abnormally Hot / Normal / Abnormally Cool
// rows and the shaded band on the chart; a gap in the archive drops
// whole years out of it silently, and the result is a narrower band that
// looks like a confident answer instead of a thin one. The app states
// the year count in the method card either way, but a count that has
// actually degraded deserves to be said where the numbers are, not in a
// footnote at the bottom.
function thinEnvelopeWarning(season) {
  const text = thinBaselineText(season, BASELINE_YEARS);
  if (!text) return null;
  return h(
    "p",
    { className: "gdu-verdict gdu-verdict-warn gdu-thin-envelope" },
    `Thin baseline for this location — ${text}. This usually means the weather archive has gaps at this grid point; a location a few miles away may have a fuller record.`
  );
}

function basisBadge(basis) {
  switch (basis) {
    case "actual":
      return h("span", { className: "gdu-badge-actual" }, "reached");
    case "forecast":
      return h("span", { className: "gdu-badge-forecast" }, "in forecast");
    case "projected":
      return h("span", { className: "gdu-badge-projected" }, "projected");
    default:
      return null;
  }
}

function currentStageCell(summary, season) {
  if (!summary) return h("span", { className: "gdu-never" }, "not reached");
  const parts = [
    h("span", { className: "gdu-stage-date" }, formatShort(summary.iso, { withYear: true })),
    h("span", { className: "gdu-stage-days" }, `day ${summary.offset + 1}`),
    basisBadge(summary.basis),
  ];

  if (summary.basis === "projected") {
    if (!summary.reachedInEveryScenario) {
      parts.push(h("span", { className: "gdu-stage-range gdu-stage-range-warn" }, "not reached in a cool finish"));
    } else if (summary.spreadDays > 0) {
      parts.push(
        h("span", { className: "gdu-stage-range" }, `${formatShort(summary.earliestIso)} – ${formatShort(summary.latestIso)} (hot to cool finish)`)
      );
    } else {
      // Genuinely no spread: the crossing is close enough to the last
      // known day that a hot and a cool rest-of-year land on the same
      // calendar date. Say that outright — silence here is what made
      // three identical rows look broken.
      parts.push(h("span", { className: "gdu-stage-range" }, "hot and cool finishes land on the same day"));
    }
  }

  parts.push(frostBadge(summary.iso, season));
  return h("div", { className: "gdu-stage-cell" }, parts.filter(Boolean));
}

function stageCell(iso, offset, isProjected, season, hybrid) {
  if (!iso) return h("span", { className: "gdu-never" }, "not reached");
  const parts = [h("span", { className: "gdu-stage-date" }, formatShort(iso, { withYear: true })), h("span", { className: "gdu-stage-days" }, `day ${offset + 1}`)];
  if (isProjected) parts.push(h("span", { className: "gdu-badge-projected" }, "projected"));
  parts.push(frostBadge(iso, season));
  return h("div", { className: "gdu-stage-cell" }, parts.filter(Boolean));
}

// Flag a stage date that lands after the median killing freeze — see this
// file's header for why that's a warning, not a footnote.
function frostBadge(iso, season) {
  if (!season || !season.killingFreeze || !season.killingFreeze.medianMonthDay) return null;
  // A stage date that rolled into the next calendar year would compare
  // against the FOLLOWING year's freeze and produce nonsense.
  if (yearOf(iso) !== season.plantingYear) return null;
  const freezeIso = `${yearOf(iso)}-${season.killingFreeze.medianMonthDay}`;
  return iso > freezeIso ? h("span", { className: "gdu-badge-frost" }, "after median freeze") : null;
}

// ---------------------------------------------------------------
// Frost
// ---------------------------------------------------------------

const FROST_ACCURACY_NOTE =
  "Read these as the LATE end of the range. Checked against real thermometer records near Missouri Valley, Iowa for 1996–2025, this gridded dataset put the median first 32 °F at Oct 26 where nearby stations measured Oct 19 (Council Bluffs, Omaha) and Oct 7 (Atlantic, Sioux City) — a 9-25 km grid cell averages away the radiative cooling that makes a low spot frost first. GDU accumulation itself checked out to within about 1% of the nearest station; it's the frost dates specifically that run late, because they hinge on one night's minimum rather than a season of averages.";
function frostCard(season, hybrid) {
  const kf = season.killingFreeze;
  const lf = season.lightFrost;
  const year = season.plantingYear;

  // The p10 is what the verdict is scored on, so IT is the thing that
  // has to exist. The median can legitimately be null now: at a mild
  // grid point more than half the years get through the window without a
  // killing freeze, and the honest median is "no freeze", not a date
  // manufactured from the minority of years that did freeze.
  if (!kf.p10MonthDay) {
    return collapsibleCard("frost", "Frost Risk", [
      h("p", {}, noFreezeText(kf)),
      h("p", { className: "field-note" }, FROST_ACCURACY_NOTE),
    ]);
  }

  const killEarlyIso = `${year}-${kf.p10MonthDay}`;
  const killMedianIso = kf.medianMonthDay ? `${year}-${kf.medianMonthDay}` : null;
  const medianText = killMedianIso ? formatShort(killMedianIso) : "no freeze";

  // How often a killing freeze happens at all. Below 90% the record is
  // too thin for a "median freeze date" to be a fair summary, and the
  // card says so rather than quoting one. Shared with the PDF, which
  // folds the same sentence into its accuracy paragraph.
  const coverage = freezeCoverageNote(kf);
  const coverageNote = coverage ? h("p", { className: "field-note" }, coverage) : null;

  // Without a hybrid there is nothing to score the freeze against, so
  // the dates stand on their own — which is still useful: "when does
  // this ZIP usually freeze" is a real question.
  if (!hybrid) {
    return collapsibleCard("frost", "Frost Risk", [
      h("div", { className: "summary-stats" }, [
        stat(formatShort(killEarlyIso), "28 °F by this date 1 yr in 10"),
        stat(medianText, "median 28 °F freeze"),
        lf.medianMonthDay ? stat(formatShort(`${year}-${lf.medianMonthDay}`), "median 32 °F frost") : stat("—", "median 32 °F frost"),
      ]),
      coverageNote,
      h("p", { className: "field-note" }, FROST_ACCURACY_NOTE),
    ]);
  }

  // The verdict itself lives in core/frostVerdict.js so the PDF prints
  // the same sentence. It used to be built here and nowhere else, which
  // is why the printed sheet carried three dates and no interpretation.
  const v = frostVerdict(season, hybrid);
  const verdict = v ? h("p", { className: `gdu-verdict gdu-verdict-${v.tone}` }, v.text) : null;

  return collapsibleCard("frost", "Frost Risk", [
    h("div", { className: "summary-stats" }, [
      stat(formatShort(killEarlyIso), "28 °F by this date 1 yr in 10"),
      stat(medianText, "median 28 °F freeze"),
      lf.medianMonthDay ? stat(formatShort(`${year}-${lf.medianMonthDay}`), "median 32 °F frost") : stat("—", "median 32 °F frost"),
    ]),
    verdict,
    coverageNote,
    h("p", { className: "field-note" }, FROST_ACCURACY_NOTE),
  ]);
}

// ---------------------------------------------------------------
// Scenario selection for the stage + data sections
// ---------------------------------------------------------------
//
// The accumulation chart, the stage chart and the data table are all
// rendered on the page at once rather than behind tabs. They answer
// different questions from the same numbers — "how does this year
// compare to normal", "where is my corn and what's next", "give me every
// figure" — and a rep checking a field wants to see the comparison and
// the stage ladder together, not trade one for the other. It also means
// a screenshot of this screen carries the whole answer.

/** Maps a stage-date row key back to the cumulative curve behind it. */
function curveForRowKey(season, key) {
  const map = {
    "current-normal": "current",
    lastYear: "lastYear",
    hot: "hot",
    normal: "normal",
    cool: "cool",
  };
  // The hot and cool CURRENT-season finishes have rows in the Predicted
  // Stage Dates table but no drawn scenario curve of their own (the
  // chart shows one current line — the normal finish). Rather than
  // rebuild those curves here and risk them drifting out of step with
  // season.js's version, they're simply not offered as stage-view
  // scenarios; the table above still gives their silk and black layer
  // dates, which is what those two rows exist to answer.
  const scenarioKey = map[key];
  return scenarioKey ? season.scenarios.find((s) => s.key === scenarioKey) : null;
}

/** Only scenarios with a curve the stage view can actually walk. */
function scenarioOptions(season) {
  return season.rows
    .filter((r) => curveForRowKey(season, r.key))
    .map((r) => ({ key: r.key, label: r.label }));
}

/**
 * Defaults to this season finishing normally — the single most likely
 * answer — falling back to the climatological normal when nothing is in
 * the ground yet.
 */
function defaultScenarioKey(season) {
  if (activeScenarioKey && season.rows.some((r) => r.key === activeScenarioKey)) return activeScenarioKey;
  return season.rows.some((r) => r.key === "current-normal") ? "current-normal" : "normal";
}

function scenarioPicker(season, onChange) {
  const options = scenarioOptions(season);
  const select = h(
    "select",
    {
      className: "text-input gdu-scenario-select",
      "aria-label": "Scenario",
      onchange: (e) => {
        activeScenarioKey = e.target.value;
        onChange();
      },
    },
    options.map((o) => h("option", { value: o.key }, o.label))
  );
  select.value = defaultScenarioKey(season);
  return h("div", { className: "field" }, [h("label", { className: "field-label" }, "Dates shown for"), select]);
}

function stagesForView(season, hybrid) {
  const key = defaultScenarioKey(season);
  const scenario = curveForRowKey(season, key);
  const stages = stagesForHybrid(hybrid.gduToSilk, hybrid.gduToBlackLayer);
  const dated = withBandTemps(
    datedStages(stages, scenario ? scenario.cum : [], season.plantingIso, scenario ? scenario.solidThroughOffset : -1, {
      offsetAtTarget,
      addDays,
    }),
    season
  );
  return { key, scenario, dated };
}

/**
 * Attaches each stage's average daily high and low to it.
 *
 * A stage's span runs from the day it is reached up to the day BEFORE
 * the next stage is reached — that is the stretch the crop actually
 * spent in it. The last entry (Maturity) is the top edge of the stack
 * rather than a band, so it has no span and never gets a temperature.
 *
 * bandTempStats returns null unless every day in the span is observed,
 * so anything still in the forecast window or beyond comes back blank.
 */
function withBandTemps(dated, season) {
  return dated.map((stage, i) => {
    const next = dated[i + 1];
    const spanKnown = next && stage.offset !== null && next.offset !== null;
    return {
      ...stage,
      bandTemps: spanKnown ? bandTempStats(season.index, season.plantingIso, stage.offset, next.offset - 1, addDays) : null,
    };
  });
}

/**
 * "88°/70°" — hottest daytime high over warmest nighttime low.
 *
 * Only this file calls it. `stageChart.js` and `pdfBuilder.js` each
 * inline the same one-line format; they agree today, and pulling all
 * three onto this export would mean the chart layer importing from a
 * screen. If a third divergence shows up, the move is into core/, not
 * into here.
 */
export function formatBandTemps(bt) {
  if (!bt) return null;
  return `${Math.round(bt.maxHigh)}°/${Math.round(bt.maxLow)}°`;
}

/**
 * Stage chart + data table share one scenario selector, so they sit in a
 * single holder that repaints both together. Repainting swaps the
 * holder's contents in place — it never re-renders the screen, so
 * changing scenario can't re-run the weather fetch or lose scroll
 * position.
 */
/**
 * Growth Stages and Data are driven by the same scenario picker — change
 * it and both must repaint together or the table would disagree with the
 * chart. They are NOT adjacent on screen, though: Predicted Stage Dates
 * sits between them. So this hands back two separate holders that share
 * one repaint, and the caller places them where they belong.
 *
 * @returns {{stages: HTMLElement, data: HTMLElement}}
 */
function stageSection(season, hybrid) {
  const stages = h("div", { className: "gdu-stage-section" });
  const data = h("div", { className: "gdu-data-section" });
  function paint() {
    destroyCharts();
    stages.textContent = "";
    data.textContent = "";
    stages.appendChild(stagesCard(season, hybrid, paint));
    data.appendChild(dataCard(season, hybrid));
    // The share payload is built once when the season loads, but the
    // scenario picker can change what the user is looking at afterwards.
    // Without this, switching "Dates shown for" to Abnormally hot and
    // then tapping Share produced a PDF whose stage chart and caption
    // still said "This season — normal finish": the printed sheet
    // disagreeing with the screen it was printed from.
    refreshShareStages(season, hybrid);
  }
  paint();
  return { stages, data };
}

/**
 * Test seam: what the share payload would currently label its scenario.
 * shareContext is module-private on purpose (it is read at click time so
 * a share tapped mid-load can't hand out a half-built object), and this
 * is the one property a test needs to see to prove it tracks the picker.
 */
export function __shareScenarioLabelForTest() {
  return shareContext ? shareContext.scenarioLabel : null;
}

/** Re-points shareContext's stage list at whatever scenario is showing. */
function refreshShareStages(season, hybrid) {
  if (!shareContext || !hybrid) return;
  const view = stagesForView(season, hybrid);
  shareContext.stages = view.dated;
  shareContext.scenarioLabel = (season.rows.find((r) => r.key === view.key) || {}).label || "Normal";
}

function stagesCard(season, hybrid, repaint) {
  const { dated } = stagesForView(season, hybrid);
  const holder = h("div", { className: "gdu-stage-chart-holder" });
  const now = currentStage(dated, season.gduToDate);

  const card = collapsibleCard("stages", "Growth Stages", [
    scenarioPicker(season, repaint),
    now
      ? h("p", { className: "gdu-stage-now" }, [
          h("strong", {}, `Currently at ${now.current.label}`),
          now.next && now.next.iso ? `. Next: ${now.next.label} around ${formatShort(now.next.iso, { withYear: true })}.` : ".",
        ])
      : null,
    holder,
    h(
      "p",
      { className: "field-note" },
      "Planting, Silks and Maturity sit exactly on the numbers from the hybrid list — they're shown in bold. Every stage between them is scaled proportionally from Iowa State's published GDU ladder for a 2,700-GDU hybrid, so treat those as estimates that get less certain the further they are from an anchor. Real hybrids don't stretch perfectly evenly."
    ),
  ]);

  requestAnimationFrame(() => {
    if (holder.isConnected) {
      activeCharts.push(renderStageChart(holder, { stages: dated, gduToDate: season.gduToDate, asOfIso: season.lastObservedIso }));
    }
  });
  return card;
}

// ---------------------------------------------------------------
// Data tab — every stage against every scenario
// ---------------------------------------------------------------

function dataCard(season, hybrid) {
  const stages = stagesForHybrid(hybrid.gduToSilk, hybrid.gduToBlackLayer);
  const cols = scenarioOptions(season).map((o) => {
    const scenario = curveForRowKey(season, o.key);
    return {
      label: o.label,
      dated: datedStages(stages, scenario.cum, season.plantingIso, scenario.solidThroughOffset, { offsetAtTarget, addDays }),
    };
  });

  // Weather that already happened is the same in every scenario, and
  // this column only ever shows observed days — so it is computed once
  // off the first scenario rather than repeated per column. Using a
  // different scenario would give an identical answer wherever the
  // answer is non-blank.
  const observedTemps = cols.length ? withBandTemps(cols[0].dated, season) : [];

  const rows = stages.map((stage, i) => {
    const bt = observedTemps[i] ? observedTemps[i].bandTemps : null;
    return h("tr", { className: stage.anchored ? "gdu-row-anchored" : "" }, [
      h("td", { className: "gdu-scenario-name" }, [
        h("span", {}, stage.label),
        stage.code ? h("span", { className: "gdu-stage-code" }, stage.code) : null,
      ]),
      h("td", { className: "gdu-num" }, [
        h("span", {}, stage.gdu.toLocaleString()),
        stage.anchored ? null : h("span", { className: "gdu-stage-est" }, "est."),
      ]),
      h(
        "td",
        { className: "gdu-num gdu-band-temps" },
        bt
          ? [h("span", {}, formatBandTemps(bt)), h("span", { className: "gdu-band-temps-days" }, `${bt.days} d`)]
          : h("span", { className: "gdu-never" }, "—")
      ),
      ...cols.map((c) => h("td", {}, c.dated[i].iso ? formatShort(c.dated[i].iso, { withYear: true }) : "—")),
    ]);
  });

  return collapsibleCard("data", "Data", [
    h("div", { className: "gdu-table-wrap" }, [
      h("table", { className: "gdu-table gdu-data-table" }, [
        h(
          "thead",
          {},
          h("tr", {}, [h("th", {}, "Stage"), h("th", {}, "GDU"), h("th", {}, "Hottest / warmest night"), ...cols.map((c) => h("th", {}, c.label))])
        ),
        h("tbody", {}, rows),
      ]),
    ]),
    h(
      "p",
      { className: "field-note" },
      "Every number the charts draw, in one place. GDU thresholds marked “est.” are scaled from the published ladder rather than taken from the hybrid list — Planting, Silks and Maturity are the hybrid's own figures."
    ),
    h(
      "p",
      { className: "field-note" },
      "The pair is the hottest daytime high and the warmest nighttime low anywhere in that stage, with the number of days beside it — not averages. Those two are what explain a yield result: peak heat is what sterilizes pollen at silking, and the warmest nights are what drive respiration to burn sugars off during grain fill, which costs test weight even when the days look ordinary. An average buries both — one 98° day in an otherwise mild fortnight barely moves a mean, and that is the day that did the damage. Shown only once a stage is completely behind us; a stage the crop is still in is left blank rather than reporting a hottest-day-so-far that changes tomorrow."
    ),
  ]);
}

// ---------------------------------------------------------------
// Method
// ---------------------------------------------------------------
function methodCard(season, res, state, hybrid) {
  const yrs = season.yearsUsed;
  const yearRange = yrs.length ? `${yrs[0]}–${yrs[yrs.length - 1]}` : "—";
  return collapsibleCard("method", "How These Numbers Were Made", [
    h("ul", { className: "gdu-method-list" }, [
      h("li", {}, "GDU = (min(daily high, 86 °F) + max(daily low, 50 °F)) ÷ 2 − 50, the modified base-50/86 method US seed companies rate hybrids on. A day below 50 °F counts 0, never a negative; heat above 86 °F adds nothing."),
      h("li", {}, "Accumulation starts on the planting date itself."),
      h("li", {}, `Normal, hot and cool are the 50th, 90th and 10th percentiles of accumulation across ${yrs.length} complete years (${yearRange}) at this exact grid point — an envelope, not a replay of any one year.`),
      h("li", {}, "The three rest-of-season finishes — normal, hot and cool — share identical observed and forecast data and differ only in how the remaining days are assumed to go. They are collapsed into one “this season” row: a date the crop has already passed cannot differ between them, and only a projected date gets a hot-to-cool range."),
      h("li", {}, temperatureProvenance(season, formatShort)),
      h("li", {}, `Grid point: ${state.location.lat.toFixed(4)}, ${state.location.lon.toFixed(4)}.`),
      hybrid ? null : h("li", {}, "No hybrid was entered, so no stage dates are shown — the curves are the heat itself. Add a hybrid on the input screen for silk and black layer predictions."),
      hybrid && hybrid.anyEstimated
        ? h("li", { className: "gdu-method-estimate" }, [
            h("strong", {}, "This hybrid's ratings are partly estimated. "),
            [hybrid.silk, hybrid.blackLayer]
              .map((rv) => {
                const src = sourceLabel(rv, hybrid.rm);
                return src ? `${rv === hybrid.silk ? "Silk" : "Black layer"} ${rv.value.toLocaleString()} GDU was ${src}, ${accuracyNote(rv)}.` : null;
              })
              .filter(Boolean)
              .join(" ") +
              ` Those figures come from an ordinary least-squares fit on all ${FITTED_N} hybrids in the built-in list, with error measured by leaving each hybrid out of the fit and predicting it — so it's out-of-sample error, not the fit describing itself. RM is the weakest basis: it explains 87% of the variation in black layer, and the worst hybrid in the list sits 389 GDU off its maturity's trend, which is about two and a half weeks of grain fill. Use the real ratings when you can get them.`,
          ])
        : null,
      // The input screen warns about an out-of-range basis; this screen
      // used to quietly reassert the ± figures the warning just retracted.
      // One shared wording, so the input screen, this card and the PDF
      // cannot drift apart again.
      extrapolationCaveat(hybrid) ? h("li", { className: "gdu-method-warn" }, extrapolationCaveat(hybrid)) : null,
      res.forecastError ? h("li", { className: "gdu-method-warn" }, `The 16-day forecast failed to load (${res.forecastError}), so the projection starts from the last observed day instead.`) : null,
    ]),
    h(
      "p",
      { className: "field-note" },
      "GDU is a heat model, not a crop model. It doesn't know about drought, saturated soils, replant, hail, disease or nitrogen — any of which can move real silk and black layer dates well off these numbers."
    ),
  ]);
}
