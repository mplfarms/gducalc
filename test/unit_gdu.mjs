// Unit tests for the GDU engine. Plain node, no dependencies:
//   node test/unit_gdu.mjs
//
// Every expected value here is hand-worked from the formula in
// gdu.js's header, not captured from a previous run of this code — a
// snapshot test would happily lock in a wrong answer.

import assert from "node:assert/strict";
import fs from "node:fs";
import { dailyGdu, percentile, accumulate, envelopeFromCalendarDate, offsetAtTarget, firstFreezeStats, buildDailyIndex, bandTempStats, dayLimitKind, GDU_MAX_PER_DAY } from "../public/js/core/gdu.js";
import { addDays, daysBetween, isoForYear, isoToUtcMs, utcMsToIso, monthDayOf, formatShort } from "../public/js/core/dates.js";
import { buildSeason, baselineYearsFor, SEASON_DAYS } from "../public/js/core/season.js";
import { STAGE_LADDER, stagesForHybrid, datedStages, REFERENCE_SILK, REFERENCE_BLACK_LAYER } from "../public/js/core/stages.js";
import {
  resolve as resolveHybrid,
  MODELS,
  RM_FITTED_MIN,
  RM_FITTED_MAX,
  FITTED_N,
  RM_MIN,
  RM_MAX,
  SILK_MIN,
  SILK_MAX,
  BL_MIN,
  BL_MAX,
  MIN_SILK_TO_BL_SPAN,
} from "../public/js/core/hybridEstimate.js";
import { bareVariety, rmOutlierNote } from "../public/js/core/hybridCatalog.js";
import { buildSummary } from "../public/js/ui/components/shareMenu.js";
import { frostVerdict } from "../public/js/core/frostVerdict.js";
import { noFreezeText, freezeCoverageNote, solidCaption, temperatureProvenance, recordQualityNote, thinBaselineText } from "../public/js/core/frostText.js";
import { BRANDS, brandedHybridName } from "../public/js/ui/brand.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

const dateFns = { addDays, isoForYear };

// ---------------------------------------------------------------
console.log("\ndates.js");
// ---------------------------------------------------------------

test("addDays crosses the spring DST boundary without drifting", () => {
  // US DST began 2026-03-08. A local-time +86400000ms loop loses an hour
  // here and can land back on the same calendar day.
  assert.equal(addDays("2026-03-07", 1), "2026-03-08");
  assert.equal(addDays("2026-03-08", 1), "2026-03-09");
  assert.equal(addDays("2026-03-01", 10), "2026-03-11");
});

test("addDays crosses the fall DST boundary and year end", () => {
  assert.equal(addDays("2026-11-01", 1), "2026-11-02");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
});

test("addDays handles leap years", () => {
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2024-02-29", 1), "2024-03-01");
  assert.equal(addDays("2025-02-28", 1), "2025-03-01");
});

test("addDays over a full season window is exact", () => {
  // May 1 + 219 = the last offset of a 220-day window.
  assert.equal(addDays("2026-05-01", 219), "2026-12-06");
  assert.equal(daysBetween("2026-05-01", "2026-12-06"), 219);
});

test("isoForYear refuses to slide Feb 29 into a non-leap year", () => {
  assert.equal(isoForYear("02-29", 2024), "2024-02-29");
  assert.equal(isoForYear("02-29", 2025), null);
  assert.equal(isoForYear("05-01", 1996), "1996-05-01");
});

test("iso round-trip and helpers", () => {
  assert.equal(utcMsToIso(isoToUtcMs("2026-07-18")), "2026-07-18");
  assert.equal(monthDayOf("2026-07-18"), "07-18");
  assert.equal(formatShort("2026-07-18"), "Jul 18");
  assert.equal(formatShort("2026-07-18", { withYear: true }), "Jul 18, 2026");
  assert.equal(formatShort("garbage"), "—");
});

// ---------------------------------------------------------------
console.log("\ngdu.js — daily formula");
// ---------------------------------------------------------------

test("textbook day: 86 high / 50 low = 18 GDU", () => {
  assert.equal(dailyGdu(86, 50), 18);
});

test("heat above 86 does not add GDUs", () => {
  // (86 + 70)/2 - 50 = 28, identical whether the high was 90 or 110.
  assert.equal(dailyGdu(90, 70), 28);
  assert.equal(dailyGdu(110, 70), 28);
});

test("a day below 50 contributes 0, never a negative", () => {
  assert.equal(dailyGdu(45, 30), 0);
  assert.equal(dailyGdu(49.9, -10), 0);
});

test("night lows below 50 are floored to 50", () => {
  // (70 + 50)/2 - 50 = 10 — a 40 °F low counts the same as a 50 °F low.
  assert.equal(dailyGdu(70, 40), 10);
  assert.equal(dailyGdu(70, 50), 10);
});

test("the daily maximum is 36 GDU", () => {
  assert.equal(dailyGdu(95, 90), GDU_MAX_PER_DAY);
  assert.equal(GDU_MAX_PER_DAY, 36);
});

test("missing or garbage temperatures give null, not 0", () => {
  assert.equal(dailyGdu(null, 50), null);
  assert.equal(dailyGdu(86, null), null);
  assert.equal(dailyGdu(undefined, undefined), null);
  assert.equal(dailyGdu(NaN, 50), null);
});

test("a min > max row still produces the same defensible answer", () => {
  assert.equal(dailyGdu(60, 80), dailyGdu(80, 60));
});

// ---------------------------------------------------------------
console.log("\ngdu.js — percentile");
// ---------------------------------------------------------------

test("percentile matches Excel PERCENTILE.INC / numpy default", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  // rank = (10-1)*0.9 = 8.1 -> 9 + 0.1*(10-9) = 9.1
  assert.equal(Math.round(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9) * 100) / 100, 9.1);
  assert.equal(Math.round(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.1) * 100) / 100, 1.9);
});

test("percentile is order-independent and handles degenerate input", () => {
  assert.equal(percentile([5, 1, 3], 0.5), 3);
  assert.equal(percentile([7], 0.9), 7);
  assert.equal(percentile([], 0.5), null);
});

// ---------------------------------------------------------------
console.log("\ngdu.js — accumulation");
// ---------------------------------------------------------------

/** Every ISO date from `startIso` through `endIso`, inclusive. */
function allDays(startIso, endIso) {
  const out = [];
  for (let i = 0; i <= daysBetween(startIso, endIso); i++) out.push(addDays(startIso, i));
  return out;
}

/** Builds an index where every day in a range has the same tmax/tmin. */
function flatIndex(startIso, days, tmax, tmin) {
  const time = [];
  for (let i = 0; i < days; i++) time.push(addDays(startIso, i));
  return buildDailyIndex([{ time, tmax: time.map(() => tmax), tmin: time.map(() => tmin), source: "observed" }]);
}

test("accumulation counts the planting day itself", () => {
  const idx = flatIndex("2026-05-01", 10, 86, 50); // 18 GDU/day
  const { cum, complete } = accumulate(idx, "2026-05-01", 5, addDays);
  assert.deepEqual(cum, [18, 36, 54, 72, 90]);
  assert.equal(complete, true);
});

test("a data gap truncates rather than silently bridging it", () => {
  const idx = flatIndex("2026-05-01", 10, 86, 50);
  delete idx["2026-05-04"]; // punch a hole at offset 3
  const { cum, complete, lastCompleteOffset } = accumulate(idx, "2026-05-01", 6, addDays);
  assert.deepEqual(cum, [18, 36, 54, null, null, null]);
  assert.equal(complete, false);
  assert.equal(lastCompleteOffset, 2);
});

test("accumulation over a window with no data at all is all null", () => {
  const idx = flatIndex("2026-05-01", 5, 86, 50);
  const { cum, lastCompleteOffset } = accumulate(idx, "2027-05-01", 3, addDays);
  assert.deepEqual(cum, [null, null, null]);
  assert.equal(lastCompleteOffset, -1);
});

// ---------------------------------------------------------------
console.log("\ngdu.js — threshold crossing");
// ---------------------------------------------------------------

test("offsetAtTarget returns the first day the total reaches the target", () => {
  const cum = [18, 36, 54, 72, 90];
  assert.equal(offsetAtTarget(cum, 54), 2); // exactly on the boundary
  assert.equal(offsetAtTarget(cum, 55), 3);
  assert.equal(offsetAtTarget(cum, 18), 0);
});

test("offsetAtTarget returns null when the target is never reached", () => {
  assert.equal(offsetAtTarget([18, 36, 54], 1000), null);
});

test("offsetAtTarget stops at a null rather than reporting across a gap", () => {
  // Without the null guard this would report offset 3 as the crossing,
  // even though days 1-2 are unknown.
  assert.equal(offsetAtTarget([18, null, null, 900], 500), null);
});

// ---------------------------------------------------------------
console.log("\ngdu.js — climatological envelope");
// ---------------------------------------------------------------

/**
 * Ten synthetic years planted May 1, each with a constant but different
 * daily GDU: year 2016 = 10/day, 2017 = 11/day, ... 2025 = 19/day.
 * Cumulative at offset i for year y is therefore (rate)*(i+1), which
 * makes every percentile hand-checkable.
 */
function syntheticYears() {
  const series = [];
  for (let k = 0; k < 10; k++) {
    const year = 2016 + k;
    const gduPerDay = 10 + k; // needs tmax = 2*(gdu+50) - tmin with tmin = 50
    const tmax = 2 * (gduPerDay + 50) - 50; // e.g. 10 -> 70, 19 -> 88 (clamped to 86!)
    const time = [];
    for (let i = 0; i < 300; i++) time.push(addDays(`${year}-01-01`, i));
    series.push({ time, tmax: time.map(() => tmax), tmin: time.map(() => 50), source: "observed" });
  }
  return buildDailyIndex(series);
}

test("synthetic fixture actually produces the intended daily rates", () => {
  // Guards the fixture itself: rate 19 would need tmax 88, which clamps
  // to 86 and yields 18 — so the top year is 18/day, not 19/day.
  assert.equal(dailyGdu(70, 50), 10);
  assert.equal(dailyGdu(86, 50), 18);
  assert.equal(dailyGdu(88, 50), 18);
});

test("envelope percentiles are computed across years at each offset", () => {
  const idx = syntheticYears();
  const years = [];
  for (let y = 2016; y <= 2025; y++) years.push(y);
  const env = envelopeFromCalendarDate(idx, "05-01", years, 50, dateFns);
  assert.equal(env.yearsUsed.length, 10);

  // Daily rates across the 10 years: 10,11,...,17,18,18 (top two clamp).
  // At offset 0 the cumulative values are exactly those rates.
  const day0 = years.map((y) => env.perYear[y][0]).sort((a, b) => a - b);
  assert.deepEqual(day0, [10, 11, 12, 13, 14, 15, 16, 17, 18, 18]);
  assert.equal(env.p50[0], percentile(day0, 0.5));
  assert.equal(env.p10[0], percentile(day0, 0.1));
  assert.equal(env.p90[0], percentile(day0, 0.9));

  // And they scale linearly with the day count, since each year is flat.
  assert.equal(Math.round(env.p50[9] * 1000) / 1000, Math.round(env.p50[0] * 10 * 1000) / 1000);
});

