// End-to-end smoke test. Serves public/ locally, intercepts every
// outbound weather/geocode call with deterministic synthetic data, and
// drives the app the way a person would.
//
//   node test/e2e_smoke.mjs            # assertions only
//   node test/e2e_smoke.mjs --shots    # also writes screenshots to test/shots/
//
// The interception is the point: this sandbox has no outbound network,
// and even where it did, a test that depends on live weather would give
// a different answer every day. The synthetic record below is a clean
// seasonal sinusoid with a fixed per-year warm/cool offset, so the
// resulting curves are predictable enough to assert on — a hot year is
// hot every run.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const SHOTS = process.argv.includes("--shots");
const SHOT_DIR = path.join(__dirname, "shots");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

function serve() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split("?")[0]);
    if (rel === "/") rel = "/index.html";
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---------------------------------------------------------------
// Synthetic weather
// ---------------------------------------------------------------
const MS_DAY = 86400000;

function isoRange(startIso, endIso) {
  const out = [];
  for (let t = Date.parse(startIso + "T00:00:00Z"); t <= Date.parse(endIso + "T00:00:00Z"); t += MS_DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * A clean seasonal curve: a sinusoid peaking in mid-July, plus a
 * deterministic per-year offset so some years are genuinely warmer than
 * others and the 10th/90th percentile bands are meaningfully apart.
 */
function tempsFor(iso) {
  const year = Number(iso.slice(0, 4));
  const doy = Math.round((Date.parse(iso + "T00:00:00Z") - Date.parse(year + "-01-01T00:00:00Z")) / MS_DAY);
  const seasonal = 52 - 32 * Math.cos((2 * Math.PI * (doy - 15)) / 365);
  const yearOffset = ((year * 7919) % 13) - 6; // -6 .. +6 °F, stable per year
  const mean = seasonal + yearOffset;
  return { tmax: Math.round((mean + 12) * 10) / 10, tmin: Math.round((mean - 12) * 10) / 10 };
}

function dailyPayload(times) {
  const t = times.map(tempsFor);
  return {
    latitude: 41.56,
    longitude: -95.89,
    timezone: "America/Chicago",
    daily_units: { temperature_2m_max: "°F", temperature_2m_min: "°F" },
    daily: { time: times, temperature_2m_max: t.map((x) => x.tmax), temperature_2m_min: t.map((x) => x.tmin) },
  };
}

const TODAY = new Date().toISOString().slice(0, 10);

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  // This sandbox ships a preinstalled Chromium at a fixed path that may
  // not match the npm package's expected build number — point at it
  // explicitly instead of letting Playwright try to download one.
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.route("**://archive-api.open-meteo.com/**", (route) => {
    const url = new URL(route.request().url());
    const start = url.searchParams.get("start_date");
    const end = url.searchParams.get("end_date");
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dailyPayload(isoRange(start, end))) });
  });
  await page.route("**://api.open-meteo.com/**", (route) => {
    const times = isoRange(TODAY, new Date(Date.parse(TODAY + "T00:00:00Z") + 15 * MS_DAY).toISOString().slice(0, 10));
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dailyPayload(times)) });
  });
  await page.route("**://api.zippopotam.us/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        "post code": "51555",
        places: [{ "place name": "Missouri Valley", latitude: "41.5644", longitude: "-95.8913", state: "Iowa", "state abbreviation": "IA" }],
      }),
    })
  );
  await page.route("**://api.bigdatacloud.net/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));

  let checks = 0;
  const check = (name, fn) => {
    try {
      fn();
      checks++;
      console.log(`  ok  ${name}`);
    } catch (e) {
      console.error(`FAIL  ${name}\n      ${e.message}`);
      process.exitCode = 1;
    }
  };

  // ---- brand select ------------------------------------------------
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.waitForSelector(".brand-select-screen");
  check("first run lands on the Brand View picker", () => {
    assert.ok(page.url().includes("#/brand-select"));
  });
  const brandCount = await page.locator(".brand-select-btn").count();
  check("all three Brand Views are offered", () => assert.equal(brandCount, 3));
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "01-brand-select.png"), fullPage: true });

  await page.locator(".brand-select-btn").nth(1).click(); // NC+
  await page.waitForSelector(".screen-body");
  check("picking a brand routes to the calculator", () => assert.ok(page.url().includes("#/calculator")));

  const chrome = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--chrome").trim());
  check("NC+ Brand View applies its own chrome color", () => assert.equal(chrome.toLowerCase(), "#215aa8"));

  // ---- inputs ------------------------------------------------------
  await page.fill('input[aria-label="ZIP code"]', "51555");
  await page.getByRole("button", { name: "Look Up" }).click();
  await page.waitForSelector(".location-status-success");
  const locName = await page.locator(".gdu-location-name").textContent();
  check("ZIP lookup sets the field location", () => assert.match(locName, /Missouri Valley, IA/));

  // Planting date: May 1 of the current year, via the date picker.
  const year = new Date().getFullYear();
  await page.evaluate(
    ([iso]) => {
      localStorage.setItem("gdu.plantingDate", JSON.stringify(iso));
    },
    [`${year}-05-01`]
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".screen-body");

  // ---- built-in hybrid list ------------------------------------------
  await page.waitForSelector(".gdu-pick-hybrid-btn:not([disabled])", { timeout: 10000 });
  const pickLabel = await page.locator(".gdu-pick-hybrid-btn").textContent();
  check("the hybrid list loads and reports its size", () => assert.match(pickLabel, /Choose from Hybrid List \(72\)/));

  await page.locator(".gdu-pick-hybrid-btn").click();
  await page.waitForSelector(".hybrid-picker-option");
  const rmHeads = await page.locator(".hybrid-picker-rm-head").count();
  check("the picker groups by relative maturity", () => assert.ok(rmHeads > 10, `only ${rmHeads} RM headings`));
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "06-hybrid-picker.png") });

  await page.fill('input[aria-label="Search hybrids"]', "09-90");
  await page.waitForFunction(() => document.querySelectorAll(".hybrid-picker-option").length === 1);
  const rowText = await page.locator(".hybrid-picker-option").first().textContent();
  check("search narrows to the matching variety with its GDU numbers", () => {
    assert.match(rowText, /09-90 PCE/);
    assert.match(rowText, /1,290 silk/);
    assert.match(rowText, /2,620 black layer/);
  });
  await page.locator(".hybrid-picker-option").first().click();

  await page.waitForSelector(".gdu-catalog-line");
  const silkVal = await page.inputValue('input[aria-label="GDUs to silk"]');
  const blVal = await page.inputValue('input[aria-label="GDUs to black layer"]');
  const nameVal = await page.inputValue('input[placeholder="e.g. 09-90 PCE"]');
  check("picking a hybrid fills the variety and both GDU boxes", () => {
    assert.equal(nameVal, "09-90 PCE");
    assert.equal(silkVal, "1290");
    assert.equal(blVal, "2620");
  });
  const provenance = await page.locator(".gdu-catalog-line").textContent();
  check("the source of the numbers is stated, with maturity", () => {
    assert.match(provenance, /From hybrid list/);
    assert.match(provenance, /109 day/);
  });

  // Editing a loaded value must drop the "from the list" badge — an
  // edited number should never keep wearing the catalog's authority.
  await page.fill('input[aria-label="GDUs to black layer"]', "2700");
  await page.waitForSelector(".gdu-tag-edited");
  const edited = await page.locator(".gdu-catalog-line").textContent();
  check("editing a loaded value is flagged and the list value is shown", () => {
    assert.match(edited, /Edited/);
    assert.match(edited, /2,620 black layer/);
  });
  await page.getByRole("button", { name: "Reset to list values" }).click();
  await page.waitForSelector(".gdu-tag-edited", { state: "detached" });
  const resetBl = await page.inputValue('input[aria-label="GDUs to black layer"]');
  check("reset restores the list value", () => assert.equal(resetBl, "2620"));

  // 89-58 SSPRORIB is ~350 GDU above its RM neighbours. Loaded as-is,
  // per explicit request, but the app must say so.
  await page.locator(".gdu-pick-hybrid-btn").click();
  await page.fill('input[aria-label="Search hybrids"]', "89-58");
  await page.waitForFunction(() => document.querySelectorAll(".hybrid-picker-option").length === 1);
  await page.locator(".hybrid-picker-option").first().click();
  await page.waitForSelector(".gdu-catalog-outlier");
  const outlier = await page.locator(".gdu-catalog-outlier").textContent();
  const outlierSilk = await page.inputValue('input[aria-label="GDUs to silk"]');
  const outlierBl = await page.inputValue('input[aria-label="GDUs to black layer"]');
  check("an RM outlier is flagged but its values are loaded unchanged", () => {
    assert.match(outlier, /89-58/);
    assert.equal(outlierSilk, "1329");
    assert.equal(outlierBl, "2592");
  });
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "07-outlier-note.png"), fullPage: true });

  // A hybrid with an ordinary rating must NOT be flagged.
  await page.locator(".gdu-pick-hybrid-btn").click();
  await page.fill('input[aria-label="Search hybrids"]', "09-90");
  await page.waitForFunction(() => document.querySelectorAll(".hybrid-picker-option").length === 1);
  await page.locator(".hybrid-picker-option").first().click();
  await page.waitForSelector(".gdu-catalog-line");
  const stillFlagged = await page.locator(".gdu-catalog-outlier").count();
  check("an ordinary rating is not flagged", () => assert.equal(stillFlagged, 0));

  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "02-calculator.png"), fullPage: true });

  // ---- validation guards --------------------------------------------
  // Reversed pair, both values individually plausible.
  await page.fill('input[aria-label="GDUs to black layer"]', "1500");
  await page.fill('input[aria-label="GDUs to silk"]', "2100");
  await page.getByRole("button", { name: "Calculate GDUs" }).click();
  await page.waitForSelector(".toast-error");
  const toastText = await page.locator(".toast-message").first().textContent();
  check("a silk rating above black layer is rejected", () => assert.match(toastText, /lower than/i));

  // A value that is not a hybrid rating at all is called out as a typo.
  await page.fill('input[aria-label="GDUs to silk"]', "50");
  await page.getByRole("button", { name: "Calculate GDUs" }).click();
  await page.waitForSelector(".toast-error");
  const rangeToast = await page.locator(".toast-message").first().textContent();
  check("an out-of-range rating is flagged as a typo", () => assert.match(rangeToast, /outside anything real/i));

  // ---- partial input: one GDU number, and RM only --------------------
  await page.fill('input[aria-label="GDUs to silk"]', "1290");
  await page.fill('input[aria-label="GDUs to black layer"]', "");
  await page.waitForFunction(() => document.querySelector(".gdu-tag-estimated") !== null);
  let resolvedText = await page.locator(".gdu-resolved-note").textContent();
  check("black layer is estimated from an entered silk rating", () => {
    assert.match(resolvedText, /estimated from GDUs to silk/);
    assert.match(resolvedText, /2,572 GDU/); // 2.3868*1290 - 507.45 = 2572
  });

  await page.fill('input[aria-label="GDUs to silk"]', "");
  await page.fill('input[aria-label="GDUs to black layer"]', "2620");
  await page.waitForTimeout(100);
  resolvedText = await page.locator(".gdu-resolved-note").textContent();
  check("silk is estimated from an entered black layer rating", () => {
    assert.match(resolvedText, /estimated from GDUs to black layer/);
    assert.match(resolvedText, /1,305 GDU/); // 0.3769*2620 + 317.65 = 1305.13 -> 1305
  });

  await page.fill('input[aria-label="GDUs to black layer"]', "");
  await page.fill('input[aria-label="Relative maturity"]', "105");
  await page.waitForTimeout(100);
  resolvedText = await page.locator(".gdu-resolved-note").textContent();
  check("both are estimated from RM alone", () => {
    assert.match(resolvedText, /estimated from 105 day RM/);
    assert.match(resolvedText, /1,285 GDU/); // 7.5526*105 + 492.2  = 1285.2
    assert.match(resolvedText, /2,568 GDU/); // 20.2059*105 + 445.9 = 2567.5
  });
  const estTags = await page.locator(".gdu-tag-estimated").count();
  check("both estimated values carry an est. tag", () => assert.equal(estTags, 2));

  // An RM outside the fitted 77-118 band must say it is extrapolating.
  await page.fill('input[aria-label="Relative maturity"]', "130");
  await page.waitForSelector(".gdu-resolved-warn");
  const warnText = await page.locator(".gdu-resolved-warn").textContent();
  check("extrapolating past the fitted RM range is warned about", () => assert.match(warnText, /extrapolating/i));

  // An RM-only hybrid must actually calculate.
  await page.fill('input[aria-label="Relative maturity"]', "105");
  await page.waitForTimeout(100);
  await page.getByRole("button", { name: "Calculate GDUs" }).click();
  await page.waitForSelector(".gdu-table", { timeout: 20000 });
  const bannerCount = await page.locator(".gdu-estimate-banner").count();
  check("an RM-only calculation runs and says its ratings were estimated", () => assert.equal(bannerCount, 1));
  const methodEstimate = await page.locator(".gdu-method-estimate").textContent();
  check("the method card explains the estimate and its error", () => {
    assert.match(methodEstimate, /estimated from 105 day RM/);
    assert.match(methodEstimate, /out-of-sample/);
  });
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "10-rm-only.png"), fullPage: true });

  // Back to the full, unambiguous hybrid for the remaining checks — RM
  // included, since the RM-only section above left 105 in the box and
  // the header legitimately reports whatever RM is currently set.
  await page.getByRole("button", { name: "Back to inputs" }).click();
  await page.waitForSelector(".gdu-pick-hybrid-btn");
  await page.fill('input[aria-label="Relative maturity"]', "109");
  await page.fill('input[aria-label="GDUs to silk"]', "1290");
  await page.fill('input[aria-label="GDUs to black layer"]', "2620");
  await page.waitForTimeout(100);

  // ---- results -----------------------------------------------------
  await page.getByRole("button", { name: "Calculate GDUs" }).click();
  await page.waitForSelector(".gdu-table", { timeout: 20000 });
  await page.waitForSelector(".gdu-chart-svg");

  const rowCount = await page.locator(".gdu-table:not(.gdu-data-table) tbody tr").count();
  check("every scenario has a row (3 this-season + 4 historical)", () => assert.equal(rowCount, 7));

  const seriesCount = await page.locator(".gdu-chart-svg path.gdu-line").count();
  check("the chart draws every series", () => assert.ok(seriesCount >= 5, `only ${seriesCount} line segments drawn`));

  const legendCount = await page.locator(".gdu-legend-item").count();
  check("a legend is present for all five series", () => assert.equal(legendCount, 5));

  const stageLines = await page.locator(".gdu-chart-svg line.gdu-stage-line").count();
  check("both stage reference lines are drawn", () => assert.equal(stageLines, 2));

  // Ordering sanity against the synthetic climatology: an abnormally hot
  // year must reach each stage no later than a normal one, and a cool
  // year no earlier.
  const dates = await page.evaluate(() => {
    const out = {};
    for (const tr of document.querySelectorAll(".gdu-table:not(.gdu-data-table) tbody tr")) {
      const name = tr.querySelector(".gdu-scenario-name").textContent.trim();
      const cells = tr.querySelectorAll("td");
      const read = (td) => {
        const d = td.querySelector(".gdu-stage-date");
        return d ? d.textContent.trim() : null;
      };
      out[name] = { silk: read(cells[1]), bl: read(cells[2]) };
    }
    return out;
  });
  const parse = (s) => (s ? Date.parse(s) : Infinity);
  const hot = Object.entries(dates).find(([k]) => /Abnormally hot/i.test(k))[1];
  const normal = Object.entries(dates).find(([k]) => /^Normal/i.test(k))[1];
  const cool = Object.entries(dates).find(([k]) => /Abnormally cool/i.test(k))[1];
  check("hot ≤ normal ≤ cool for silk", () => {
    assert.ok(parse(hot.silk) <= parse(normal.silk), `hot ${hot.silk} vs normal ${normal.silk}`);
    assert.ok(parse(normal.silk) <= parse(cool.silk), `normal ${normal.silk} vs cool ${cool.silk}`);
  });
  check("hot ≤ normal ≤ cool for black layer", () => {
    assert.ok(parse(hot.bl) <= parse(normal.bl), `hot ${hot.bl} vs normal ${normal.bl}`);
    assert.ok(parse(normal.bl) <= parse(cool.bl), `normal ${normal.bl} vs cool ${cool.bl}`);
  });

  const hasFrost = await page.locator("text=Frost Risk").count();
  check("the frost risk card renders", () => assert.ok(hasFrost > 0));

  const headerText = await page.locator(".card").first().textContent();
  check("the results header carries the maturity through from the list", () => assert.match(headerText, /109 day/));

  const methodText = await page.locator(".gdu-method-list").textContent();
  check("the method card names the formula and the source", () => {
    assert.match(methodText, /86 °F/);
    assert.match(methodText, /Open-Meteo/);
  });

  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "03-results.png"), fullPage: true });

  // ---- stage view --------------------------------------------------
  // No tab click: the accumulation chart, the stage chart and the data
  // table are all on the page at once.
  await page.waitForSelector(".gdu-stage-chart-svg");
  const bothCharts = await page.locator(".gdu-chart-svg, .gdu-stage-chart-svg").count();
  check("the accumulation chart and the stage chart are both on the page", () => assert.equal(bothCharts, 2));
  const bandCount = await page.locator(".gdu-stage-band").count();
  check("the stage chart draws a band per stage interval", () => assert.equal(bandCount, 14));

  const stageLabels = await page.locator(".gdu-stage-band-label").allTextContents();
  check("stage bands are labeled with a stage name and a date", () => {
    const joined = stageLabels.join(" | ");
    assert.match(joined, /Planting/);
    assert.match(joined, /Silks \(~ /);
    assert.match(joined, /Six leaves \(~ /);
  });

  const topLabel = await page.locator(".gdu-stage-top-label").textContent();
  check("maturity is labeled at the top of the stack", () => assert.match(topLabel, /Maturity \(black layer\) \(~ /));

  const anchoredCount = await page.locator(".gdu-stage-band-label-anchored").count();
  check("grower-anchored stages are visually distinguished", () => assert.ok(anchoredCount >= 2, `only ${anchoredCount} anchored labels`));

  const todayLabel = await page.locator(".gdu-stage-today-label").textContent();
  check("the progress marker reports GDU to date", () => assert.match(todayLabel, /GDU through/));

  const nowLine = await page.locator(".gdu-stage-now").textContent();
  check("the current stage is named in words above the chart", () => assert.match(nowLine, /Currently at /));
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "08-stages.png"), fullPage: true });

  // Switching scenario must move the dates without reloading weather.
  const beforeSwitch = (await page.locator(".gdu-stage-band-label").allTextContents()).join("|");
  await page.selectOption(".gdu-scenario-select", "cool");
  await page.waitForTimeout(150);
  const afterSwitch = (await page.locator(".gdu-stage-band-label").allTextContents()).join("|");
  check("changing scenario changes the projected dates", () => assert.notEqual(beforeSwitch, afterSwitch));
  await page.selectOption(".gdu-scenario-select", "current-normal");

  // ---- data table ---------------------------------------------------
  await page.waitForSelector(".gdu-data-table");
  const dataRows = await page.locator(".gdu-data-table tbody tr").count();
  check("the data table lists every stage", () => assert.equal(dataRows, 15));
  const estCount = await page.locator(".gdu-stage-est").count();
  check("estimated GDU thresholds are marked as estimates", () => assert.equal(estCount, 12));
  const dataText = await page.locator(".gdu-data-table").textContent();
  check("the data table carries the hybrid's own anchor values", () => {
    assert.match(dataText, /1,290/); // silk, straight off the hybrid list
    assert.match(dataText, /2,620/); // black layer
  });
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "09-data.png") });

  // Changing scenario must not disturb the accumulation chart above it.
  const accumStillThere = await page.locator(".gdu-chart-svg path.gdu-line").count();
  check("the accumulation chart survives a scenario change below it", () => assert.ok(accumStillThere >= 5));

  // ---- dark mode ---------------------------------------------------
  await page.evaluate(() => localStorage.setItem("gdu.themeMode", JSON.stringify("dark")));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".screen-body");
  await page.evaluate(() => {
    window.location.hash = "#/results";
  });
  await page.waitForSelector(".gdu-chart-svg", { timeout: 20000 });
  const darkTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  check("dark mode applies", () => assert.equal(darkTheme, "dark"));
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "04-results-dark.png"), fullPage: true });

  // ---- help --------------------------------------------------------
  await page.evaluate(() => {
    window.location.hash = "#/help";
  });
  await page.waitForSelector(".gdu-formula");
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "05-help-dark.png"), fullPage: true });

  check("no console errors anywhere in the flow", () => assert.deepEqual(consoleErrors, []));

  console.log(`\n${checks} checks passed.\n`);
  await browser.close();
  server.close();
}

if (SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
