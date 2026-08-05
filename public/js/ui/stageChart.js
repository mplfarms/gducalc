// src/ui/stageChart.js
//
// The stage-band chart: the growth stages stacked up a GDU axis, each
// band labeled with the date the crop is projected to reach it, and a
// progress column showing where the season actually is right now.
//
// It answers a different question from the accumulation chart. The line
// chart asks "how does this year compare to normal"; this one asks
// "where is my corn, and when does the next thing happen". Same numbers,
// and the two agree by construction — both read the same cumulative
// curve — but a rep standing in a field wants the second one.
//
// ---------------------------------------------------------------
// Color
// ---------------------------------------------------------------
// A SEQUENTIAL ramp, not a categorical palette: the bands encode a
// single ordered quantity (progress through the season), so they get one
// hue running light to dark rather than a different hue per stage.
// Rainbow-ing fifteen stages would imply fifteen unrelated categories.
//
// The hue is set per Brand View in gdu.css: green for Midwest, whose own
// identity is green, and harvest gold for NC+ and Crow's, whose reds and
// blues a green ramp sits awkwardly against. Applied as stepped alpha
// over the card surface rather than as fixed hex steps, so the same ramp
// works on every card background. Text stays in the theme's own ink
// token — a label never wears the series color.
//
// One structural detail exists purely to make the gold work in dark
// mode: an opaque backdrop rect sits behind the bands. Alpha-compositing
// a warm hue over a COOL card cannot produce gold — gold over NC+'s blue
// desaturates to khaki (measured: 0.24 saturation at the top of the ramp
// versus 0.62 over a warm base), which is exactly what it looked like.
// Giving the plot its own dark warm base to composite against restores
// the hue, and as a side effect lifts the worst band-label contrast from
// 3.9:1 to 4.6:1. The backdrop is transparent in light mode and for
// Midwest, where compositing over the card already works.
//
// The bands then go in their own <g> above that backdrop; dividers and
// labels stay outside the group so they are never affected by anything
// applied to the ramp as a whole.

import { formatShort } from "../core/dates.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined) continue;
    el.setAttribute(k, String(v));
  }
  return el;
}

function niceStep(rough) {
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * pow;
}

/**
 * @param {HTMLElement} container
 * @param {Object} opts
 * @param {Array} opts.stages output of datedStages()
 * @param {number|null} opts.gduToDate observed accumulation, or null
 * @param {string|null} opts.asOfIso date `gduToDate` runs through
 * @returns {{destroy: () => void}}
 */