test("envelope curves never decrease", () => {
  const idx = syntheticYears();
  const years = [];
  for (let y = 2016; y <= 2025; y++) years.push(y);
  const env = envelopeFromCalendarDate(idx, "05-01", years, 100, dateFns);
  for (const band of ["p10", "p50", "p90"]) {
    for (let i = 1; i < env[band].length; i++) {
      assert.ok(env[band][i] >= env[band][i - 1], `${band} decreased at offset ${i}`);
    }
  }
});

test("p10 <= p50 <= p90 at every offset", () => {
  const idx = syntheticYears();
  const years = [];
  for (let y = 2016; y <= 2025; y++) years.push(y);
  const env = envelopeFromCalendarDate(idx, "05-01", years, 100, dateFns);
  for (let i = 0; i < 100; i++) {
    assert.ok(env.p10[i] <= env.p50[i], `p10 > p50 at ${i}`);
    assert.ok(env.p50[i] <= env.p90[i], `p50 > p90 at ${i}`);
  }
});

test("a year with incomplete coverage is dropped, not partially used", () => {
  const idx = syntheticYears();
  // Remove one day from 2020's window — the whole year should drop out.
  delete idx["2020-06-01"];
  const years = [];
  for (let y = 2016; y <= 2025; y++) years.push(y);
  const env = envelopeFromCalendarDate(idx, "05-01", years, 100, dateFns);
  assert.equal(env.yearsUsed.length, 9);
  assert.ok(!env.yearsUsed.includes(2020));
});

// ---------------------------------------------------------------
console.log("\ngdu.js — first freeze");
// ---------------------------------------------------------------

test("first freeze stats find the first sub-28 day on or after Aug 1", () => {
  // Three years: freeze on Oct 1, Oct 5, Oct 9 (offsets 61, 65, 69 from
  // Aug 1). Median offset = 65 -> Oct 5.
  const series = [];
  const freezeDates = { 2020: "2020-10-01", 2021: "2021-10-05", 2022: "2022-10-09" };
  for (const [y, freezeIso] of Object.entries(freezeDates)) {
    const time = [];
    for (let i = 0; i < 200; i++) time.push(addDays(`${y}-07-01`, i));
    series.push({
      time,
      tmax: time.map(() => 70),
      tmin: time.map((d) => (d >= freezeIso ? 25 : 55)),
      source: "observed",
    });
  }
  const idx = buildDailyIndex(series);
  const res = firstFreezeStats(idx, [2020, 2021, 2022], 28, dateFns);
  assert.equal(res.medianMonthDay, "10-05");
  assert.equal(res.earliestMonthDay, "10-01");
  // Nearest-rank on offsets {61, 65, 69}: the 10th percentile is the
  // ceil(0.1*3) = 1st earliest, i.e. offset 61 -> Oct 1. It used to
  // interpolate to 61.8 -> Oct 2, which is a date no year in the sample
  // actually froze on. With three years the honest statement is "the
  // earliest of the three"; see censoredQuantile in gdu.js for why the
  // interpolating convention was dropped for frost dates specifically.
  assert.equal(res.p10MonthDay, "10-01");
  assert.equal(res.yearsUsed, 3);
});

test("a percentile is never interpolated into the censored tail", () => {
  // 30 years, N of them freezing on a spread of dates between 60 and 105
  // days after Aug 1 (latest real freeze Nov 14), the rest never freezing
  // inside the 140-day window.
  //
  // The interpolating percentile() averaged a real freeze offset with the
  // 140-day sentinel and produced a finite number below it, which then
  // rendered as a date. Measured before the fix: 15 years freezing gave a
  // "median" of Dec 2 and 3 years freezing gave a "1 year in 10" date of
  // Dec 16 — both later than any freeze that ever happened there.
  const years = Array.from({ length: 30 }, (_, i) => 1996 + i);
  const build = (nFroze) => {
    const series = [];
    for (let k = 0; k < 30; k++) {
      const y = 1996 + k;
      const time = [];
      const tmax = [];
      const tmin = [];
      const freezeAt = 60 + Math.round((45 * k) / 29);
      for (let i = 0; i < 200; i++) {
        const d = addDays(`${y}-07-01`, i);
        time.push(d);
        tmax.push(70);
        tmin.push(k < nFroze && daysBetween(`${y}-08-01`, d) === freezeAt ? 20 : 55);
      }
      series.push({ time, tmax, tmin, source: "observed" });
    }
    return buildDailyIndex(series);
  };
  const LATEST_REAL = "11-14";
  for (const n of [30, 20, 16, 15, 14, 3, 1, 0]) {
    const r = firstFreezeStats(build(n), years, 28, dateFns);
    assert.equal(r.yearsUsed, 30, `${n}: every year contributes, frozen or censored`);
    assert.equal(r.yearsFroze, n);
    for (const [label, md] of [["median", r.medianMonthDay], ["p10", r.p10MonthDay], ["earliest", r.earliestMonthDay]]) {
      if (md !== null) assert.ok(md <= LATEST_REAL, `${n} froze: ${label} ${md} is later than any freeze in the record`);
    }
  }
  // The boundary is exactly where the empirical CDF reaches p: a median
  // needs ceil(0.5 * 30) = 15 years to have frozen, a 1-in-10 date needs
  // ceil(0.1 * 30) = 3. Not one year more.
  //
  // The 3-of-30 case is the one that matters. 3 in 30 IS 1 in 10, so the
  // date is knowable — and the UI's refusal branch says "not enough for a
  // 1-year-in-10 date to mean anything", which at a location where three
  // of the last thirty years froze would be exactly backwards.
  assert.equal(firstFreezeStats(build(15), years, 28, dateFns).medianMonthDay, "10-22");
  assert.equal(firstFreezeStats(build(14), years, 28, dateFns).medianMonthDay, null);
  assert.equal(firstFreezeStats(build(3), years, 28, dateFns).p10MonthDay, "10-03");
  assert.equal(firstFreezeStats(build(2), years, 28, dateFns).p10MonthDay, null);
  // A quantile that IS reported is always a day some year actually froze
  // on, never a blend of two.
  const r = firstFreezeStats(build(30), years, 28, dateFns);
  assert.equal(r.p10MonthDay, "10-03");
  assert.equal(r.medianMonthDay, "10-22");
});

test("no freeze in the record reports nothing rather than guessing", () => {
  const idx = flatIndex("2020-07-01", 200, 70, 55);
  const res = firstFreezeStats(idx, [2020], 28, dateFns);
  // The year contributed a censored observation ("no freeze in 140 days"),
  // so it counts toward yearsUsed but not yearsFroze. With every year
  // censored there is no date to report at any percentile.
  assert.equal(res.medianMonthDay, null);
  assert.equal(res.p10MonthDay, null);
  assert.equal(res.earliestMonthDay, null);
  assert.equal(res.yearsFroze, 0);
  assert.equal(res.yearsUsed, 1);
});

// ---------------------------------------------------------------
console.log("\nseason.js — end to end");
// ---------------------------------------------------------------

test("baselineYearsFor returns 30 completed years", () => {
  const years = baselineYearsFor(2026);
  assert.equal(years.length, 30);
  assert.equal(years[0], 1996);
  assert.equal(years[29], 2025);
});

test("a fully-known season produces exact, hand-checkable stage dates", () => {
  // 18 GDU/day flat, everywhere, for 40 years. Silk at 1250 GDU is
  // reached on day ceil(1250/18) = 70 -> offset 69 (0-indexed), i.e.
  // May 1 + 69 days = Jul 9. Black layer at 2650 -> ceil(2650/18) = 148
  // -> offset 147 -> Sep 25.
  const time = allDays("1995-01-01", "2027-06-30");
  const idx = buildDailyIndex([{ time, tmax: time.map(() => 86), tmin: time.map(() => 50), source: "observed" }]);
  const lastIso = time[time.length - 1];

  const s = buildSeason({
    index: idx,
    plantingIso: "2026-05-01",
    gduToSilk: 1250,
    gduToBlackLayer: 2650,
    lastKnownIso: lastIso,
    lastObservedIso: lastIso,
  });

  const normal = s.rows.find((r) => r.key === "normal");
  assert.equal(normal.silkOffset, 69);
  assert.equal(normal.silkIso, "2026-07-09");
  assert.equal(normal.blackLayerOffset, 147);
  assert.equal(normal.blackLayerIso, "2026-09-25");

  // With every year identical, hot / cool / normal / last year all agree.
  for (const key of ["hot", "cool", "lastYear"]) {
    const row = s.rows.find((r) => r.key === key);
    assert.equal(row.silkIso, "2026-07-09", `${key} silk`);
    assert.equal(row.blackLayerIso, "2026-09-25", `${key} black layer`);
  }
});

test("the current-season projection splices onto observed data without a jump", () => {
  // Observed through Jun 30 at 20 GDU/day; history is 10 GDU/day. The
  // projection must continue from the observed total, not restart from
  // the climatological curve.
  //
  // Note the hot days are 86/54, not 90/50 — 90 clamps to 86, so
  // tmax alone cannot push a day past 18 GDU with a 50 °F low. Getting
  // 20 GDU/day requires lifting the LOW. (This is the cap doing exactly
  // what the formula says it should; the fixture has to respect it.)
  const histTime = allDays("1995-01-01", "2027-06-30");
  const series = [{ time: histTime, tmax: histTime.map(() => 70), tmin: histTime.map(() => 50), source: "observed" }];
  const hotTime = allDays("2026-05-01", "2026-06-30"); // 61 days
  series.push({ time: hotTime, tmax: hotTime.map(() => 86), tmin: hotTime.map(() => 54), source: "observed" });
  const idx = buildDailyIndex(series);

  const s = buildSeason({
    index: idx,
    plantingIso: "2026-05-01",
    gduToSilk: 1250,
    gduToBlackLayer: 2650,
    lastKnownIso: "2026-06-30",
    lastObservedIso: "2026-06-30",
  });

  // With no gap, the derived dates match what the caller downloaded.
  assert.equal(s.lastObservedIso, "2026-06-30");
  assert.equal(s.lastKnownIso, "2026-06-30");
  assert.equal(s.truncatedByGap, false);

  const current = s.scenarios.find((x) => x.key === "current");
  assert.equal(current.solidThroughOffset, 60); // May 1 + 60 = Jun 30
  assert.equal(current.cum[60], 61 * 20); // 61 observed days at 20/day
  // Day 61 is the first projected day and must be exactly one normal
  // day (10 GDU) above the observed total — no discontinuity.
  assert.equal(current.cum[61], 61 * 20 + 10);
  assert.equal(current.cum[62], 61 * 20 + 20);

  // And the run-hot season is genuinely ahead of the normal curve.
  const normalRow = s.rows.find((r) => r.key === "normal");
  const currentRow = s.rows.find((r) => r.key === "current-normal");
  assert.ok(currentRow.silkOffset < normalRow.silkOffset, "hot start should silk earlier than normal");
});

