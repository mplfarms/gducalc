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
import { buildDailyIndex, offsetAtTarget } from "../../core/gdu.js";
import { buildSeason, baselineYearsFor, BASELINE_YEARS } from "../../core/season.js";
import { addDays, daysBetween, formatShort, yearOf } from "../../core/dates.js";
import { renderGduChart, buildChartLegend } from "../chart.js";
import { renderStageChart, currentStage } from "../stageChart.js";
import { sourceLabel, accuracyNote } from "../../core/hybridEstimate.js";
import { stagesForHybrid, datedStages } from "../../core/stages.js";

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
            h("p", {}, "Set a field location, a planting date and the hybrid's GDU ratings first."),
            h("button", { type: "button", className: "btn btn-primary btn-block", onclick: () => navigate("calculator") }, "Back to Inputs"),
          ]),
        ]),
      ])
    );
    return;
  }

  const hybrid = hybridCheck.value;
  const body = h("main", { className: "screen-body" }, [
    headerCard(state, hybrid),
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

function headerCard(state, hybrid) {
  return h("section", { className: "card" }, [
    h("h3", { className: "section-header" }, hybrid.label),
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
    gduToSilk: hybrid.gduToSilk,
    gduToBlackLayer: hybrid.gduToBlackLayer,
    lastKnownIso,
    lastObservedIso,
  });

  // Everything the PDF and the text summary need, captured once the
  // season exists. The stage list and its scenario label come from the
  // same helper the on-screen stage chart uses, so the PDF can never
  // disagree with what the user is looking at.
  const forShare = stagesForView(season, hybrid);
  shareContext = {
    season,
    hybrid,
    location: state.location,
    rows: season.rows,
    brand: getBrand(brandStore.getState().selectedBrand),
    stages: forShare.dated,
    scenarioLabel: (season.rows.find((r) => r.key === forShare.key) || {}).label || "Normal",
  };

  const cards = [];
  const status = statusCard(season, state, res);
  if (status) cards.push(status);
  cards.push(chartCard(season, hybrid));
  cards.push(tableCard(season, hybrid));
  cards.push(stageSection(season, hybrid));
  cards.push(frostCard(season, hybrid));
  cards.push(methodCard(season, res, state, hybrid));

  replaceTail(body, cards);
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

  return h("section", { className: "card" }, [
    h("h3", { className: "section-header" }, "Where This Season Stands"),
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
  ]);
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
  const card = h("section", { className: "card" }, [
    h("h3", { className: "section-header" }, "GDU Accumulation"),
    holder,
    buildChartLegend(season),
    h(
      "p",
      { className: "box-plot-caption" },
      season.knownEndOffset > season.observedEndOffset
        ? `Solid = observed through ${formatShort(season.lastObservedIso)} plus forecast through ${formatShort(season.lastKnownIso)}. Dashed = projected. Drag across the chart to read values.`
        : "Dashed = projected. Drag across the chart to read values."
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
function tableCard(season, hybrid) {
  const rows = season.rows.map((row) => {
    const isCurrent = row.key.startsWith("current-");
    return h("tr", { className: isCurrent ? "gdu-row-current" : "" }, [
      h("td", { className: "gdu-scenario-name" }, row.label),
      h("td", {}, stageCell(row.silkIso, row.silkOffset, row.silkIsProjected)),
      h("td", {}, stageCell(row.blackLayerIso, row.blackLayerOffset, row.blackLayerIsProjected, season, hybrid)),
    ]);
  });

  return h("section", { className: "card" }, [
    h("h3", { className: "section-header" }, "Predicted Stage Dates"),
    h("div", { className: "gdu-table-wrap" }, [
      h("table", { className: "gdu-table" }, [
        h("thead", {}, h("tr", {}, [h("th", {}, "Scenario"), h("th", {}, `Silk (${hybrid.gduToSilk.toLocaleString()})`), h("th", {}, `Black layer (${hybrid.gduToBlackLayer.toLocaleString()})`)])),
        h("tbody", {}, rows),
      ]),
    ]),
    h(
      "p",
      { className: "field-note" },
      "“Projected” dates depend on weather that hasn't happened yet — the three “this season” rows differ only in how the rest of the year turns out. Treat the spread between them as the real answer, not any single date."
    ),
  ]);
}

function stageCell(iso, offset, isProjected, season, hybrid) {
  if (!iso) return h("span", { className: "gdu-never" }, "not reached");
  const parts = [h("span", { className: "gdu-stage-date" }, formatShort(iso, { withYear: true })), h("span", { className: "gdu-stage-days" }, `day ${offset + 1}`)];
  if (isProjected) parts.push(h("span", { className: "gdu-badge-projected" }, "projected"));
  // Flag a black layer date that lands after the median killing freeze —
  // see this file's header for why that's a warning, not a footnote.
  if (season && season.killingFreeze && season.killingFreeze.medianMonthDay) {
    const freezeIso = `${yearOf(iso)}-${season.killingFreeze.medianMonthDay}`;
    if (iso > freezeIso) parts.push(h("span", { className: "gdu-badge-frost" }, "after median freeze"));
  }
  return h("div", { className: "gdu-stage-cell" }, parts);
}

// ---------------------------------------------------------------
// Frost
// ---------------------------------------------------------------
function frostCard(season, hybrid) {
  const kf = season.killingFreeze;
  const lf = season.lightFrost;
  if (!kf.medianMonthDay) {
    return h("section", { className: "card" }, [
      h("h3", { className: "section-header" }, "Frost Risk"),
      h("p", {}, "No 28 °F freeze appears in this location's 30-year record after August 1, so a killing freeze isn't the limiting factor here."),
    ]);
  }

  const year = season.plantingYear;
  const killMedianIso = `${year}-${kf.medianMonthDay}`;
  // The verdict is scored against the EARLY (1-year-in-10) freeze, not
  // the median. A hybrid that black-layers exactly on the median freeze
  // date gets caught one year in two, which is not a pass.
  const killEarlyIso = `${year}-${kf.p10MonthDay}`;

  // Compare against the LATEST black-layer date among the this-season
  // rows (the cool finish) — the risk question is "could this fail",
  // not "does it work if everything goes well".
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

  let verdict;
  if (latest === null) {
    verdict = h(
      "p",
      { className: "gdu-verdict gdu-verdict-bad" },
      `This hybrid doesn't reach black layer at all within the season window in at least one scenario. At ${hybrid.gduToBlackLayer.toLocaleString()} GDU it's too long for this location and planting date.`
    );
  } else {
    const marginEarly = daysBetween(latest, killEarlyIso);
    const marginMedian = daysBetween(latest, killMedianIso);
    if (marginEarly < 0) {
      verdict = h(
        "p",
        { className: "gdu-verdict gdu-verdict-bad" },
        `In a 1-year-in-10 early freeze (${formatShort(killEarlyIso)}) this hybrid would be caught ${Math.abs(marginEarly)} days short of black layer. Against the median freeze it has ${marginMedian} days. That's a real risk of an unfinished crop, not a rounding issue.`
      );
    } else if (marginEarly < 10) {
      verdict = h(
        "p",
        { className: "gdu-verdict gdu-verdict-warn" },
        `Only ${marginEarly} days of margin against a 1-year-in-10 early freeze (${formatShort(killEarlyIso)}), ${marginMedian} against the median. Tight — a cool September puts this hybrid at risk.`
      );
    } else {
      verdict = h(
        "p",
        { className: "gdu-verdict gdu-verdict-good" },
        `${marginEarly} days of margin even against a 1-year-in-10 early freeze (${formatShort(killEarlyIso)}), ${marginMedian} against the median. Comfortable for this location and planting date.`
      );
    }
  }

  return h("section", { className: "card" }, [
    h("h3", { className: "section-header" }, "Frost Risk"),
    h("div", { className: "summary-stats" }, [
      stat(formatShort(killEarlyIso), "28 °F by this date 1 yr in 10"),
      stat(formatShort(killMedianIso), "median 28 °F freeze"),
      lf.medianMonthDay ? stat(formatShort(`${year}-${lf.medianMonthDay}`), "median 32 °F frost") : stat("—", "median 32 °F frost"),
    ]),
    verdict,
    h(
      "p",
      { className: "field-note" },
      "Read these as the LATE end of the range. Checked against real thermometer records near Missouri Valley, Iowa for 1996–2025, this gridded dataset put the median first 32 °F at Oct 26 where nearby stations measured Oct 19 (Council Bluffs, Omaha) and Oct 7 (Atlantic, Sioux City) — a 9-25 km grid cell averages away the radiative cooling that makes a low spot frost first. GDU accumulation itself checked out to within about 1% of the nearest station; it's the frost dates specifically that run late, because they hinge on one night's minimum rather than a season of averages."
    ),
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
  const dated = datedStages(stages, scenario ? scenario.cum : [], season.plantingIso, scenario ? scenario.solidThroughOffset : -1, {
    offsetAtTarget,
    addDays,
  });
  return { key, scenario, dated };
}

/**
 * Stage chart + data table share one scenario selector, so they sit in a
 * single holder that repaints both together. Repainting swaps the
 * holder's contents in place — it never re-renders the screen, so
 * changing scenario can't re-run the weather fetch or lose scroll
 * position.
 */
function stageSection(season, hybrid) {
  const holder = h("div", { className: "gdu-stage-section" });
  function paint() {
    destroyCharts();
    holder.textContent = "";
    holder.appendChild(stagesCard(season, hybrid, paint));
    holder.appendChild(dataCard(season, hybrid));
  }
  paint();
  return holder;
}

function stagesCard(season, hybrid, repaint) {
  const { dated } = stagesForView(season, hybrid);
  const holder = h("div", { className: "gdu-stage-chart-holder" });
  const now = currentStage(dated, season.gduToDate);

  const card = h("section", { className: "card" }, [
    h("h3", { className: "section-header" }, "Growth Stages"),
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

  const rows = stages.map((stage, i) =>
    h("tr", { className: stage.anchored ? "gdu-row-anchored" : "" }, [
      h("td", { className: "gdu-scenario-name" }, [
        h("span", {}, stage.label),
        stage.code ? h("span", { className: "gdu-stage-code" }, stage.code) : null,
      ]),
      h("td", { className: "gdu-num" }, [
        h("span", {}, stage.gdu.toLocaleString()),
        stage.anchored ? null : h("span", { className: "gdu-stage-est" }, "est."),
      ]),
      ...cols.map((c) => h("td", {}, c.dated[i].iso ? formatShort(c.dated[i].iso, { withYear: true }) : "—")),
    ])
  );

  return h("section", { className: "card" }, [
    h("h3", { className: "section-header" }, "Data"),
    h("div", { className: "gdu-table-wrap" }, [
      h("table", { className: "gdu-table gdu-data-table" }, [
        h("thead", {}, h("tr", {}, [h("th", {}, "Stage"), h("th", {}, "GDU"), ...cols.map((c) => h("th", {}, c.label))])),
        h("tbody", {}, rows),
      ]),
    ]),
    h(
      "p",
      { className: "field-note" },
      "Every number the charts draw, in one place. GDU thresholds marked “est.” are scaled from the published ladder rather than taken from the hybrid list — Planting, Silks and Maturity are the hybrid's own figures."
    ),
  ]);
}

// ---------------------------------------------------------------
// Method
// ---------------------------------------------------------------
function methodCard(season, res, state, hybrid) {
  const yrs = season.yearsUsed;
  const yearRange = yrs.length ? `${yrs[0]}–${yrs[yrs.length - 1]}` : "—";
  return h("section", { className: "card" }, [
    h("h3", { className: "section-header" }, "How These Numbers Were Made"),
    h("ul", { className: "gdu-method-list" }, [
      h("li", {}, "GDU = (min(daily high, 86 °F) + max(daily low, 50 °F)) ÷ 2 − 50, the modified base-50/86 method US seed companies rate hybrids on. A day below 50 °F counts 0, never a negative; heat above 86 °F adds nothing."),
      h("li", {}, "Accumulation starts on the planting date itself."),
      h("li", {}, `Normal, hot and cool are the 50th, 90th and 10th percentiles of accumulation across ${yrs.length} complete years (${yearRange}) at this exact grid point — an envelope, not a replay of any one year.`),
      h("li", {}, "The three “this season” rows share identical observed and forecast data and differ only in how the remaining days are assumed to go."),
      h("li", {}, `Temperatures: ERA5 reanalysis via Open-Meteo for history and the current season through ${formatShort(season.lastObservedIso, { withYear: true })}, plus Open-Meteo's 16-day forecast through ${formatShort(season.lastKnownIso)}.`),
      h("li", {}, `Grid point: ${state.location.lat.toFixed(4)}, ${state.location.lon.toFixed(4)}.`),
      hybrid.anyEstimated
        ? h("li", { className: "gdu-method-estimate" }, [
            h("strong", {}, "This hybrid's ratings are partly estimated. "),
            [hybrid.silk, hybrid.blackLayer]
              .map((rv) => {
                const src = sourceLabel(rv, hybrid.rm);
                return src ? `${rv === hybrid.silk ? "Silk" : "Black layer"} ${rv.value.toLocaleString()} GDU was ${src}, ${accuracyNote(rv)}.` : null;
              })
              .filter(Boolean)
              .join(" ") +
              " Those figures come from an ordinary least-squares fit on all 72 hybrids in the built-in list, with error measured by leaving each hybrid out of the fit and predicting it — so it's out-of-sample error, not the fit describing itself. RM is the weakest basis: it explains 83% of the variation in black layer, and the worst hybrid in the list sits 472 GDU off its maturity's trend, which is about three weeks of grain fill. Use the real ratings when you can get them.",
          ])
        : null,
      res.forecastError ? h("li", { className: "gdu-method-warn" }, `The 16-day forecast failed to load (${res.forecastError}), so the projection starts from the last observed day instead.`) : null,
    ]),
    h(
      "p",
      { className: "field-note" },
      "GDU is a heat model, not a crop model. It doesn't know about drought, saturated soils, replant, hail, disease or nitrogen — any of which can move real silk and black layer dates well off these numbers."
    ),
  ]);
}