export function renderStageChart(container, opts) {
  let observer = null;

  function draw() {
    const width = Math.max(280, container.clientWidth);
    container.textContent = "";
    container.appendChild(build(width, opts));
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

function build(width, { stages, gduToDate, asOfIso }) {
  const margin = { top: 16, right: 12, bottom: 26, left: 46 };
  // Every band needs to stay tall enough to print a label inside it. The
  // thinnest band in the ladder is about 5% of the total, so the plot has
  // to be tall enough that 5% of it clears a line of text — hence a
  // generous fixed height rather than an aspect ratio. The card scrolls;
  // an unreadable chart doesn't get more readable by fitting on screen.
  const plotH = 620;
  const height = plotH + margin.top + margin.bottom;
  const plotW = width - margin.left - margin.right;

  const maxGdu = stages[stages.length - 1].gdu;
  const yMax = Math.ceil((maxGdu * 1.02) / 100) * 100;
  const y = (g) => margin.top + plotH - (g / yMax) * plotH;

  const root = svg("svg", {
    class: "gdu-stage-chart-svg",
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": "Corn growth stages stacked by growing degree units from planting, with the projected date for each. The same figures are listed in the Data tab.",
  });

  // ---- y grid + labels -----------------------------------------
  const yStep = niceStep(yMax / 6);
  for (let v = 0; v <= yMax + 1; v += yStep) {
    root.appendChild(svg("line", { class: "gdu-grid", x1: margin.left, x2: margin.left + plotW, y1: y(v), y2: y(v) }));
    const label = svg("text", { class: "gdu-axis-label", x: margin.left - 7, y: y(v) + 4, "text-anchor": "end" });
    label.textContent = v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : String(v);
    root.appendChild(label);
  }

  const axisTitle = svg("text", { class: "gdu-axis-title", x: 12, y: margin.top + plotH / 2, transform: `rotate(-90 12 ${margin.top + plotH / 2})`, "text-anchor": "middle" });
  axisTitle.textContent = "GDU from planting";
  root.appendChild(axisTitle);

  // ---- bands ----------------------------------------------------
  // Band i runs from stage i's threshold up to stage i+1's — i.e. "the
  // crop is in this stage between these two GDU totals". The final entry
  // (maturity) is the top of the stack, not a band of its own.
  const bandCount = stages.length - 1;
  // See the header: this is what lets a warm ramp stay warm on a cool
  // card. Sized to the band stack rather than the whole plot — the plot
  // has headroom above the top band, and filling that too read as a dark
  // bar across the top of the chart.
  const stackTop = y(stages[stages.length - 1].gdu);
  root.appendChild(
    svg("rect", { class: "gdu-stage-backdrop", x: margin.left, y: stackTop, width: plotW, height: margin.top + plotH - stackTop })
  );
  const bandGroup = svg("g", { class: "gdu-stage-bands" });
  root.appendChild(bandGroup);

  // TWO ramps, split at R1. Green climbs through the vegetative stages,
  // then gold restarts light at silking and deepens to black layer. The
  // reset is the point: it puts a visible line at the moment the plant
  // stops building leaves and starts filling grain, which is the single
  // most important transition on this chart and previously had nothing
  // marking it but a date. Same in every Brand View — this encodes the
  // crop's biology, not the brand.
  const silkIdx = Math.max(
    0,
    stages.findIndex((st) => st.key === "silk")
  );

  // The "N GDU through <date>" rule is drawn later, but its y has to be
  // known NOW: it cuts straight through whichever band the crop is
  // currently in, and that band's centered label lands on top of it.
  // Left alone the two overprint into an unreadable smear — which is
  // exactly what happens mid-season, on the one band a rep is looking at.
  const todayY = Number.isFinite(gduToDate) && gduToDate > 0 ? y(Math.min(gduToDate, yMax)) : null;

  for (let i = 0; i < bandCount; i++) {
    const from = stages[i];
    const to = stages[i + 1];
    const top = y(to.gdu);
    const bottom = y(from.gdu);
    const bandH = bottom - top;

    // Each half runs its own light-to-dark alpha schedule, so the gold
    // starts pale at R1 rather than picking up where the green left off.
    const reproductive = silkIdx > 0 && i >= silkIdx;
    const stepsInHalf = reproductive ? bandCount - silkIdx : silkIdx > 0 ? silkIdx : bandCount;
    const stepInHalf = reproductive ? i - silkIdx : i;
    bandGroup.appendChild(
      svg("rect", {
        class: `gdu-stage-band ${reproductive ? "gdu-stage-band-rep" : "gdu-stage-band-veg"}`,
        x: margin.left,
        y: top,
        width: plotW,
        height: Math.max(bandH, 1),
        "fill-opacity": (0.09 + (stepInHalf / Math.max(1, stepsInHalf - 1)) * 0.42).toFixed(3),
      })
    );
    // A 2px surface-colored rule between bands, so adjacent steps of the
    // same ramp stay visually separable without adding a border color.
    // Outside bandGroup on purpose — see the note in this file's header.
    root.appendChild(svg("line", { class: "gdu-stage-divider", x1: margin.left, x2: margin.left + plotW, y1: top, y2: top }));

    if (bandH < 13) continue; // no room for a label; the Data tab has it

    // If the progress rule splits this band, put the label in whichever
    // half has more room rather than centering it on the rule. Below 16px
    // the remaining half is too shallow to clear the rule's own label, so
    // the band label is dropped instead of drawn into it — the Data card
    // carries every one of these figures anyway.
    let labelCenter = bottom - bandH / 2;
    if (todayY !== null && todayY > top + 1 && todayY < bottom - 1) {
      const above = todayY - top;
      const below = bottom - todayY;
      const room = Math.max(above, below);
      if (room < 16) continue;
      labelCenter = above >= below ? top + above / 2 : todayY + below / 2;
    }
    const dateText = from.iso ? ` (~ ${formatShort(from.iso, { withYear: true })})` : " (not reached)";
    // Hottest daytime high / warmest nighttime low for the stretch the
    // crop spent in this stage. Appended to the existing line rather than
    // given one of its own — the thinnest bands here are barely tall
    // enough for a single line, and a second line would drop out of
    // exactly the bands a rep is most likely to be squinting at. Present
    // only when every day in the span was observed, so a band still in
    // the forecast simply has nothing after the date.
    const tempText = from.bandTemps ? ` · ${Math.round(from.bandTemps.maxHigh)}°/${Math.round(from.bandTemps.maxLow)}°` : "";
    const label = svg("text", {
      class: `gdu-stage-band-label${from.anchored ? " gdu-stage-band-label-anchored" : ""}`,
      x: margin.left + plotW / 2,
      y: labelCenter + 4,
      "text-anchor": "middle",
    });
    label.textContent = `${from.label}${dateText}${tempText}`;
    root.appendChild(label);
    if (from.projected && bandH >= 26) {
      const sub = svg("text", { class: "gdu-stage-band-sub", x: margin.left + plotW / 2, y: labelCenter + 17, "text-anchor": "middle" });
      sub.textContent = "projected";
      root.appendChild(sub);
    }
  }

  // Maturity sits above the stack rather than inside a band of its own —
  // it is the top edge, not a span.
  const maturity = stages[stages.length - 1];
  const topLabel = svg("text", { class: "gdu-stage-top-label", x: margin.left + plotW / 2, y: y(maturity.gdu) - 6, "text-anchor": "middle" });
  topLabel.textContent = maturity.iso ? `${maturity.label} (~ ${formatShort(maturity.iso, { withYear: true })})` : `${maturity.label} — not reached in season`;
  root.appendChild(topLabel);

  // ---- progress overlay -----------------------------------------
  // Where the crop actually is: a filled gutter up the LEFT edge plus a
  // rule across the full width.
  //
  // The gutter is deliberately not a centered column over the bands (the
  // obvious first cut, and what the reference chart does) — the band
  // labels are centered, so a centered column draws its two vertical
  // edges straight through every line of text. Pushing the fill into a
  // narrow gutter keeps the "how far along am I" reading and leaves the
  // labels clean.
  if (todayY !== null) {
    const capped = Math.min(gduToDate, yMax);
    const gutterW = 14;
    root.appendChild(
      svg("rect", {
        class: "gdu-stage-progress",
        x: margin.left,
        y: y(capped),
        width: gutterW,
        height: margin.top + plotH - y(capped),
      })
    );
    root.appendChild(svg("line", { class: "gdu-stage-today-line", x1: margin.left, x2: margin.left + plotW, y1: y(capped), y2: y(capped) }));

    const text = svg("text", {
      class: "gdu-stage-today-label",
      x: margin.left + plotW - 4,
      // Flip below the rule when it is near the top of the plot, so the
      // label never gets clipped off the chart.
      y: y(capped) - 6 < margin.top + 12 ? y(capped) + 14 : y(capped) - 6,
      "text-anchor": "end",
    });
    text.textContent = `${Math.round(gduToDate).toLocaleString()} GDU through ${formatShort(asOfIso)}`;
    root.appendChild(text);
  }

  return root;
}

/**
 * Which stage the crop is in right now, for the caption above the chart.
 * @param {Array} stages
 * @param {number|null} gduToDate
 * @returns {{current: Object, next: Object|null}|null}
 */
export function currentStage(stages, gduToDate) {
  if (!Number.isFinite(gduToDate)) return null;
  let current = stages[0];
  let next = null;
  for (let i = 0; i < stages.length; i++) {
    if (stages[i].gdu <= gduToDate) {
      current = stages[i];
      next = stages[i + 1] || null;
    }
  }
  return { current, next };
}