test("a mid-season gap relabels the totals instead of dating them to a day they don't cover", () => {
  // Every screen that prints a GDU total prints "Through <date>" beside
  // it, reading season.lastObservedIso. That field used to be the
  // caller's download horizon echoed straight back, so a hole in the
  // record produced a May-30 total captioned "Through Jul 1" — the two
  // most load-bearing numbers on the status card disagreeing silently.
  const histTime = allDays("1995-01-01", "2027-06-30");
  const series = [{ time: histTime, tmax: histTime.map(() => 70), tmin: histTime.map(() => 50), source: "observed" }];
  const idx = buildDailyIndex(series);
  delete idx["2026-05-31"]; // hole 30 days after planting

  const s = buildSeason({
    index: idx,
    plantingIso: "2026-05-01",
    gduToSilk: 1250,
    gduToBlackLayer: 2650,
    lastKnownIso: "2026-07-01",
    lastObservedIso: "2026-07-01",
  });

  assert.equal(s.knownEndOffset, 29); // May 1 + 29 = May 30
  assert.equal(s.lastKnownIso, "2026-05-30");
  assert.equal(s.lastObservedIso, "2026-05-30");
  assert.equal(s.truncatedByGap, true);
  // 30 days at 10 GDU/day, and the label now names the day it stops on.
  assert.equal(s.gduToDate, 300);
  // The caller's own numbers are still available, just not passed off as
  // coverage.
  assert.equal(s.requestedKnownIso, "2026-07-01");
});

test("a complete past season is not accused of having a data gap", () => {
  // horizonOffset is daysBetween(planting, lastKnownIso). For a 2024
  // planting looked up in 2026 that is ~800 days, while knownEndOffset is
  // clamped to the 220-day season — so "the record stopped short of the
  // horizon" was permanently true and lit an orange data-gap warning on
  // every historical lookup, which is a supported path with its own
  // "Looking back at the 2024 season" banner.
  const time = allDays("1995-01-01", "2026-08-06");
  const idx = buildDailyIndex([{ time, tmax: time.map(() => 80), tmin: time.map(() => 60), source: "observed" }]);
  const s = buildSeason({
    index: idx,
    plantingIso: "2024-05-01",
    gduToSilk: 1250,
    gduToBlackLayer: 2650,
    lastKnownIso: "2026-08-06",
    lastObservedIso: "2026-08-06",
  });
  assert.equal(s.knownEndOffset, SEASON_DAYS - 1);
  assert.equal(s.truncatedByGap, false);
});

test("a hole on the planting day is reported, not silently blank", () => {
  // knownEndOffset lands at -1, which the first version of the flag
  // required to be >= 0 — so the single most truncated case produced no
  // warning at all, and the results screen just had nothing on it.
  const time = allDays("1995-01-01", "2026-08-06");
  const idx = buildDailyIndex([{ time, tmax: time.map(() => 80), tmin: time.map(() => 60), source: "observed" }]);
  delete idx["2026-05-01"];
  const s = buildSeason({
    index: idx,
    plantingIso: "2026-05-01",
    gduToSilk: 1250,
    gduToBlackLayer: 2650,
    lastKnownIso: "2026-08-06",
    lastObservedIso: "2026-08-06",
  });
  assert.equal(s.knownEndOffset, -1);
  assert.equal(s.gduToDate, null);
  assert.equal(s.truncatedByGap, true);
  assert.equal(s.lastKnownIso, null);
});

test("a planting date that hasn't arrived is not reported as a data gap", () => {
  const time = allDays("1995-01-01", "2026-08-06");
  const idx = buildDailyIndex([{ time, tmax: time.map(() => 80), tmin: time.map(() => 60), source: "observed" }]);
  const s = buildSeason({
    index: idx,
    plantingIso: "2027-05-01",
    gduToSilk: 1250,
    gduToBlackLayer: 2650,
    lastKnownIso: "2026-08-06",
    lastObservedIso: "2026-08-06",
  });
  assert.equal(s.truncatedByGap, false);
  // The derived coverage dates are null (nothing is covered yet), but the
  // caller's own horizon is kept for the sentences that describe the
  // download rather than the coverage.
  assert.equal(s.lastObservedIso, null);
  assert.equal(s.requestedObservedIso, "2026-08-06");
});

test("the climatology rows are labelled climatology, not forecast", () => {
  // These three describe the location's 30-year record. They were being
  // fed observedThroughOffset = -1 against a full-season horizon, which
  // made basisFor call every day of them "forecast".
  const histTime = allDays("1995-01-01", "2027-06-30");
  const idx = buildDailyIndex([{ time: histTime, tmax: histTime.map(() => 86), tmin: histTime.map(() => 50), source: "observed" }]);
  const s = buildSeason({
    index: idx,
    plantingIso: "2026-05-01",
    gduToSilk: 1250,
    gduToBlackLayer: 2650,
    lastKnownIso: "2026-06-30",
    lastObservedIso: "2026-06-30",
  });
  for (const key of ["hot", "normal", "cool"]) {
    const row = s.rows.find((r) => r.key === key);
    assert.equal(row.silkBasis, "climatology", `${key} silk`);
    assert.equal(row.blackLayerBasis, "climatology", `${key} black layer`);
  }
  // Last year really did happen, so it stays "actual".
  const ly = s.rows.find((r) => r.key === "lastYear");
  assert.equal(ly.silkBasis, "actual");
});

test("a planting date in the future yields no current-season scenario", () => {
  const time = allDays("1995-01-01", "2027-06-30");
  const idx = buildDailyIndex([{ time, tmax: time.map(() => 86), tmin: time.map(() => 50), source: "observed" }]);
  const s = buildSeason({
    index: idx,
    plantingIso: "2030-05-01",
    gduToSilk: 1250,
    gduToBlackLayer: 2650,
    lastKnownIso: time[time.length - 1],
    lastObservedIso: time[time.length - 1],
  });
  assert.equal(s.knownEndOffset, -1);
  assert.ok(!s.scenarios.some((x) => x.key === "current"));
  assert.ok(!s.rows.some((r) => r.key.startsWith("current-")));
});

test("hot finish is never later than cool finish", () => {
  const histTime = allDays("1995-01-01", "2027-06-30");
  // Vary years so the envelope is not degenerate.
  const tmax = histTime.map((d) => 70 + (Number(d.slice(0, 4)) % 7) * 2);
  const idx = buildDailyIndex([{ time: histTime, tmax, tmin: histTime.map(() => 50), source: "observed" }]);
  const s = buildSeason({
    index: idx,
    plantingIso: "2026-05-01",
    gduToSilk: 1250,
    gduToBlackLayer: 2650,
    lastKnownIso: "2026-06-30",
    lastObservedIso: "2026-06-30",
  });
  const hot = s.rows.find((r) => r.key === "current-hot");
  const cool = s.rows.find((r) => r.key === "current-cool");
  // A null offset means "never reached inside the window", which is
  // LATER than any real offset — comparing the raw values would let
  // `null` sort as 0 and quietly invert the check.
  const rank = (o) => (o === null ? Infinity : o);
  assert.ok(rank(hot.silkOffset) <= rank(cool.silkOffset), "hot silk must not be later than cool silk");
  assert.ok(rank(hot.blackLayerOffset) <= rank(cool.blackLayerOffset), "hot finish must not be later than cool finish");
  assert.ok(rank(hot.blackLayerOffset) < Infinity, "fixture should reach black layer in the hot case");
});

test("season window is long enough for a very late, very cool finish", () => {
  assert.equal(SEASON_DAYS, 220);
  // May 1 + 219 days reaches Dec 6 — past any realistic black layer date.
  assert.equal(addDays("2026-05-01", SEASON_DAYS - 1), "2026-12-06");
});


// ---------------------------------------------------------------
console.log("\nhybrid catalog data");
// ---------------------------------------------------------------

const catalogDoc = JSON.parse(fs.readFileSync(new URL("../public/data/hybrids.json", import.meta.url), "utf8"));

test("the shipped catalog parses and has the expected row count", () => {
  assert.ok(Array.isArray(catalogDoc.hybrids));
  assert.equal(catalogDoc.hybrids.length, 133);
});

test("every catalog row is well formed", () => {
  for (const row of catalogDoc.hybrids) {
    assert.ok(typeof row.v === "string" && row.v.trim(), `bad variety: ${JSON.stringify(row)}`);
    assert.ok(Number.isInteger(row.rm) && row.rm >= 70 && row.rm <= 125, `bad RM on ${row.v}: ${row.rm}`);
    assert.ok(Number.isInteger(row.s) && Number.isInteger(row.b), `non-integer GDU on ${row.v}`);
  }
});

test("silk is always below black layer in the catalog", () => {
  // A reversed pair would draw a "silk" reference line above the
  // "black layer" one and produce nonsense stage dates.
  for (const row of catalogDoc.hybrids) {
    assert.ok(row.s < row.b, `${row.v}: silk ${row.s} >= black layer ${row.b}`);
  }
});

test("catalog GDU values are inside physically sane bounds", () => {
  for (const row of catalogDoc.hybrids) {
    assert.ok(row.s >= 700 && row.s <= 1700, `${row.v}: silk ${row.s} out of range`);
    assert.ok(row.b >= 1500 && row.b <= 3200, `${row.v}: black layer ${row.b} out of range`);
  }
});

test("catalog has no duplicate variety names", () => {
  // findByVariety() matches case-insensitively and returns the first
  // hit, so a duplicate would make one of the two unreachable.
  const seen = new Set();
  for (const row of catalogDoc.hybrids) {
    const key = row.v.trim().toLowerCase();
    assert.ok(!seen.has(key), `duplicate variety: ${row.v}`);
    seen.add(key);
  }
});

test("catalog is sorted by maturity, as the picker's RM headings assume", () => {
  // The inline hybrid list is rendered in catalog order; unsorted data
  // would produce the same heading several times down the list.
  for (let i = 1; i < catalogDoc.hybrids.length; i++) {
    assert.ok(catalogDoc.hybrids[i].rm >= catalogDoc.hybrids[i - 1].rm, `RM out of order at index ${i}`);
  }
});

