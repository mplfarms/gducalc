// src/ui/chart.js
//
// The GDU accumulation chart: cumulative growing degree units from the
// planting date, one line per scenario, with horizontal reference lines
// at the hybrid's silk and black-layer GDU ratings. Where a line crosses
// a reference line IS the predicted date for that stage — the whole
// point of the picture.
//
// ---------------------------------------------------------------
// Color
// ---------------------------------------------------------------
// The series palette is FIXED across all three Brand Views rather than
// derived from the brand accent. That is deliberate: NC+'s accent is
// red and Crow's is red/black, and a red "this season" line sitting next
// to a red "abnormally hot" line would destroy the one distinction the
// chart exists to make. Brand identity is carried by the surrounding
// chrome (top bar, section headers, buttons, logo), which is where it
// belongs; inside the plot, color carries data meaning only.
//
// The light and dark steps below were run through the data-viz
// validator against every surface this chart can land on (white and
// #F4F8F1 in light mode; Midwest #0C4A2C, NC+ #163E73 and Crow's
// #2A2827 card backgrounds in dark mode) and pass the lightness-band,
// chroma-floor, CVD-separation and normal-vision checks on all of them.
// Two hues fall just under 3:1 contrast on some surfaces, which the
// validator flags as needing relief — that relief is shipped: every
// series is direct-labeled at its right end, named in the legend, and
// repeated as exact numbers in the scenario table under the chart, so
// identity never depends on color alone.
//
//   cool / 10th pct — blue    light #2a78d6  dark #3987e5
//   hot  / 90th pct — orange  light #eb6834  dark #d95926
//   last year       — green   light #1baf7a  dark #199e70
//   normal / median — the muted text token, dashed: a reference
//                     baseline rather than a categorical series
//   this season     — the primary text token at 3px: the hero line,
//                     ink so it reads on any brand and outweighs
//                     everything else without competing for hue

import { addDays, formatShort } from "../core/dates.js";

const SERIES_STYLE = {
  current: { varName: "--gdu-current", width: 3, dash: null, label: "This season" },
  lastYear: { varName: "--gdu-lastyear", width: 2, dash: null, label: "Last year" },
  hot: { varName: "--gdu-hot", width: 2, dash: null, label: "Hot (90th)" },
  normal: { varName: "--gdu-normal", width: 2, dash: "6 4", label: "Normal" },
  cool: { varName: "--gdu-cool", width: 2, dash: null, label: "Cool (10th)" },
};

// Drawing order: context first, hero last, so "this season" is never
// overdrawn by a line it is supposed to be compared against.
const DRAW_ORDER = ["cool", "hot", "normal", "lastYear", "current"];

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined) continue;
    el.setAttribute(k, String(v));
  }
  return el;
}

/**
 * Nicely rounded axis step for a given rough interval — keeps y-axis
 * ticks on 250/500/1000 GDU rather than 237.4.
 */
function niceStep(rough) {
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * pow;
}

/**
 * Renders the chart into `container` and keeps it sized to the
 * container's real pixel width.
 *
 * The SVG is redrawn on resize rather than scaled with a fixed viewBox.
 * A viewBox-scaled chart would shrink its own axis labels to unreadable
 * sizes on a phone — which is the primary device this gets opened on,
 * standing next to a field.
 *
 * @param {HTMLElement} container
 * @param {Object} season output of buildSeason()
 * @param {{gduToSilk: number, gduToBlackLayer: number, hybridLabel: string}} hybrid
 * @returns {{destroy: () => void}}
 */
export function renderGduChart(container, season, hybrid) {
  let observer = null;

  function draw() {
    const width = Math.max(280, container.clientWidth);
    const height = Math.round(Math.min(460, Math.max(260, width * 0.68)));
    container.textContent = "";
    container.appendChild(buildSvg(width, height, season, hybrid));
  }

  draw();
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => draw());
    observer.observe(container);
  } else {
    window.addEventListener("resize", draw);
  }

  return {
    destroy() {
      if (observer) observer.disconnect();
      else window.removeEventListener("resize", draw);
    },
  };
}

