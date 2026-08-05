// Unit tests for the GDU engine. Plain node, no dependencies:
//   node test/unit_gdu.mjs
//
// Every expected value here is hand-worked from the formula in
// gdu.js's header, not captured from a previous run of this code — a
// snapshot test would happily lock in a wrong answer.

import assert from "node:assert/strict";
import fs from "node:fs";
import { dailyGdu, percentile, accumulate, envelopeFromCalendarDate, offsetAtTarget, firstFreezeStats, buildDailyIndex, bandMeanTemps, GDU_MAX_PER_DAY } from "../public/js/core/gdu.js";
import { addDays, daysBetween, isoForYear, isoToUtcMs, utcMsToIso, monthDayOf, formatShort } from "../public/js/core/dates.js";
import { buildSeason, baselineYearsFor, SEASON_DAYS } from "../public/js/core/season.js";
import { STAGE_LADDER, stagesForHybrid, datedStages, REFERENCE_SILK, REFERENCE_BLACK_LAYER } from "../public/js/core/stages.js";
import { resolve as resolveHybrid, MODELS, RM_FITTED_MIN, RM_FITTED_MAX, FITTED_N } from "../public/js/core/hybridEstimate.js";
import { bareVariety } from "../public/js/core/hybridCatalog.js";
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
  // p10 of offsets {61, 65, 69} = 61 + 0.2*(65-61) = 61.8, which rounds
  // to 62 -> Oct 2. Not Oct 1: with only three years the 10th percentile
  // sits between the two earliest, it is not simply the earliest.
  assert.equal(res.p10MonthDay, "10-02");
  assert.equal(res.yearsUsed, 3);
});

test("no freeze in the record reports nothing rather than guessing", () => {
  const idx = flatIndex("2020-07-01", 200, 70, 55);
  const res = firstFreezeStats(idx, [2020], 28, dateFns);
  assert.equal(res.medianMonthDay, null);
  assert.equal(res.yearsUsed, 0);
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
  // hybridPicker.js emits a heading each time RM changes; unsorted data
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

test("estimates always keep silk below black layer across the whole valid range", () => {
  for (let rm = 60; rm <= 135; rm++) {
    const r = resolveHybrid({ rm });
    assert.equal(r.ok, true, `RM ${rm} rejected`);
    assert.ok(r.silk.value < r.blackLayer.value, `RM ${rm}: silk ${r.silk.value} >= BL ${r.blackLayer.value}`);
  }
  for (let silk = 400; silk <= 2200; silk += 25) {
    const r = resolveHybrid({ gduToSilk: silk });
    assert.ok(r.ok && r.silk.value < r.blackLayer.value, `silk ${silk} produced a bad pair`);
  }
  for (let bl = 900; bl <= 4000; bl += 50) {
    const r = resolveHybrid({ gduToBlackLayer: bl });
    assert.ok(r.ok && r.silk.value < r.blackLayer.value, `BL ${bl} produced a bad pair`);
  }
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
  const median = (a) => { const x = [...a].sort((p, q) => p - q); const m = Math.floor(x.length / 2); return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };
  const flagged = catalogDoc.hybrids.filter((hy) => {
    const nb = catalogDoc.hybrids.filter((o) => o.v !== hy.v && Math.abs(o.rm - hy.rm) <= 2).map((o) => o.b);
    return nb.length >= 3 && Math.abs(hy.b - median(nb)) > 250;
  });
  assert.deepEqual(flagged.map((x) => x.v), ["89-58 SSPRORIB"]);
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

test("band averages are the mean high and the mean low, not one blended mean", () => {
  const bt = bandMeanTemps(tempIndex, "2026-05-01", 0, 2, addDays);
  assert.equal(bt.days, 3);
  assert.equal(bt.avgHigh, (80 + 90 + 70) / 3); // 80
  assert.equal(bt.avgLow, (60 + 64 + 50) / 3); // 58
  // The point of keeping them apart: the blended 24-hour mean is 69 for
  // this band and would read identically for a 95/43 week.
});

test("band averages use the raw temperature, NOT the GDU-clamped one", () => {
  // 90 F clamps to 86 for GDU purposes. It must not clamp here - this is
  // reporting the weather, not computing development.
  const bt = bandMeanTemps(tempIndex, "2026-05-02", 0, 0, addDays);
  assert.equal(bt.avgHigh, 90);
});

test("a band containing any forecast day returns nothing at all", () => {
  // May 4-5 are forecast. Averaging the observed part and printing it
  // under a label that claims the whole stage is the failure mode this
  // guards.
  assert.equal(bandMeanTemps(tempIndex, "2026-05-01", 0, 3, addDays), null);
  assert.equal(bandMeanTemps(tempIndex, "2026-05-01", 3, 4, addDays), null);
});

test("a band running past the end of the data returns nothing", () => {
  assert.equal(bandMeanTemps(tempIndex, "2026-05-01", 0, 40, addDays), null);
});

test("a zero-length or reversed band returns nothing", () => {
  assert.equal(bandMeanTemps(tempIndex, "2026-05-01", 2, 1, addDays), null);
  assert.equal(bandMeanTemps(tempIndex, "2026-05-01", null, 1, addDays), null);
});

test("a min warmer than the max is still reported as high and low", () => {
  // Defensive, mirroring dailyGdu: a transposed row must not report a
  // low above its high.
  const idx = buildDailyIndex([{ time: ["2026-06-01"], tmax: [55], tmin: [88], source: "observed" }]);
  const bt = bandMeanTemps(idx, "2026-06-01", 0, 0, addDays);
  assert.equal(bt.avgHigh, 88);
  assert.equal(bt.avgLow, 55);
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

console.log(`\n${passed} assertions passed.\n`);