test("every catalog hybrid reaches both stages in a normal Iowa-like season", () => {
  // 30 identical years at 20 GDU/day from May 1 — a deliberately modest
  // rate. If the longest hybrid in the list can't finish inside the
  // 220-day window even here, SEASON_DAYS is too short.
  const time = allDays("1995-01-01", "2027-06-30");
  const idx = buildDailyIndex([{ time, tmax: time.map(() => 86), tmin: time.map(() => 54), source: "observed" }]);
  const longest = catalogDoc.hybrids.reduce((a, b) => (b.b > a.b ? b : a));
  const s = buildSeason({
    index: idx,
    plantingIso: "2026-05-01",
    gduToSilk: longest.s,
    gduToBlackLayer: longest.b,
    lastKnownIso: "2026-05-01",
    lastObservedIso: "2026-05-01",
  });
  const normal = s.rows.find((r) => r.key === "normal");
  assert.ok(normal.silkOffset !== null, `${longest.v} never silks`);
  assert.ok(normal.blackLayerOffset !== null, `${longest.v} (${longest.b} GDU) never black layers in ${SEASON_DAYS} days`);
});

// ---------------------------------------------------------------
console.log("\nstages.js");
// ---------------------------------------------------------------

test("the published ladder is strictly increasing and spans planting to maturity", () => {
  assert.equal(STAGE_LADDER[0].referenceGdu, 0);
  assert.equal(STAGE_LADDER[STAGE_LADDER.length - 1].referenceGdu, REFERENCE_BLACK_LAYER);
  for (let i = 1; i < STAGE_LADDER.length; i++) {
    assert.ok(STAGE_LADDER[i].referenceGdu > STAGE_LADDER[i - 1].referenceGdu, `ladder not increasing at ${STAGE_LADDER[i].key}`);
  }
});

test("the six directly-published values are the ones NOT marked interpolated", () => {
  // If someone edits a number, this catches a published value quietly
  // becoming a guess (or vice versa).
  const published = Object.fromEntries(STAGE_LADDER.filter((s) => !s.interpolated).map((s) => [s.key, s.referenceGdu]));
  assert.deepEqual(published, { planting: 0, v2: 200, v6: 475, v12: 870, v16: 1135, silk: 1400, maturity: 2700 });
});

test("rescaling lands exactly on the hybrid's own silk and black layer", () => {
  // The whole point: whatever else is estimated, these three are the
  // grower's numbers and must come back unchanged.
  for (const [silk, bl] of [[970, 1850], [1290, 2620], [1394, 2773], [1329, 2592]]) {
    const stages = stagesForHybrid(silk, bl);
    assert.equal(stages.find((s) => s.key === "planting").gdu, 0);
    assert.equal(stages.find((s) => s.key === "silk").gdu, silk, `silk anchor for ${silk}/${bl}`);
    assert.equal(stages.find((s) => s.key === "maturity").gdu, bl, `maturity anchor for ${silk}/${bl}`);
  }
});

test("rescaling is the identity for the reference hybrid", () => {
  const stages = stagesForHybrid(REFERENCE_SILK, REFERENCE_BLACK_LAYER);
  for (const stage of stages) {
    assert.equal(stage.gdu, STAGE_LADDER.find((s) => s.key === stage.key).referenceGdu, `drift at ${stage.key}`);
  }
});

test("rescaled ladders stay strictly increasing for every catalog hybrid", () => {
  // A short-season hybrid compresses the vegetative half hard; rounding
  // must never collapse two stages onto the same GDU or invert them.
  for (const row of catalogDoc.hybrids) {
    const stages = stagesForHybrid(row.s, row.b);
    for (let i = 1; i < stages.length; i++) {
      assert.ok(stages[i].gdu > stages[i - 1].gdu, `${row.v}: ${stages[i - 1].key}=${stages[i - 1].gdu} then ${stages[i].key}=${stages[i].gdu}`);
    }
  }
});

test("exactly three stages are marked as anchored to grower data", () => {
  const anchored = stagesForHybrid(1290, 2620).filter((s) => s.anchored).map((s) => s.key);
  assert.deepEqual(anchored, ["planting", "silk", "maturity"]);
});

test("stage dates agree with the accumulation curve they came from", () => {
  // 18 GDU/day flat. Silk 1250 -> ceil(1250/18) = 70 -> offset 69.
  // The stage view and the Predicted Stage Dates table read the same
  // curve, so they must never disagree about silking.
  const time = allDays("1995-01-01", "2027-06-30");
  const idx = buildDailyIndex([{ time, tmax: time.map(() => 86), tmin: time.map(() => 50), source: "observed" }]);
  const s = buildSeason({
    index: idx,
    plantingIso: "2026-05-01",
    gduToSilk: 1250,
    gduToBlackLayer: 2650,
    lastKnownIso: time[time.length - 1],
    lastObservedIso: time[time.length - 1],
  });
  const normalScenario = s.scenarios.find((x) => x.key === "normal");
  const dated = datedStages(stagesForHybrid(1250, 2650), normalScenario.cum, "2026-05-01", normalScenario.solidThroughOffset, { offsetAtTarget, addDays });
  const tableRow = s.rows.find((r) => r.key === "normal");
  assert.equal(dated.find((x) => x.key === "silk").iso, tableRow.silkIso);
  assert.equal(dated.find((x) => x.key === "maturity").iso, tableRow.blackLayerIso);
  assert.equal(dated.find((x) => x.key === "planting").iso, "2026-05-01");
});

test("stage dates are non-decreasing down the ladder", () => {
  const time = allDays("1995-01-01", "2027-06-30");
  const idx = buildDailyIndex([{ time, tmax: time.map(() => 80), tmin: time.map(() => 52), source: "observed" }]);
  const s = buildSeason({
    index: idx,
    plantingIso: "2026-05-01",
    gduToSilk: 1290,
    gduToBlackLayer: 2620,
    lastKnownIso: time[time.length - 1],
    lastObservedIso: time[time.length - 1],
  });
  const sc = s.scenarios.find((x) => x.key === "normal");
  const dated = datedStages(stagesForHybrid(1290, 2620), sc.cum, "2026-05-01", sc.solidThroughOffset, { offsetAtTarget, addDays });
  for (let i = 1; i < dated.length; i++) {
    assert.ok(dated[i].iso >= dated[i - 1].iso, `${dated[i].key} (${dated[i].iso}) before ${dated[i - 1].key} (${dated[i - 1].iso})`);
  }
});

test("a stage the curve never reaches gets no date rather than a guess", () => {
  const stages = stagesForHybrid(1290, 2620);
  const dated = datedStages(stages, [10, 20, 30], "2026-05-01", 2, { offsetAtTarget, addDays });
  assert.equal(dated.find((x) => x.key === "maturity").iso, null);
  assert.equal(dated.find((x) => x.key === "planting").iso, "2026-05-01");
});

// ---------------------------------------------------------------
console.log("\nhybridEstimate.js");
// ---------------------------------------------------------------

test("both numbers entered are passed through untouched", () => {
  const r = resolveHybrid({ gduToSilk: 1290, gduToBlackLayer: 2620 });
  assert.equal(r.ok, true);
  assert.equal(r.silk.value, 1290);
  assert.equal(r.blackLayer.value, 2620);
  assert.equal(r.silk.source, "entered");
  assert.equal(r.blackLayer.source, "entered");
  assert.equal(r.anyEstimated, false);
});

test("silk alone estimates black layer, and vice versa", () => {
  const a = resolveHybrid({ gduToSilk: 1290 });
  assert.equal(a.ok, true);
  assert.equal(a.silk.source, "entered");
  assert.equal(a.blackLayer.source, "fromSilk");
  assert.equal(a.blackLayer.value, Math.round(MODELS.blFromSilk.slope * 1290 + MODELS.blFromSilk.intercept));

  const b = resolveHybrid({ gduToBlackLayer: 2620 });
  assert.equal(b.ok, true);
  assert.equal(b.blackLayer.source, "entered");
  assert.equal(b.silk.source, "fromBlackLayer");
  assert.equal(b.silk.value, Math.round(MODELS.silkFromBl.slope * 2620 + MODELS.silkFromBl.intercept));
});

test("RM alone estimates both", () => {
  const r = resolveHybrid({ rm: 105 });
  assert.equal(r.ok, true);
  assert.equal(r.silk.source, "fromRm");
  assert.equal(r.blackLayer.source, "fromRm");
  assert.equal(r.anyEstimated, true);
  assert.equal(r.rm, 105);
});

test("a real GDU number always outranks RM as the basis", () => {
  // This is the core rule: a paired GDU rating is specific to THIS
  // hybrid, RM only places it in a maturity band. Leave-one-out error
  // backs it up (40 vs 45 GDU for black layer, 19 vs 24 for silk).
  const withBoth = resolveHybrid({ gduToSilk: 1290, rm: 105 });
  assert.equal(withBoth.blackLayer.source, "fromSilk", "should prefer silk over RM");
  const withBl = resolveHybrid({ gduToBlackLayer: 2620, rm: 105 });
  assert.equal(withBl.silk.source, "fromBlackLayer", "should prefer black layer over RM");
});

test("nothing at all is rejected with an actionable message", () => {
  const r = resolveHybrid({});
  assert.equal(r.ok, false);
  assert.match(r.error, /any one of the three/i);
});

test("an entered pair in the wrong order is still rejected", () => {
  // Both values in range, but reversed — so this exercises the ordering
  // guard rather than the range guard (2,900 silk would trip the range
  // check first and never reach it).
  const r = resolveHybrid({ gduToSilk: 2100, gduToBlackLayer: 1500 });
  assert.equal(r.ok, false);
  assert.match(r.error, /lower than/i);
});

test("out-of-range inputs are called out as typos, not silently estimated from", () => {
  assert.equal(resolveHybrid({ gduToSilk: 50 }).ok, false);
  assert.equal(resolveHybrid({ gduToBlackLayer: 99999 }).ok, false);
  assert.equal(resolveHybrid({ rm: 5 }).ok, false);
  assert.equal(resolveHybrid({ rm: 400 }).ok, false);
});