function buildSvg(width, height, season, hybrid) {
  const margin = { top: 14, right: 74, bottom: 30, left: 46 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const series = DRAW_ORDER.map((key) => season.scenarios.find((s) => s.key === key)).filter(Boolean);

  // ---- x domain -------------------------------------------------
  // Stop shortly after the last stage the chart actually has to show,
  // rather than always drawing the full 220-day window: a chart that
  // runs to December when black layer lands in September wastes two
  // thirds of its width on a flat tail and squeezes the part that
  // matters.
  let lastInterestingOffset = Math.max(season.knownEndOffset, 0);
  for (const row of season.rows) {
    for (const o of [row.silkOffset, row.blackLayerOffset]) {
      if (o !== null && o > lastInterestingOffset) lastInterestingOffset = o;
    }
  }
  const xMax = Math.min(season.seasonDays - 1, lastInterestingOffset + 12);

  // ---- y domain -------------------------------------------------
  let yMax = hybrid.gduToBlackLayer;
  for (const s of series) {
    const v = s.cum[xMax] !== null && s.cum[xMax] !== undefined ? s.cum[xMax] : lastFinite(s.cum, xMax);
    if (v !== null && v > yMax) yMax = v;
  }
  yMax = Math.ceil((yMax * 1.04) / 100) * 100;

  const x = (offset) => margin.left + (offset / xMax) * plotW;
  const y = (gdu) => margin.top + plotH - (gdu / yMax) * plotH;

  const root = svg("svg", {
    class: "gdu-chart-svg",
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": `Cumulative growing degree units from planting on ${formatShort(season.plantingIso, { withYear: true })}, by scenario. Exact dates are listed in the scenario table below this chart.`,
  });

  // ---- y grid + labels -----------------------------------------
  const yStep = niceStep(yMax / 5);
  for (let v = 0; v <= yMax + 1; v += yStep) {
    root.appendChild(svg("line", { class: "gdu-grid", x1: margin.left, x2: margin.left + plotW, y1: y(v), y2: y(v) }));
    const label = svg("text", { class: "gdu-axis-label", x: margin.left - 7, y: y(v) + 4, "text-anchor": "end" });
    label.textContent = v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : String(v);
    root.appendChild(label);
  }

  // ---- x ticks (month starts) ----------------------------------
  for (let o = 0; o <= xMax; o++) {
    const iso = addDays(season.plantingIso, o);
    const isMonthStart = iso.slice(8, 10) === "01";
    if (!isMonthStart && o !== 0) continue;
    if (o !== 0 && o < 8) continue; // avoid colliding with the planting tick
    root.appendChild(svg("line", { class: "gdu-grid gdu-grid-x", x1: x(o), x2: x(o), y1: margin.top, y2: margin.top + plotH }));
    const label = svg("text", { class: "gdu-axis-label", x: x(o), y: margin.top + plotH + 18, "text-anchor": o === 0 ? "start" : "middle" });
    label.textContent = o === 0 ? "Plant" : formatShort(iso).split(" ")[0];
    root.appendChild(label);
  }

  // ---- normal-range band ---------------------------------------
  // A soft fill between the 10th and 90th percentile curves. This is
  // the single clearest statement the chart makes: anything inside the
  // band is an ordinary year, anything outside it is not. The two edges
  // are still drawn as their own labeled lines below, so the band adds
  // emphasis without replacing information.
  const coolEnv = season.scenarios.find((s) => s.key === "cool");
  const hotEnv = season.scenarios.find((s) => s.key === "hot");
  if (coolEnv && hotEnv) {
    const upper = [];
    const lower = [];
    for (let i = 0; i <= xMax; i++) {
      if (!Number.isFinite(hotEnv.cum[i]) || !Number.isFinite(coolEnv.cum[i])) continue;
      upper.push(`${x(i).toFixed(1)} ${y(hotEnv.cum[i]).toFixed(1)}`);
      lower.push(`${x(i).toFixed(1)} ${y(coolEnv.cum[i]).toFixed(1)}`);
    }
    if (upper.length > 1) {
      root.appendChild(svg("path", { class: "gdu-band", d: `M${upper.join("L")}L${lower.reverse().join("L")}Z` }));
    }
  }

  // ---- stage reference lines -----------------------------------
  for (const [value, text] of [
    [hybrid.gduToSilk, "Silk"],
    [hybrid.gduToBlackLayer, "Black layer"],
  ]) {
    if (!Number.isFinite(value) || value <= 0 || value > yMax) continue;
    root.appendChild(svg("line", { class: "gdu-stage-line", x1: margin.left, x2: margin.left + plotW, y1: y(value), y2: y(value) }));
    const label = svg("text", { class: "gdu-stage-label", x: margin.left + 4, y: y(value) - 5 });
    label.textContent = `${text} — ${Math.round(value).toLocaleString()} GDU`;
    root.appendChild(label);
  }

  // ---- series ---------------------------------------------------
  /** @type {{yPos: number, text: string, key: string}[]} */
  const endLabels = [];
  for (const s of series) {
    const style = SERIES_STYLE[s.key];
    if (!style) continue;
    const color = `var(${style.varName})`;

    // Solid through the last day backed by real data (observed or
    // forecast); dashed after that, because a projection is a different
    // kind of claim and the chart should say so without a caption.
    const solidEnd = Math.min(s.solidThroughOffset, xMax);
    if (solidEnd >= 0) {
      const d = pathFor(s.cum, 0, solidEnd, x, y);
      if (d) root.appendChild(svg("path", { class: "gdu-line", d, stroke: color, "stroke-width": style.width, "stroke-dasharray": style.dash }));
    }
    if (solidEnd < xMax) {
      const from = Math.max(0, solidEnd);
      const d = pathFor(s.cum, from, xMax, x, y);
      if (d) {
        root.appendChild(
          svg("path", {
            class: "gdu-line gdu-line-projected",
            d,
            stroke: color,
            "stroke-width": style.width,
            "stroke-dasharray": style.dash || "5 5",
          })
        );
      }
    }

    // Marker at the boundary between real data and projection, so the
    // eye can find "today" without hunting for where the dashes start.
    if (s.key === "current" && solidEnd >= 0 && solidEnd < xMax && Number.isFinite(s.cum[solidEnd])) {
      root.appendChild(svg("circle", { class: "gdu-today-dot", cx: x(solidEnd), cy: y(s.cum[solidEnd]), r: 5, fill: color }));
    }

    const endIdx = lastFiniteIndex(s.cum, xMax);
    if (endIdx >= 0) endLabels.push({ yPos: y(s.cum[endIdx]), text: style.label, key: s.key, color });
  }

  // Direct labels at the right edge, nudged apart so they never overlap.
  spreadLabels(endLabels, 13, margin.top, margin.top + plotH);
  for (const l of endLabels) {
    const t = svg("text", {
      class: l.key === "current" ? "gdu-series-label gdu-series-label-hero" : "gdu-series-label",
      x: margin.left + plotW + 6,
      y: l.yPos + 4,
      fill: l.color,
    });
    t.textContent = l.text;
    root.appendChild(t);
  }

  // ---- hover crosshair -----------------------------------------
  attachCrosshair(root, { margin, plotW, plotH, x, xMax, y, series, season });

  return root;
}

/** Builds an SVG path over [from..to], breaking at nulls. */
function pathFor(cum, from, to, x, y) {
  let d = "";
  let pen = false;
  for (let i = from; i <= to; i++) {
    const v = cum[i];
    if (v === null || v === undefined || !Number.isFinite(v)) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  }
  return d;
}

function lastFiniteIndex(arr, maxIdx) {
  for (let i = Math.min(maxIdx, arr.length - 1); i >= 0; i--) {
    if (Number.isFinite(arr[i])) return i;
  }
  return -1;
}

function lastFinite(arr, maxIdx) {
  const i = lastFiniteIndex(arr, maxIdx);
  return i === -1 ? null : arr[i];
}

/**
 * Pushes labels apart to a minimum spacing while keeping their order and
 * staying inside [minY, maxY]. Two scenarios finishing within 30 GDU of
 * each other is normal, and their labels would otherwise print on top of
 * each other.
 */
function spreadLabels(labels, minGap, minY, maxY) {
  labels.sort((a, b) => a.yPos - b.yPos);
  for (let i = 1; i < labels.length; i++) {
    if (labels[i].yPos - labels[i - 1].yPos < minGap) labels[i].yPos = labels[i - 1].yPos + minGap;
  }
  const overflow = labels.length ? labels[labels.length - 1].yPos - maxY : 0;
  if (overflow > 0) for (const l of labels) l.yPos -= overflow;
  if (labels.length && labels[0].yPos < minY) {
    const shift = minY - labels[0].yPos;
    for (const l of labels) l.yPos += shift;
  }
}

/**
 * Crosshair + readout. Uses pointer events (not mouse events) so a
 * finger drag on a phone works the same as a mouse on a laptop — this
 * app gets used in a pickup at least as often as at a desk.
 */
function attachCrosshair(root, ctx) {
  const { margin, plotW, plotH, x, xMax, y, series, season } = ctx;

  const group = svg("g", { class: "gdu-crosshair", visibility: "hidden" });
  const vline = svg("line", { class: "gdu-crosshair-line", y1: margin.top, y2: margin.top + plotH });
  group.appendChild(vline);
  const dots = series.map(() => {
    const c = svg("circle", { class: "gdu-crosshair-dot", r: 4 });
    group.appendChild(c);
    return c;
  });

  const readoutBg = svg("rect", { class: "gdu-readout-bg", rx: 6 });
  const readout = svg("text", { class: "gdu-readout" });
  group.appendChild(readoutBg);
  group.appendChild(readout);
  root.appendChild(group);

  const hit = svg("rect", {
    x: margin.left,
    y: margin.top,
    width: plotW,
    height: plotH,
    fill: "transparent",
    style: "touch-action: none;",
  });

  function move(evt) {
    const rect = root.getBoundingClientRect();
    const px = evt.clientX - rect.left;
    const offset = Math.round(Math.max(0, Math.min(xMax, ((px - margin.left) / plotW) * xMax)));
    group.setAttribute("visibility", "visible");
    vline.setAttribute("x1", x(offset));
    vline.setAttribute("x2", x(offset));

    const lines = [`${formatShort(addDays(season.plantingIso, offset), { withYear: true })} · day ${offset + 1}`];
    series.forEach((s, i) => {
      const v = s.cum[offset];
      if (Number.isFinite(v)) {
        dots[i].setAttribute("visibility", "visible");
        dots[i].setAttribute("cx", x(offset));
        dots[i].setAttribute("cy", y(v));
        dots[i].setAttribute("fill", `var(${SERIES_STYLE[s.key].varName})`);
        lines.push(`${SERIES_STYLE[s.key].label}: ${Math.round(v).toLocaleString()}`);
      } else {
        dots[i].setAttribute("visibility", "hidden");
      }
    });

    readout.textContent = "";
    const lineHeight = 14;
    lines.forEach((text, i) => {
      const tspan = document.createElementNS(SVG_NS, "tspan");
      tspan.setAttribute("x", "0");
      tspan.setAttribute("dy", i === 0 ? "0" : String(lineHeight));
      tspan.setAttribute("class", i === 0 ? "gdu-readout-head" : "");
      tspan.textContent = text;
      readout.appendChild(tspan);
    });

    // Flip the readout to whichever side of the crosshair has room.
    const boxW = 132;
    const boxH = 12 + lines.length * lineHeight;
    const left = x(offset) + 10 + boxW > margin.left + plotW;
    const bx = left ? x(offset) - 10 - boxW : x(offset) + 10;
    const by = margin.top + 6;
    readoutBg.setAttribute("x", bx);
    readoutBg.setAttribute("y", by);
    readoutBg.setAttribute("width", boxW);
    readoutBg.setAttribute("height", boxH);
    readout.setAttribute("transform", `translate(${bx + 8}, ${by + 16})`);
  }

  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", () => group.setAttribute("visibility", "hidden"));
  root.appendChild(hit);
}

/**
 * The legend. Always rendered alongside the chart — with five series,
 * hue alone is not an acceptable way to establish identity.
 * @returns {HTMLElement}
 */
export function buildChartLegend(season) {
  const wrap = document.createElement("div");
  wrap.className = "gdu-legend";
  for (const key of DRAW_ORDER) {
    const s = season.scenarios.find((sc) => sc.key === key);
    if (!s) continue;
    const style = SERIES_STYLE[key];
    const item = document.createElement("span");
    item.className = "gdu-legend-item";
    const swatch = document.createElement("span");
    swatch.className = "gdu-legend-swatch";
    // A dashed series gets a dashed swatch, so the legend distinguishes
    // it the same way the chart does. Set as background-IMAGE, not the
    // `background` shorthand — the shorthand would reset background-image
    // inline, and an inline reset cannot be overridden by a class rule.
    if (style.dash) swatch.style.backgroundImage = `repeating-linear-gradient(to right, var(${style.varName}) 0 5px, transparent 5px 8px)`;
    else swatch.style.backgroundColor = `var(${style.varName})`;
    if (key === "current") swatch.classList.add("gdu-legend-swatch-hero");
    const text = document.createElement("span");
    text.textContent = s.label;
    item.appendChild(swatch);
    item.appendChild(text);
    wrap.appendChild(item);
  }
  return wrap;
}