test("an estimate is never returned outside the range the app calls real", () => {
  // The contract is NOT "every legal input produces an answer" — that was
  // the old assertion, and it was satisfied by returning silk 400 -> black
  // layer 488, a number the same function rejects as a typo when it is
  // typed in. The contract is: whatever comes back ok is ordered, inside
  // the hard bounds, and has room for grain fill. Anything else is
  // refused with a message rather than estimated.
  const check = (input, label) => {
    const r = resolveHybrid(input);
    if (!r.ok) {
      assert.ok(typeof r.error === "string" && r.error.length > 0, `${label}: rejected with no message`);
      return;
    }
    assert.ok(r.silk.value < r.blackLayer.value, `${label}: silk ${r.silk.value} >= BL ${r.blackLayer.value}`);
    assert.ok(r.silk.value >= SILK_MIN && r.silk.value <= SILK_MAX, `${label}: silk ${r.silk.value} out of bounds`);
    assert.ok(r.blackLayer.value >= BL_MIN && r.blackLayer.value <= BL_MAX, `${label}: BL ${r.blackLayer.value} out of bounds`);
    assert.ok(r.blackLayer.value - r.silk.value >= MIN_SILK_TO_BL_SPAN, `${label}: span too small`);
  };
  for (let rm = 60; rm <= 135; rm++) check({ rm }, `RM ${rm}`);
  for (let silk = 400; silk <= 2200; silk += 25) check({ gduToSilk: silk }, `silk ${silk}`);
  for (let bl = 900; bl <= 4000; bl += 50) check({ gduToBlackLayer: bl }, `BL ${bl}`);
});

test("every RM in the accepted range still produces an answer", () => {
  // RM is the fallback path with no other information to fall back to, so
  // unlike the GDU paths it has to work everywhere the input validator
  // lets a number through.
  for (let rm = RM_MIN; rm <= RM_MAX; rm++) {
    assert.equal(resolveHybrid({ rm }).ok, true, `RM ${rm} rejected`);
  }
});

test("an extreme-but-legal GDU entry is refused, not extrapolated into nonsense", () => {
  // silk 400 is inside SILK_MIN, so the entry itself is accepted. The
  // black layer it implies (488) is not, and used to be handed back with
  // a "typically within ±46 GDU" note attached.
  const low = resolveHybrid({ gduToSilk: 400 });
  assert.equal(low.ok, false);
  assert.match(low.error, /outside anything real/);

  const high = resolveHybrid({ gduToSilk: 2200 });
  assert.equal(high.ok, false);

  // The edges of what still works, so a future refit that moves them
  // shows up here rather than in the field.
  assert.equal(resolveHybrid({ gduToSilk: 575 }).ok, true);
  assert.equal(resolveHybrid({ gduToSilk: 550 }).ok, false);
  assert.equal(resolveHybrid({ gduToSilk: 1875 }).ok, true);
  assert.equal(resolveHybrid({ gduToSilk: 1900 }).ok, false);
});

test("a silk and black layer too close together is refused, not collapsed", () => {
  // stages.js spaces every reproductive stage between these two numbers.
  // A 4 GDU gap put blister, dough, dent and maturity on one calendar day.
  const tight = resolveHybrid({ gduToSilk: 1400, gduToBlackLayer: 1404 });
  assert.equal(tight.ok, false);
  assert.match(tight.error, /no room for grain fill/);

  // The narrowest real span in the built-in list is 850, so nothing that
  // actually ships is anywhere near the 200 threshold.
  assert.equal(resolveHybrid({ gduToSilk: 1400, gduToBlackLayer: 1600 }).ok, true);
  assert.equal(resolveHybrid({ gduToSilk: 1400, gduToBlackLayer: 1599 }).ok, false);
});

test("extrapolation past the fitted RM range is flagged", () => {
  assert.equal(resolveHybrid({ rm: 105 }).rmOutsideFit, false);
  assert.equal(resolveHybrid({ rm: RM_FITTED_MIN }).rmOutsideFit, false);
  assert.equal(resolveHybrid({ rm: RM_FITTED_MAX }).rmOutsideFit, false);
  assert.equal(resolveHybrid({ rm: RM_FITTED_MIN - 1 }).rmOutsideFit, true);
  assert.equal(resolveHybrid({ rm: RM_FITTED_MAX + 1 }).rmOutsideFit, true);
});

test("the shipped models reproduce the quoted accuracy on the real catalog", () => {
  // Guards against a coefficient being edited to something plausible but
  // wrong. Each model is scored against all 72 hybrids; the median error
  // must land at or under what the app tells users it is.
  const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const cases = [
    ["silkFromRm", (h) => resolveHybrid({ rm: h.rm }).silk.value, (h) => h.s],
    ["blFromRm", (h) => resolveHybrid({ rm: h.rm }).blackLayer.value, (h) => h.b],
    ["blFromSilk", (h) => resolveHybrid({ gduToSilk: h.s }).blackLayer.value, (h) => h.b],
    ["silkFromBl", (h) => resolveHybrid({ gduToBlackLayer: h.b }).silk.value, (h) => h.s],
  ];
  for (const [key, predict, actual] of cases) {
    const errs = catalogDoc.hybrids.map((h) => Math.abs(predict(h) - actual(h)));
    const med = median(errs);
    // In-sample median must not EXCEED the quoted leave-one-out median —
    // if it does, either the coefficients or the quoted figure is wrong.
    assert.ok(med <= MODELS[key].medianErr, `${key}: in-sample median ${med} > quoted ${MODELS[key].medianErr}`);
  }
});

test("the RM outlier the app flags is still the only one in the list", () => {
  // 89-58 SSPRORIB survived the 72 -> 134 -> 132 refreshes. If a data refresh ever
  // introduces another, this fails and someone looks at it rather than
  // the app quietly flagging two hybrids nobody reviewed.
  //
  // This drives rmOutlierNote itself rather than a copy of its rule. The
  // copy that used to live here missed the rebadge dedupe, the two-sided
  // window and the silk check entirely, so it could have kept passing
  // while the shipped function did something different.
  const list = catalogDoc.hybrids.map((r) => ({ variety: r.v, rm: r.rm, gduToSilk: r.s, gduToBlackLayer: r.b }));
  const flagged = list.filter((hy) => rmOutlierNote(hy, list) !== null);
  assert.deepEqual(flagged.map((x) => x.variety), ["89-58 SSPRORIB"]);
  // And it is flagged on black layer, which is the number that is off.
  assert.match(rmOutlierNote(flagged[0], list), /GDU to black layer/);
});

test("the outlier check does not fire just for sitting at the end of the list", () => {
  // A one-sided window makes the median "everything longer than me", so
  // the shortest hybrid gets flagged for being short. Three neighbours
  // all above it used to be enough to trigger that.
  const list = [
    { variety: "shortest", rm: 80, gduToSilk: 1000, gduToBlackLayer: 1800 },
    { variety: "a", rm: 81, gduToSilk: 1100, gduToBlackLayer: 2100 },
    { variety: "b", rm: 82, gduToSilk: 1120, gduToBlackLayer: 2150 },
    { variety: "c", rm: 82, gduToSilk: 1130, gduToBlackLayer: 2200 },
  ];
  assert.equal(rmOutlierNote(list[0], list), null);
});

test("rebadges of one hybrid do not vote as three separate opinions", () => {
  // Same genetics, three trait suffixes, identical numbers. They cleared
  // the "at least three neighbours" bar on their own and pulled the
  // median onto their shared value.
  const twin = { rm: 90, gduToSilk: 1200, gduToBlackLayer: 2200 };
  const list = [
    { variety: "target", rm: 90, gduToSilk: 1200, gduToBlackLayer: 2600 },
    { variety: "twin RIB", ...twin },
    { variety: "twin PCE", ...twin },
    { variety: "twin CONV", ...twin },
  ];
  // Three copies of one hybrid, all on the same side — not a comparison.
  assert.equal(rmOutlierNote(list[0], list), null);
});

test("a silk rating far off its maturity is flagged too", () => {
  // Silk drives every vegetative stage date, and used to go unchecked.
  const list = [
    { variety: "target", rm: 95, gduToSilk: 1600, gduToBlackLayer: 2400 },
    { variety: "a", rm: 94, gduToSilk: 1240, gduToBlackLayer: 2380 },
    { variety: "b", rm: 95, gduToSilk: 1250, gduToBlackLayer: 2400 },
    { variety: "c", rm: 96, gduToSilk: 1260, gduToBlackLayer: 2420 },
  ];
  assert.match(rmOutlierNote(list[0], list), /GDU to silk/);
});

test("every catalog hybrid can be recovered from its RM alone within a sane bound", () => {
  // Not a precision claim — a guard that the fit is not wildly off for
  // any real hybrid, which would mean a broken coefficient.
  for (const hy of catalogDoc.hybrids) {
    const r = resolveHybrid({ rm: hy.rm });
    assert.ok(Math.abs(r.silk.value - hy.s) <= MODELS.silkFromRm.maxErr, `${hy.v} silk off by ${Math.abs(r.silk.value - hy.s)}`);
    assert.ok(Math.abs(r.blackLayer.value - hy.b) <= MODELS.blFromRm.maxErr, `${hy.v} BL off by ${Math.abs(r.blackLayer.value - hy.b)}`);
  }
});

test("an RM-only hybrid still produces a complete, ordered stage ladder", () => {
  const r = resolveHybrid({ rm: 100 });
  const stages = stagesForHybrid(r.silk.value, r.blackLayer.value);
  for (let i = 1; i < stages.length; i++) {
    assert.ok(stages[i].gdu > stages[i - 1].gdu, `ladder broke at ${stages[i].key}`);
  }
  assert.equal(stages.find((x) => x.key === "silk").gdu, r.silk.value);
  assert.equal(stages.find((x) => x.key === "maturity").gdu, r.blackLayer.value);
});

// ---------------------------------------------------------------
console.log("\nfrost verdict");
// ---------------------------------------------------------------

/**
 * A season stub carrying only what frostVerdict reads. Built by hand
 * rather than from buildSeason because the point is to drive every
 * branch, and manufacturing weather that lands black layer exactly N
 * days either side of a freeze date is a fixture about the weather.
 */
function verdictSeason({ blackLayerIso, p10, median }) {
  return {
    plantingYear: 2026,
    killingFreeze: { p10MonthDay: p10, medianMonthDay: median, yearsUsed: 30, yearsFroze: median ? 29 : 8 },
    rows: [
      { key: "current-normal", blackLayerIso },
      { key: "current-hot", blackLayerIso },
      { key: "current-cool", blackLayerIso },
    ],
  };
}
const VERDICT_HYBRID = { gduToBlackLayer: 2650 };

test("a comfortable margin reads as comfortable and quotes both dates", () => {
  // Black layer Sep 20, 1-in-10 freeze Oct 10 -> 20 days; median Oct 24 -> 34.
  const v = frostVerdict(verdictSeason({ blackLayerIso: "2026-09-20", p10: "10-10", median: "10-24" }), VERDICT_HYBRID);
  assert.equal(v.tone, "good");
  assert.ok(v.text.startsWith("20 days of margin"), v.text);
  assert.ok(v.text.includes("34 against the median"), v.text);
});

test("a thin margin is called tight, not comfortable", () => {
  const v = frostVerdict(verdictSeason({ blackLayerIso: "2026-10-05", p10: "10-10", median: "10-24" }), VERDICT_HYBRID);
  assert.equal(v.tone, "warn");
  assert.ok(v.text.startsWith("Only 5 days of margin"), v.text);
});

test("nine days is tight and ten is comfortable — the boundary, pinned", () => {
  assert.equal(frostVerdict(verdictSeason({ blackLayerIso: "2026-10-01", p10: "10-10", median: "10-24" }), VERDICT_HYBRID).tone, "warn");
  assert.equal(frostVerdict(verdictSeason({ blackLayerIso: "2026-09-30", p10: "10-10", median: "10-24" }), VERDICT_HYBRID).tone, "good");
});

test("black layer past the 1-in-10 freeze is a bad verdict with a positive day count", () => {
  const v = frostVerdict(verdictSeason({ blackLayerIso: "2026-10-20", p10: "10-10", median: "10-24" }), VERDICT_HYBRID);
  assert.equal(v.tone, "bad");
  assert.ok(v.text.includes("caught 10 days short of black layer"), v.text);
  assert.ok(v.text.includes("Against the median freeze it has 4 days"), v.text);
});

test("black layer past the MEDIAN freeze never prints a negative day count", () => {
  // The old wording did the subtraction unconditionally and rendered
  // "Against the median freeze it has -13 days", which is not a sentence.
  const v = frostVerdict(verdictSeason({ blackLayerIso: "2026-11-06", p10: "10-10", median: "10-24" }), VERDICT_HYBRID);
  assert.equal(v.tone, "bad");
  // A leading minus is always preceded by a space; "1-year-in-10" is not.
  assert.ok(!/\s-\d/.test(v.text), `negative day count leaked: ${v.text}`);
  assert.ok(v.text.includes("Even against the median freeze it is 13 days short"), v.text);
});

test("a censored median is a clause, not a fragment after a full stop", () => {
  // "…short of black layer. and the median year never freezes at all."
  const bad = frostVerdict(verdictSeason({ blackLayerIso: "2026-10-20", p10: "10-10", median: null }), VERDICT_HYBRID);
  assert.equal(bad.tone, "bad");
  assert.ok(!/\. [a-z]/.test(bad.text), `lowercase fragment after a full stop: ${bad.text}`);
  assert.ok(bad.text.includes("In the median year there is no killing freeze at all"), bad.text);

  const good = frostVerdict(verdictSeason({ blackLayerIso: "2026-09-01", p10: "10-10", median: null }), VERDICT_HYBRID);
  assert.equal(good.tone, "good");
  assert.ok(good.text.includes("and no killing freeze at all in the median year"), good.text);
});

test("a hybrid that never reaches black layer is called too long, not scored", () => {
  const season = verdictSeason({ blackLayerIso: null, p10: "10-10", median: "10-24" });
  const v = frostVerdict(season, VERDICT_HYBRID);
  assert.equal(v.tone, "bad");
  assert.ok(v.text.includes("doesn't reach black layer at all"), v.text);
  assert.ok(v.text.includes("2,650 GDU"), v.text);
});

test("the verdict is scored on the LATEST finish, not the average one", () => {
  // The risk question is "could this fail", so the cool finish decides.
  const season = verdictSeason({ blackLayerIso: "2026-09-20", p10: "10-10", median: "10-24" });
  season.rows[2].blackLayerIso = "2026-10-15"; // cool finish, past the p10
  assert.equal(frostVerdict(season, VERDICT_HYBRID).tone, "bad");
});

test("nothing to score against returns null rather than a sentence", () => {
  assert.equal(frostVerdict(verdictSeason({ blackLayerIso: "2026-09-20", p10: "10-10", median: "10-24" }), null), null);
  assert.equal(frostVerdict(verdictSeason({ blackLayerIso: "2026-09-20", p10: null, median: null }), VERDICT_HYBRID), null);
  assert.equal(frostVerdict(null, VERDICT_HYBRID), null);
});

// ---------------------------------------------------------------
console.log("\nshared frost and provenance wording");
// ---------------------------------------------------------------

test("an unreadable record is reported as a data problem, not as a finding", () => {
  // Every year holed before its first freeze. Saying "no freeze appears
  // in this location's 30-year record" here asserts a finding from a
  // record that could not be read.
  const t = noFreezeText({ yearsUsed: 0, yearsFroze: 0, yearsSkipped: 30 });
  assert.match(t, /data problem, not a finding/);
  assert.ok(!/No 28 °F freeze appears/.test(t), t);
});

test("a genuinely frost-free location says so, and a nearly-frost-free one does not", () => {
  assert.match(noFreezeText({ yearsUsed: 30, yearsFroze: 0 }), /No 28 °F freeze appears in this location's 30-year record/);
  const few = noFreezeText({ yearsUsed: 30, yearsFroze: 2 });
  assert.match(few, /Only 2 of the last 30 years/);
  assert.ok(!/No 28 °F freeze appears/.test(few), few);
});

test("the freeze coverage note fires below 90% and stays quiet above it", () => {
  assert.equal(freezeCoverageNote({ yearsUsed: 30, yearsFroze: 27 }), ""); // exactly 90%
  assert.match(freezeCoverageNote({ yearsUsed: 30, yearsFroze: 26 }), /^26 of 30 years reached 28 °F/);
  assert.match(freezeCoverageNote({ yearsUsed: 28, yearsFroze: 22, yearsSkipped: 2 }), /\(2 more had gaps and were left out\)/);
  // Zero froze is the no-freeze case, which has its own wording.
  assert.equal(freezeCoverageNote({ yearsUsed: 30, yearsFroze: 0 }), "");
  assert.equal(freezeCoverageNote(null), "");
});

test("the chart caption always names the solid line when there is one", () => {
  const fs2 = (iso) => (iso ? iso.slice(5) : "—");
  const base = { seasonDays: 220, lastObservedIso: "2026-08-06", lastKnownIso: "2026-08-21" };
  // Observed then forecast.
  assert.match(solidCaption({ ...base, observedEndOffset: 97, knownEndOffset: 112 }, fs2), /observed through 08-06 plus forecast through 08-21/);
  // Forecast only — a planting date a few days out.
  assert.match(solidCaption({ ...base, observedEndOffset: -1, knownEndOffset: 12, lastObservedIso: null }, fs2), /^Solid = forecast through 08-21/);
  // Observed only. This branch used to return a bare "Dashed = projected."
  // and say nothing about the solid line at all — which is every past
  // season, every failed forecast fetch and every gap-truncated run.
  const obsOnly = solidCaption({ ...base, observedEndOffset: 97, knownEndOffset: 97 }, fs2);
  assert.match(obsOnly, /Solid = observed through 08-06/);
  // A season entirely on the books has nothing dashed to describe.
  const whole = solidCaption({ ...base, observedEndOffset: 219, knownEndOffset: 219 }, fs2);
  assert.ok(!/Dashed/.test(whole), whole);
  // Nothing known at all.
  assert.equal(solidCaption({ ...base, observedEndOffset: -1, knownEndOffset: -1 }, fs2), "Dashed = projected.");
});

test('"entirely on the books" is only said when the whole season is known', () => {
  // Honours the options argument, so `{ withYear: true }` is actually
  // pinned. A fake that ignored it left that call free to be dropped.
  const fs2 = (iso, opts) => (iso ? (opts && opts.withYear ? iso : iso.slice(5)) : "—");
  const base = { seasonDays: 220, lastObservedIso: "2026-08-06", lastKnownIso: "2026-08-06", requestedObservedIso: "2026-08-06", requestedKnownIso: "2026-08-21" };
  // Mid-season with no forecast — a failed fetch or a truncating gap.
  // This used to announce a completed season one bullet above the bullet
  // reporting the forecast failure.
  const midSeason = temperatureProvenance({ ...base, observedEndOffset: 97, knownEndOffset: 97 }, fs2);
  assert.ok(!/on the books/.test(midSeason), midSeason);
  assert.match(midSeason, /No forecast is included in this run/);
  // The date it names carries the year — a bare "Aug 6" on a card that
  // may be describing a 2024 season is not enough.
  assert.match(midSeason, /through 2026-08-06/);
  // A season that really is complete.
  assert.match(temperatureProvenance({ ...base, observedEndOffset: 219, knownEndOffset: 219 }, fs2), /entirely on the books/);
  // The ordinary in-season case names the download horizon.
  const inSeason = temperatureProvenance({ ...base, observedEndOffset: 97, knownEndOffset: 112 }, fs2);
  assert.match(inSeason, /16-day forecast through 08-21/);
  assert.match(inSeason, /current season through 2026-08-06/);
});

test("a gap and a thin baseline are reported on every surface, not just the screen", () => {
  // Both of these used to be screen-only, so the PDF a grower keeps and
  // the text a rep forwards were the two surfaces with no caveat on them.
  const clean = { truncatedByGap: false, remainingYearsUsed: new Array(30), yearsUsed: new Array(30), currentStage: {}, lastKnownIso: "2026-08-06" };
  assert.equal(recordQualityNote(clean, 30), "");

  const gapped = { ...clean, truncatedByGap: true };
  assert.match(recordQualityNote(gapped, 30), /gap partway through this season/);

  // A hole on the planting day leaves no total at all, and says so
  // differently.
  assert.match(recordQualityNote({ ...gapped, lastKnownIso: null }, 30), /gap starting on the planting date/);

  const thin = { ...clean, remainingYearsUsed: new Array(8), yearsUsed: new Array(6) };
  const t = recordQualityNote(thin, 30);
  assert.match(t, /whole-season rows come from 6 complete years, not 30/);
  assert.match(t, /hot and cool finishes come from 8 years/);

  // Both at once read as one sentence, not two glued together.
  const both = recordQualityNote({ ...thin, truncatedByGap: true }, 30);
  assert.match(both, /^Data quality: the weather record has a gap.*; the baseline is thin — /);
  assert.ok(!/\.\s*\./.test(both), both);
});

test("the thin-baseline clause carries no lead-in of its own", () => {
  // The screen says "Thin baseline for this location — <clause>" and the
  // PDF says "Data quality: the baseline is thin — <clause>". Returning
  // the bare clause is what lets both do that without one of them
  // regex-stripping the other's wording, which is what the first version
  // did.
  const t = thinBaselineText({ remainingYearsUsed: new Array(8), yearsUsed: new Array(30), currentStage: {} }, 30);
  assert.ok(!/^the baseline is thin/.test(t), t);
  // Standalone, with no whole-season clause in front to lend it a noun.
  assert.ok(!/come from \d+,/.test(t), `dangling numeral: ${t}`);
  assert.match(t, /^the hot and cool finishes come from 8 years/);
  assert.equal(thinBaselineText({ remainingYearsUsed: new Array(30), yearsUsed: new Array(30), currentStage: {} }, 30), "");
});

// ---------------------------------------------------------------
console.log("\nshared summary text");
// ---------------------------------------------------------------

/** A real season a rep might share, built from flat 18-GDU days. */
function shareableSeason(killingFreeze) {
  const time = allDays("1995-01-01", "2026-08-06");
  const idx = buildDailyIndex([{ time, tmax: time.map(() => 86), tmin: time.map(() => 50), source: "observed" }]);
  const s = buildSeason({
    index: idx,
    plantingIso: "2026-05-01",
    gduToSilk: 1250,
    gduToBlackLayer: 2650,
    lastKnownIso: "2026-08-06",
    lastObservedIso: "2026-08-06",
  });
  if (killingFreeze) s.killingFreeze = killingFreeze;
  return s;
}

const SHARE_HYBRID = {
  label: "09-90 PCE",
  gduToSilk: 1250,
  gduToBlackLayer: 2650,
  rm: 99,
  silk: { value: 1250, source: "entered", model: null },
  blackLayer: { value: 2650, source: "entered", model: null },
};

test("the shared text collapses this season into one line per stage", () => {
  // season.rows carries three current-* rows that share every observed
  // and forecast day, so their dates are frequently identical. The screen
  // and the PDF collapse them; the share text printed all three, which is
  // exactly the "looks like a bug in the app" presentation the collapse
  // exists to avoid.
  const season = shareableSeason();
  const text = buildSummary({
    season,
    hybrid: SHARE_HYBRID,
    location: { label: "Missouri Valley, IA" },
    rows: season.rows.filter((r) => !r.key.startsWith("current-")),
  });
  assert.ok(!text.includes("normal finish"), "the three collapsed rows must not appear");
  assert.ok(!text.includes("hot finish"));
  assert.ok(!text.includes("cool finish"));
  assert.ok(text.includes("This season:"));
  assert.match(text, /silk .*\(reached\)/);
});

test("a censored median never leaves a phrase where the text expects a date", () => {
  // "Median first 28 °F freeze no freeze in over half of years" was going
  // out in the body of a message a rep sends a grower.
  const text = buildSummary({
    season: shareableSeason({ medianMonthDay: null, p10MonthDay: "10-03", earliestMonthDay: "09-30", yearsUsed: 30, yearsFroze: 6, yearsSkipped: 0 }),
    hybrid: SHARE_HYBRID,
    location: { label: "Missouri Valley, IA" },
    rows: [],
  });
  assert.ok(!/Median first 28 °F freeze [a-z]/.test(text), `phrase substituted into a date slot: ${text}`);
  assert.ok(text.includes("1 year in 10 sees 28 °F by Oct 3"));
  assert.ok(text.includes("no median freeze date"));

  // And the ordinary case still reads as it always did.
  const normal = buildSummary({
    season: shareableSeason({ medianMonthDay: "10-22", p10MonthDay: "10-03", earliestMonthDay: "09-30", yearsUsed: 30, yearsFroze: 29, yearsSkipped: 0 }),
    hybrid: SHARE_HYBRID,
    location: { label: "Missouri Valley, IA" },
    rows: [],
  });
  assert.ok(normal.includes("Median first 28 °F freeze Oct 22"));
});

// ---------------------------------------------------------------
console.log("\nservice worker precache");
// ---------------------------------------------------------------

test("every shipped JS module is in the service worker's precache list", () => {
  // The shell is cache-first, so a module missing from this list 404s on
  // a cold offline load and the app fails to boot with no useful error.
  // v3.5 added core/frostVerdict.js and very nearly shipped without the
  // entry — nothing in the online test suite can see the difference.
  const sw = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const listed = new Set(sw.match(/"\/js\/[^"]+\.js"/g).map((s) => s.slice(1, -1)));

  const onDisk = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}${entry.name}/`, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".js")) onDisk.push(`${prefix}${entry.name}`);
    }
  };
  walk("../public/js/", "/js/");

  const missing = onDisk.filter((p) => !listed.has(p));
  assert.deepEqual(missing, [], `not precached: ${missing.join(", ")}`);

  // And the reverse: an entry for a file that no longer exists makes
  // addAll() reject, which fails the whole install and leaves the app
  // with no cache at all rather than a partial one.
  const stale = [...listed].filter((p) => !onDisk.includes(p));
  assert.deepEqual(stale, [], `precached but absent: ${stale.join(", ")}`);
});

test("the app version and the cache version agree", () => {
  const app = fs.readFileSync(new URL("../public/js/version.js", import.meta.url), "utf8");
  const sw = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const appV = /APP_VERSION = "v([\d.]+)/.exec(app);
  const swV = /CACHE_VERSION = "v([\d.]+)/.exec(sw);
  assert.ok(appV && swV, "both version strings must be findable");
  // They are two different formats on purpose ("v3.5 (Beta)" vs
  // "v3.5-beta"), but the number has to match or a release ships new code
  // under the old cache key and nobody gets the update.
  assert.equal(appV[1], swV[1]);
});

// ---------------------------------------------------------------
console.log("\ncatalog naming rules");
// ---------------------------------------------------------------

test("no bare-TRE varieties remain, and every TRERIB one does", () => {
  // The bare-TRE rows were exact duplicates of their TRERIB counterparts
  // (identical RM, silk and black layer), so they inflated the estimator
  // fit by double-weighting two hybrids while adding nothing a user
  // could pick between.
  assert.deepEqual(catalogDoc.hybrids.filter((x) => /\sTRE$/.test(x.v)).map((x) => x.v), []);
  assert.equal(catalogDoc.hybrids.filter((x) => /TRERIB$/.test(x.v)).length, 6);
});

test("trait suffixes are upper case throughout", () => {
  // "13-22 Conv" sorted and read as a different trait from "CONV".
  const suffixes = new Set(catalogDoc.hybrids.map((x) => x.v.split(" ").slice(1).join(" ")));
  for (const suf of suffixes) {
    assert.equal(suf, suf.toUpperCase(), `mixed-case trait suffix: "${suf}"`);
  }
  assert.ok(suffixes.has("CONV"));
  assert.ok(!suffixes.has("Conv"));
});

test("the quoted fit size matches the catalog actually shipped", () => {
  // The accuracy claim printed on four screens and in the PDF is "fitted
  // on N hybrids". After two data refreshes three of those places were
  // still saying 72. This is the mechanical guard: refresh the data
  // without refitting and requoting, and the build fails here.
  assert.equal(FITTED_N, catalogDoc.hybrids.length);
});

test("the catalog is sorted by maturity, then variety", () => {
  const list = catalogDoc.hybrids;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    assert.ok(b.rm > a.rm || (b.rm === a.rm && b.v >= a.v), `out of order at ${b.v} after ${a.v}`);
  }
});

// ---------------------------------------------------------------
console.log("\nthis-season stage summary");
// ---------------------------------------------------------------

// A fixture where every baseline year is IDENTICAL up to Aug 20 and then
// gets its own constant rate, spread 10..30 GDU/day. The remaining-season
// envelope therefore HAS to be wide, so if the three finishes ever
// collapse here it is the splice that is broken, not the weather.
function spreadFixture() {
  const time = [];
  const tmax = [];
  const tmin = [];
  for (let yr = 1996; yr <= 2026; yr++) {
    const rate = 10 + (yr - 1996) * (20 / 29);
    const days = (yr % 4 === 0 && yr % 100 !== 0) || yr % 400 === 0 ? 366 : 365;
    for (let d = 0; d < days; d++) {
      const iso = addDays(`${yr}-01-01`, d);
      const g = iso.slice(5) < "08-21" ? 20 : rate;
      time.push(iso);
      tmax.push(50 + g);
      tmin.push(50 + g);
    }
  }
  const cut = time.indexOf("2026-08-04");
  const slice = (a, from, to) => a.slice(from, to);
  return {
    observed: { time: slice(time, 0, cut + 1), tmax: slice(tmax, 0, cut + 1), tmin: slice(tmin, 0, cut + 1), source: "observed" },
    forecast: { time: slice(time, cut + 1, cut + 17), tmax: slice(tmax, cut + 1, cut + 17), tmin: slice(tmin, cut + 1, cut + 17), source: "forecast" },
  };
}

const spread = spreadFixture();
const spreadSeason = buildSeason({
  index: buildDailyIndex([spread.forecast, spread.observed]),
  plantingIso: "2026-05-01",
  gduToSilk: 1290,
  gduToBlackLayer: 3000,
  lastKnownIso: spread.forecast.time[spread.forecast.time.length - 1],
  lastObservedIso: spread.observed.time[spread.observed.time.length - 1],
});

test("the projection splice actually spreads the three finishes apart", () => {
  // The regression this guards: a splice bug (or a degenerate envelope)
  // would make normal/hot/cool land on one date and look, from the
  // outside, exactly like correct behaviour for a stage already reached.
  const bl = (k) => spreadSeason.rows.find((r) => r.key === `current-${k}`).blackLayerIso;
  assert.ok(bl("hot") < bl("normal"), `hot ${bl("hot")} should beat normal ${bl("normal")}`);
  assert.ok(bl("normal") < bl("cool"), `normal ${bl("normal")} should beat cool ${bl("cool")}`);
  assert.equal(spreadSeason.remainingYearsUsed.length, 30);
});

test("a stage the crop already passed is reported as actual, not predicted", () => {
  // Silking at 1,290 GDU happens in observed data, so all three finishes
  // MUST agree — history has no scenarios. The summary has to say that
  // rather than leave three identical dates looking like a fault.
  const silk = spreadSeason.currentStage.silk;
  assert.equal(silk.basis, "actual");
  assert.equal(silk.spreadDays, 0);
  assert.ok(silk.iso < spreadSeason.lastObservedIso);
});

test("a projected stage carries the hot-to-cool range", () => {
  const bl = spreadSeason.currentStage.blackLayer;
  assert.equal(bl.basis, "projected");
  assert.ok(bl.spreadDays > 0, "a projected date this far out must have a range");
  assert.ok(bl.earliestIso < bl.iso && bl.iso < bl.latestIso);
  assert.equal(bl.reachedInEveryScenario, true);
});

test("a stage inside the 16-day forecast is labelled forecast, not projection", () => {
  // 20 GDU/day flat, so 2,300 GDU lands on day 115 - past the last
  // observed day (95) but inside the forecast horizon (111).
  const s = buildSeason({
    index: buildDailyIndex([spread.forecast, spread.observed]),
    plantingIso: "2026-05-01",
    gduToSilk: 1290,
    gduToBlackLayer: 2220,
    lastKnownIso: spread.forecast.time[spread.forecast.time.length - 1],
    lastObservedIso: spread.observed.time[spread.observed.time.length - 1],
  });
  assert.equal(s.currentStage.blackLayer.basis, "forecast");
  assert.equal(s.currentStage.blackLayer.spreadDays, 0);
});

const buildWithBl = (bl) =>
  buildSeason({
    index: buildDailyIndex([spread.forecast, spread.observed]),
    plantingIso: "2026-05-01",
    gduToSilk: 1290,
    gduToBlackLayer: bl,
    lastKnownIso: spread.forecast.time[spread.forecast.time.length - 1],
    lastObservedIso: spread.observed.time[spread.observed.time.length - 1],
  });

test("a stage a cool finish never reaches reports no range rather than a fake one", () => {
  // 3,990 GDU is reached in a normal and a hot finish but not a cool
  // one. Quoting a range would require inventing the cool end; the
  // summary withholds it and flags the case instead, so the UI can say
  // "not reached in a cool finish" rather than print a tidy interval
  // that quietly drops the worst outcome.
  const bl = buildWithBl(3990).currentStage.blackLayer;
  assert.equal(bl.reachedInEveryScenario, false);
  assert.equal(bl.latestIso, null);
  assert.equal(bl.spreadDays, null);
  assert.ok(bl.iso);
});

test("a stage no scenario reaches is reported as unreached, not as a date", () => {
  assert.equal(buildWithBl(6000).currentStage.blackLayer, null);
});

// ---------------------------------------------------------------
console.log("\nstage-band temperatures");
// ---------------------------------------------------------------

const tempIndex = buildDailyIndex([
  // Forecast first, observed second - later wins (see buildDailyIndex).
  { time: ["2026-05-04", "2026-05-05"], tmax: [200, 200], tmin: [200, 200], source: "forecast" },
  { time: ["2026-05-01", "2026-05-02", "2026-05-03"], tmax: [80, 90, 70], tmin: [60, 64, 50], source: "observed" },
]);

test("the reported pair is the hottest day and the warmest night, not averages", () => {
  const bt = bandTempStats(tempIndex, "2026-05-01", 0, 2, addDays);
  assert.equal(bt.days, 3);
  // Highs 80/90/70, lows 60/64/50.
  assert.equal(bt.maxHigh, 90);
  assert.equal(bt.maxLow, 64);
  // The means are 80 and 58 - both LOWER than the peaks, which is the
  // whole point: a single hot day is what does the damage and an average
  // buries it.
  assert.equal(bt.avgHigh, 80);
  assert.equal(bt.avgLow, 58);
  assert.ok(bt.maxHigh > bt.avgHigh && bt.maxLow > bt.avgLow);
});

test("the warmest night is the max of the lows, not the low of the hottest day", () => {
  // Easy bug: reporting tmin FROM the day with the highest tmax. Here the
  // hottest day (90) has a 64 low and the coolest day (70) has a 50 low,
  // so both readings agree - add a day that separates them.
  const idx = buildDailyIndex([
    { time: ["2026-07-01", "2026-07-02"], tmax: [98, 84], tmin: [61, 77], source: "observed" },
  ]);
  const bt = bandTempStats(idx, "2026-07-01", 0, 1, addDays);
  assert.equal(bt.maxHigh, 98); // day 1's 98, not day 2's 84
  assert.equal(bt.maxLow, 77); // day 2's 77, NOT the 61 that came with the 98
});

test("temperatures are raw, NOT the GDU-clamped ones", () => {
  // 90 F clamps to 86 for GDU purposes. It must not clamp here - this is
  // reporting the weather, not computing development.
  const bt = bandTempStats(tempIndex, "2026-05-02", 0, 0, addDays);
  assert.equal(bt.maxHigh, 90);
});

test("a band containing any forecast day returns nothing at all", () => {
  // May 4-5 are forecast. Averaging the observed part and printing it
  // under a label that claims the whole stage is the failure mode this
  // guards.
  assert.equal(bandTempStats(tempIndex, "2026-05-01", 0, 3, addDays), null);
  assert.equal(bandTempStats(tempIndex, "2026-05-01", 3, 4, addDays), null);
});

test("a band running past the end of the data returns nothing", () => {
  assert.equal(bandTempStats(tempIndex, "2026-05-01", 0, 40, addDays), null);
});

test("a zero-length or reversed band returns nothing", () => {
  assert.equal(bandTempStats(tempIndex, "2026-05-01", 2, 1, addDays), null);
  assert.equal(bandTempStats(tempIndex, "2026-05-01", null, 1, addDays), null);
});

test("a min warmer than the max is still reported as high and low", () => {
  // Defensive, mirroring dailyGdu: a transposed row must not report a
  // low above its high.
  const idx = buildDailyIndex([{ time: ["2026-06-01"], tmax: [55], tmin: [88], source: "observed" }]);
  const bt = bandTempStats(idx, "2026-06-01", 0, 0, addDays);
  assert.equal(bt.maxHigh, 88);
  assert.equal(bt.maxLow, 55);
});

// ---------------------------------------------------------------
console.log("\nBrand View hybrid naming");
// ---------------------------------------------------------------

test("a variety is rendered under the active Brand View's code", () => {
  assert.equal(brandedHybridName("09-90 PCE", BRANDS.ncPlus), "NC 09-90 PCE");
  assert.equal(brandedHybridName("09-90 PCE", BRANDS.midwestSeedGenetics), "MW 09-90 PCE");
  assert.equal(brandedHybridName("09-90 PCE", BRANDS.crows), "CR 09-90 PCE");
});

test("switching Brand View replaces the code instead of stacking it", () => {
  // The bug this prevents: "CR NC MW 09-90 PCE" after three view swaps.
  let name = "09-90 PCE";
  for (const b of [BRANDS.ncPlus, BRANDS.crows, BRANDS.midwestSeedGenetics, BRANDS.ncPlus]) {
    name = brandedHybridName(name, b);
  }
  assert.equal(name, "NC 09-90 PCE");
});

test("re-applying the same brand is a no-op", () => {
  assert.equal(brandedHybridName("NC 09-90 PCE", BRANDS.ncPlus), "NC 09-90 PCE");
});

test("an unrecognized prefix is left alone rather than guessed at", () => {
  // "DKC" and "P" are real competitor prefixes; mangling them would
  // rename somebody else's hybrid.
  assert.equal(brandedHybridName("DKC62-08", null), "DKC62-08");
  assert.equal(brandedHybridName("P1185Q", null), "P1185Q");
  // Two letters that are NOT one of the three codes must survive.
  assert.equal(brandedHybridName("XY 12-34", BRANDS.ncPlus), "NC XY 12-34");
});

test("the catalog still matches a hybrid once it carries a brand code", () => {
  // findByVariety() and search() both go through bareVariety, so a
  // picked hybrid keeps its "From hybrid list" badge after branding.
  assert.equal(bareVariety("NC 09-90 PCE"), "09-90 PCE");
  assert.equal(bareVariety("mw 09-90 pce"), "09-90 pce");
  assert.equal(bareVariety("09-90 PCE"), "09-90 PCE");
  assert.equal(bareVariety("DKC62-08"), "DKC62-08");
  assert.equal(bareVariety("XY 12-34"), "XY 12-34");
});

test("a half-typed brand code searches as nothing, not as the literal letters", () => {
  // search() runs every keystroke. "NC " used to trim to "NC", miss the
  // \s+ in the strip pattern, and be searched as the substring "nc" —
  // which no variety contains, so the picker went blank mid-typing.
  assert.equal(bareVariety("NC "), "");
  assert.equal(bareVariety("NC"), "");
  assert.equal(bareVariety("  MW  "), "");
  assert.equal(bareVariety("cr"), "");
  // A real name that merely starts with those letters is untouched.
  assert.equal(bareVariety("NCX 12"), "NCX 12");
  assert.equal(bareVariety("CRUZ"), "CRUZ");
});

// ---------------------------------------------------------------
console.log("\nheat-cap / cold-floor day classification");
// ---------------------------------------------------------------

// The chart marks a day red when its high reached the 86 F cap and blue
// when its low fell to 50 F or below. Those two thresholds are the
// formula's own limits, so they are pinned here against dailyGdu itself
// rather than against the drawing code.

test("a day at the cap earns strictly less than the thermometer suggests", () => {
  // 86/66 and 104/66 are the same GDU: everything past 86 is discarded.
  // That equality IS the thing the red mark exists to explain.
  assert.equal(dailyGdu(86, 66), dailyGdu(104, 66));
  assert.equal(dailyGdu(86, 66), 26);
});

test("the theoretical maximum needs an 86 F night, which is why it is not the trigger", () => {
  // A strict "maxed out" reading means 36 GDU, which needs the LOW at 86
  // too. That essentially never happens in Iowa, so the marker uses the
  // high hitting the cap instead - documented here so the choice is not
  // mistaken for a bug later.
  assert.equal(dailyGdu(86, 86), GDU_MAX_PER_DAY);
  assert.equal(dailyGdu(98, 70), 28);
  assert.ok(dailyGdu(98, 70) < GDU_MAX_PER_DAY);
});

test("a day at or below the floor earns nothing, never a negative", () => {
  assert.equal(dailyGdu(50, 40), 0);
  assert.equal(dailyGdu(30, 10), 0);
});

test("blue marks a day that stayed under 50 ALL day, not one with a cold night", () => {
  // The distinction that matters: a 72/45 day has a cold night but the
  // crop still developed (11 GDU). Only a day that never rose to the
  // base earned nothing, and only that gets marked.
  assert.equal(dayLimitKind(48, 38), "zero");
  assert.equal(dayLimitKind(50, 38), "zero"); // topping out AT the base still earns 0
  assert.equal(dayLimitKind(72, 45), null);
  assert.equal(dailyGdu(72, 45), 11);
});

test("red marks a day whose high reached the cap", () => {
  assert.equal(dayLimitKind(86, 60), "capped");
  assert.equal(dayLimitKind(104, 72), "capped");
  assert.equal(dayLimitKind(85, 60), null);
});

test("the two marks are mutually exclusive, so no tiebreak is needed", () => {
  // Defining the cold end on the HIGH rather than the low is what buys
  // this: keyed off the minimum, a 90/48 spring day would qualify as
  // both and need a precedence rule nobody would remember.
  for (const [hi, lo] of [[90, 48], [86, 86], [50, 50], [30, 10], [70, 55], [104, 40]]) {
    const kind = dayLimitKind(hi, lo);
    assert.ok(kind === null || kind === "capped" || kind === "zero", `${hi}/${lo} -> ${kind}`);
  }
  assert.equal(dayLimitKind(90, 48), "capped"); // not "zero" as well
});

test("a transposed row is still classified on the real high", () => {
  assert.equal(dayLimitKind(40, 88), "capped");
  assert.equal(dayLimitKind(NaN, 60), null);
});

console.log(`\n${passed} assertions passed.\n`);
