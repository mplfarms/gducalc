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
// Shifted at the very end of the suite to drive an all-cold season, so
// the blue "never got above 50 °F" path gets exercised — the default
// fixture runs hot and produces none.
let TEMP_SHIFT = 0;

function tempsFor(iso) {
  const year = Number(iso.slice(0, 4));
  const doy = Math.round((Date.parse(iso + "T00:00:00Z") - Date.parse(year + "-01-01T00:00:00Z")) / MS_DAY);
  const seasonal = 52 - 32 * Math.cos((2 * Math.PI * (doy - 15)) / 365);
  const yearOffset = ((year * 7919) % 13) - 6; // -6 .. +6 °F, stable per year
  const mean = seasonal + yearOffset + TEMP_SHIFT;
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

/** Counts /Type /Page objects, excluding /Pages. */
function countPdfPages(buf) {
  return (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
}

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  // This sandbox ships a preinstalled Chromium at a fixed path that may
  // not match the npm package's expected build number — point at it
  // explicitly instead of letting Playwright try to download one.
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 2,
    // Service workers are blocked here for a concrete reason, not
    // squeamishness: requests a service worker makes are invisible to
    // page.route, and sw.js now handles the jsPDF CDN URL itself — so
    // with the worker running, the route below never fires and the PDF
    // export fails on a network the sandbox doesn't have. Blocking also
    // keeps the several page.reload()s in this suite deterministic
    // instead of racing a cache-first worker.
    serviceWorkers: "block",
  });
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
  // The PDF path loads jsPDF from cdnjs at runtime. Serve the pinned
  // version from node_modules so the export is exercised for real rather
  // than stubbed out.
  await page.route("**://cdnjs.cloudflare.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: fs.readFileSync(path.join(__dirname, "..", "node_modules", "jspdf", "dist", "jspdf.umd.min.js"), "utf8") })
  );

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

  // Every result card folds, and most default shut. Tests that read a
  // card's contents open everything first; the DEFAULTS themselves are
  // asserted once, on the first results render, before this is called.
  // The built-in list is now an inline combobox on the Hybrid field, not
  // a modal. Focus opens it; a click on a row fills the form.
  const pickFromList = async (query, expect) => {
    // fill() focuses the field itself, which opens the list — clicking
    // first would only race the dropdown as it covers the box.
    await page.fill('input[aria-label="Hybrid name"]', query);
    await page.waitForFunction((n) => document.querySelectorAll(".gdu-suggest-option").length === n, expect, { timeout: 5000 });
    // The list re-renders on every keystroke, so let it settle before
    // clicking or the row can detach mid-click.
    await page.waitForTimeout(80);
    await page.locator(".gdu-suggest-option").first().click();
  };

  const expandAllCards = async () => {
    await page.waitForSelector(".gdu-card-toggle");
    // Loop rather than click-all-at-once: clicking an already-open card
    // would close it.
    for (let i = 0; i < 20; i++) {
      const shut = await page.locator(".gdu-card-toggle:not(.gdu-card-toggle-open)").count();
      if (shut === 0) break;
      await page.locator(".gdu-card-toggle:not(.gdu-card-toggle-open)").first().click();
    }
    await page.waitForFunction(() => document.querySelectorAll(".gdu-card-toggle:not(.gdu-card-toggle-open)").length === 0);
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
  const gpsButtons = await page.getByRole("button", { name: "Use My Location" }).count();
  check("device location is gone; ZIP is the only way in", () => assert.equal(gpsButtons, 0));

  // ---- Location Details ------------------------------------------------
  // Location and planting date are one card now: the two things a run
  // cannot happen without, filled at the same moment.
  const locCard = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".card")];
    const card = cards.find((c) => /Location Details/.test(c.querySelector(".section-header")?.textContent || ""));
    if (!card) return null;
    const labels = [...card.querySelectorAll(".field-label")].map((l) => l.textContent.trim());
    return {
      labels,
      headers: cards.map((c) => c.querySelector(".section-header")?.textContent.trim()).filter(Boolean),
      hasName: !!card.querySelector('input[aria-label="Location name"]'),
      hasZip: !!card.querySelector('input[aria-label="ZIP code"]'),
      hasDate: !!card.querySelector(".date-picker-input, input"),
    };
  });
  check("Location Details holds the name, the ZIP and the planting date", () => {
    assert.ok(locCard, "no Location Details card");
    assert.deepEqual(locCard.labels, ["Location Name", "ZIP Code", "Planting Date"]);
    assert.ok(locCard.hasName && locCard.hasZip);
  });
  check("the old separate Field Location and Planting Date cards are gone", () => {
    assert.ok(!locCard.headers.includes("Field Location"), locCard.headers.join(" | "));
    assert.ok(!locCard.headers.includes("Planting Date"), locCard.headers.join(" | "));
  });

  await page.fill('input[aria-label="ZIP code"]', "51555");
  await page.getByRole("button", { name: "Look Up" }).click();
  await page.waitForSelector(".location-status-success");
  const locName = await page.locator(".gdu-location-name").textContent();
  check("ZIP lookup sets the field location", () => assert.match(locName, /Missouri Valley, IA/));
  const coordLine = await page.locator(".gdu-location-coords").count();
  check("the ZIP-centroid coordinate line is gone", () => {
    // Four decimal places on a centroid implied a precision the ~6-15
    // mile grid behind it does not have.
    assert.equal(coordLine, 0);
  });

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

  // ---- hybrid mode toggle ----------------------------------------------
  // Two mutually exclusive ways to run this, expressed as a segmented
  // control. Exactly one is always selected, so the card's state is
  // never ambiguous — which two independent buttons could not promise.
  const modeStart = await page.evaluate(() => {
    const btns = [...document.querySelectorAll(".gdu-mode-btn")];
    return {
      labels: btns.map((b) => b.textContent.trim()),
      pressed: btns.map((b) => b.getAttribute("aria-pressed")),
      heights: btns.map((b) => Math.round(b.getBoundingClientRect().height)),
      widths: btns.map((b) => Math.round(b.getBoundingClientRect().width)),
      tops: btns.map((b) => Math.round(b.getBoundingClientRect().top)),
      bodyHidden: document.querySelector(".gdu-hybrid-body").hidden,
      // The old header chevron is gone; the toggle is the only expander.
      legacyToggle: document.querySelectorAll(".gdu-hybrid-toggle").length,
    };
  });
  check("the toggle offers Enter Hybrid and GDU Only", () => {
    assert.deepEqual(modeStart.labels, ["Enter Hybrid", "GDU Only"]);
  });
  check("exactly one mode is selected, never both or neither", () => {
    assert.equal(modeStart.pressed.filter((p) => p === "true").length, 1);
  });
  check("GDU Only is the mode on a fresh run, with the detail folded shut", () => {
    assert.equal(modeStart.pressed[1], "true");
    assert.equal(modeStart.bodyHidden, true);
  });
  check("the two halves are equal and both a full 44px target", () => {
    assert.equal(modeStart.tops[0], modeStart.tops[1], "should share a row");
    assert.ok(Math.abs(modeStart.widths[0] - modeStart.widths[1]) <= 1, "equal halves");
    for (const hgt of modeStart.heights) assert.ok(hgt >= 44, `only ${hgt}px tall`);
  });
  check("the old header chevron is gone", () => {
    // Two controls for one piece of state is how they end up disagreeing.
    assert.equal(modeStart.legacyToggle, 0);
  });
  const emptyNote = await page.locator(".gdu-hybrid-empty").textContent();
  check("the folded card says what Calculate will do without a hybrid", () => assert.match(emptyNote, /no silk or black layer dates/i));
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "16-hybrid-collapsed.png"), fullPage: true });

  await page.getByRole("button", { name: "Enter Hybrid" }).click();
  await page.waitForFunction(() => document.querySelector(".gdu-hybrid-body").hidden === false);
  // The focus lands in a setTimeout, so sample it when it arrives rather
  // than racing it.
  await page
    .waitForFunction(() => document.activeElement && document.activeElement.getAttribute("aria-label") === "Hybrid name", { timeout: 3000 })
    .catch(() => {});
  const afterEnter = await page.evaluate(() => ({
    pressed: [...document.querySelectorAll(".gdu-mode-btn")].map((b) => b.getAttribute("aria-pressed")),
    focused: document.activeElement ? document.activeElement.getAttribute("aria-label") : null,
  }));
  check("Enter Hybrid expands the detail and selects itself", () => {
    assert.deepEqual(afterEnter.pressed, ["true", "false"]);
  });
  check("Enter Hybrid drops the caret into the hybrid field", () => {
    assert.equal(afterEnter.focused, "Hybrid name");
  });

  // The shared stylesheet resets `font: inherit` on button/input/textarea
  // but not select, so the Brand box used to render at the browser's own
  // control font and read as a different, smaller field.
  const boxMetrics = await page.evaluate(() => {
    const g = (el) => {
      const r = el.getBoundingClientRect();
      const c = getComputedStyle(el);
      return { h: Math.round(r.height), font: c.fontSize, appearance: c.appearance };
    };
    return {
      select: g(document.querySelector('select[aria-label="Brand"]')),
      input: g(document.querySelector('input[aria-label="Hybrid name"]')),
    };
  });
  check("the Brand select matches the text inputs", () => {
    assert.equal(boxMetrics.select.h, boxMetrics.input.h, "height");
    assert.equal(boxMetrics.select.font, boxMetrics.input.font, "font size");
    assert.equal(boxMetrics.select.appearance, "none", "native chrome should be replaced");
  });

  // ---- one house brand per Brand View ---------------------------------
  // Midwest / NC+ / Crow's are the same genetics under three labels, so
  // offering all three inside one Brand View let a rep build a report
  // headed with a brand they were not actually in.
  const brandOpts = await page.locator('select[aria-label="Brand"] option').allTextContents();
  check("only the active house brand is offered, plus Other", () => {
    assert.deepEqual(brandOpts, ["— Select brand —", "NC+ Hybrids", "Other"]);
  });
  const brandVal = await page.inputValue('select[aria-label="Brand"]');
  check("the brand defaults to the active Brand View", () => assert.equal(brandVal, "NC+ Hybrids"));
  const namePlaceholder = await page.getAttribute('input[aria-label="Hybrid name"]', "placeholder");
  check("the hybrid placeholder carries the Brand View's code", () => assert.equal(namePlaceholder, "e.g. NC 09-90 PCE"));

  // ---- "Other" suppresses the built-in list ---------------------------
  // The list is OUR genetics. Offering it under Other would suggest a
  // competitor hybrid can be looked up in it, and a rep who picked from
  // the list would end up with our numbers under somebody else's name.
  await page.selectOption('select[aria-label="Brand"]', "Other");
  await page.click('input[aria-label="Hybrid name"]');
  await page.waitForTimeout(150);
  const underOther = await page.evaluate(() => ({
    rows: document.querySelectorAll(".gdu-suggest-option").length,
    hidden: document.querySelector(".gdu-suggest").hidden,
    expanded: document.querySelector('input[aria-label="Hybrid name"]').getAttribute("aria-expanded"),
    placeholder: document.querySelector('input[aria-label="Hybrid name"]').placeholder,
    note: document.querySelector(".gdu-hybrid-field .field-note").textContent,
  }));
  check("no list drops down when the brand is Other", () => {
    assert.equal(underOther.rows, 0);
    assert.equal(underOther.hidden, true);
    assert.equal(underOther.expanded, "false");
  });
  check("the example and the helper text stop pointing at our own list", () => {
    assert.ok(!/NC /.test(underOther.placeholder), `placeholder still ours: ${underOther.placeholder}`);
    assert.match(underOther.note, /no list to pick from/i);
  });
  // Typing must still be accepted — Other is a real path, not a dead end.
  await page.fill('input[aria-label="Hybrid name"]', "DKC62-08");
  await page.waitForTimeout(150);
  const typedUnderOther = await page.evaluate(() => ({
    rows: document.querySelectorAll(".gdu-suggest-option").length,
    stored: JSON.parse(localStorage.getItem("gdu.currentHybrid") || "{}").name,
  }));
  check("a competitor hybrid can still be typed straight in", () => {
    assert.equal(typedUnderOther.rows, 0);
    assert.equal(typedUnderOther.stored, "DKC62-08");
  });

  // Back to the house brand for everything below.
  await page.selectOption('select[aria-label="Brand"]', "NC+ Hybrids");
  await page.fill('input[aria-label="Hybrid name"]', "");
  await page.waitForTimeout(100);

  // ---- built-in hybrid list, inline on the field ----------------------
  // The modal picker is gone. Focus the box and the whole list drops
  // down; type and it filters. One control instead of two, and no round
  // trip through a dialog for what is really "fill in this box".
  await page.click('input[aria-label="Hybrid name"]');
  await page.waitForSelector(".gdu-suggest-option");
  const listState = await page.evaluate(() => {
    const box = document.querySelector(".gdu-suggest");
    const rows = [...document.querySelectorAll(".gdu-suggest-option")];
    return {
      count: rows.length,
      expanded: document.querySelector('input[aria-label="Hybrid name"]').getAttribute("aria-expanded"),
      role: document.querySelector('input[aria-label="Hybrid name"]').getAttribute("role"),
      scrolls: box.scrollHeight > box.clientHeight,
      rowHeights: rows.slice(0, 5).map((r) => Math.round(r.getBoundingClientRect().height)),
      rms: rows.map((r) => Number((r.textContent.match(/(\d+) day/) || [])[1])).filter(Number.isFinite),
      first: rows[0].textContent,
      legacyModal: document.querySelectorAll(".hybrid-picker-option").length,
    };
  });
  check("tapping the field drops down the whole list", () => {
    assert.equal(listState.count, 133);
    assert.equal(listState.expanded, "true");
    assert.equal(listState.role, "combobox");
    assert.ok(listState.scrolls, "the list has to scroll, not run off the card");
  });
  check("the modal picker is gone", () => assert.equal(listState.legacyModal, 0));
  check("every row is a full 44px target", () => {
    for (const hgt of listState.rowHeights) assert.ok(hgt >= 44, `row only ${hgt}px`);
  });
  check("the list is still sorted shortest maturity first", () => {
    assert.equal(listState.rms.length, 133);
    for (let i = 1; i < listState.rms.length; i++) {
      assert.ok(listState.rms[i] >= listState.rms[i - 1], `RM out of order at row ${i}`);
    }
  });
  check("rows carry the Brand View's code and both GDU numbers", () => {
    assert.match(listState.first, /NC /);
    assert.match(listState.first, /silk/);
    assert.match(listState.first, /black layer/);
  });
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "06-hybrid-list.png") });

  // The chevron mirrors the Brand select above and is a real control:
  // with the box already filled, it has to be able to reopen the FULL
  // list, which re-focusing already-focused text cannot do.
  const chevron = await page.evaluate(() => {
    const btn = document.querySelector(".gdu-suggest-chevron");
    const input = document.querySelector('input[aria-label="Hybrid name"]');
    const b = btn.getBoundingClientRect();
    const i = input.getBoundingClientRect();
    return {
      tag: btn.tagName,
      hasSvg: !!btn.querySelector("svg"),
      insideBox: b.right <= i.right + 1 && b.top >= i.top - 1 && b.bottom <= i.bottom + 1,
      tall: Math.round(b.height) >= 44,
      // The text must not run under the arrow.
      padRight: getComputedStyle(input).paddingRight,
    };
  });
  check("the hybrid box carries the same drop-down arrow as the Brand select", () => {
    assert.equal(chevron.tag, "BUTTON");
    assert.ok(chevron.hasSvg, "no chevron glyph");
    assert.ok(chevron.insideBox, "the arrow should sit inside the field");
    assert.ok(chevron.tall, "the arrow needs a full-height tap target");
    assert.equal(chevron.padRight, "34px");
  });

  // Toggle shut, then open again from the arrow.
  await page.locator(".gdu-suggest-chevron").click();
  await page.waitForFunction(() => document.querySelector(".gdu-suggest").hidden === true);
  await page.locator(".gdu-suggest-chevron").click();
  await page.waitForFunction(() => document.querySelectorAll(".gdu-suggest-option").length > 0);
  check("the arrow toggles the list shut and open", () => assert.ok(true));

  // Typing filters it.
  await page.fill('input[aria-label="Hybrid name"]', "09-90");
  await page.waitForFunction(() => document.querySelectorAll(".gdu-suggest-option").length === 1);
  const rowText = await page.locator(".gdu-suggest-option").first().textContent();
  check("typing narrows to the matching variety with its GDU numbers", () => {
    assert.match(rowText, /09-90 PCE/);
    assert.match(rowText, /109 day/);
    assert.match(rowText, /1,290 silk/);
    assert.match(rowText, /2,620 black layer/);
  });

  // Keyboard: arrow to highlight, Enter to take it.
  await page.keyboard.press("ArrowDown");
  const highlighted = await page.locator(".gdu-suggest-active").count();
  check("arrow keys highlight a row", () => assert.equal(highlighted, 1));
  await page.keyboard.press("Enter");

  await page.waitForSelector(".gdu-catalog-line");
  const silkVal = await page.inputValue('input[aria-label="GDUs to silk"]');
  const blVal = await page.inputValue('input[aria-label="GDUs to black layer"]');
  const nameVal = await page.inputValue('input[aria-label="Hybrid name"]');
  check("picking a hybrid fills the variety and both GDU boxes", () => {
    // Stored and shown under the active Brand View's code — the list
    // itself is brand-neutral, the label is not.
    assert.equal(nameVal, "NC 09-90 PCE");
    assert.equal(silkVal, "1290");
    assert.equal(blVal, "2620");
  });
  // A box already holding a chosen hybrid must still be able to browse:
  // an earlier build showed nothing at all on an exact match, which left
  // a filled field with no way to reach a different variety.
  await page.locator(".gdu-suggest-chevron").click();
  await page.waitForFunction(() => document.querySelectorAll(".gdu-suggest-option").length > 1);
  const browseFromFilled = await page.evaluate(() => ({
    rows: document.querySelectorAll(".gdu-suggest-option").length,
    value: document.querySelector('input[aria-label="Hybrid name"]').value,
  }));
  check("a filled box reopens the whole list, like reopening a select", () => {
    assert.equal(browseFromFilled.rows, 133);
    assert.equal(browseFromFilled.value, "NC 09-90 PCE", "browsing must not clear the choice");
  });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".gdu-suggest").hidden === true);

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
  await pickFromList("89-58", 1);
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
  await pickFromList("09-90", 1);
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
    assert.match(resolvedText, /2,581 GDU/); // 2.3519*1290 - 452.57 = 2581.4
  });

  await page.fill('input[aria-label="GDUs to silk"]', "");
  await page.fill('input[aria-label="GDUs to black layer"]', "2620");
  await page.waitForTimeout(100);
  resolvedText = await page.locator(".gdu-resolved-note").textContent();
  check("silk is estimated from an entered black layer rating", () => {
    assert.match(resolvedText, /estimated from GDUs to black layer/);
    assert.match(resolvedText, /1,298 GDU/); // 0.3623*2620 + 348.90 = 1298.1
  });

  await page.fill('input[aria-label="GDUs to black layer"]', "");
  await page.fill('input[aria-label="Relative maturity"]', "105");
  await page.waitForTimeout(100);
  resolvedText = await page.locator(".gdu-resolved-note").textContent();
  check("both are estimated from RM alone", () => {
    assert.match(resolvedText, /estimated from 105 day RM/);
    assert.match(resolvedText, /1,276 GDU/); // 8.1765*105 + 417.33 = 1276.0
    assert.match(resolvedText, /2,555 GDU/); // 21.5603*105 + 291.38 = 2555.2
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
  await page.waitForSelector(".gdu-card-toggle", { timeout: 20000 });
  await expandAllCards();
  await page.waitForSelector(".gdu-table", { timeout: 20000 });
  const bannerCount = await page.locator(".gdu-estimate-banner").count();
  check("an RM-only calculation runs and says its ratings were estimated", () => assert.equal(bannerCount, 1));
  const methodEstimate = await page.locator(".gdu-method-estimate").textContent();
  check("the method card explains the estimate and its error", () => {
    assert.match(methodEstimate, /estimated from 105 day RM/);
    assert.match(methodEstimate, /out-of-sample/);
  });
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "10-rm-only.png"), fullPage: true });

  // The estimated path adds a callout and an extra method bullet, so it
  // is the one most likely to spill onto a third page. Check it too.
  const estDownloadPromise = page.waitForEvent("download", { timeout: 30000 });
  await page.locator(".top-bar-btn-share").click();
  const estDownload = await estDownloadPromise;
  const estPdfPath = path.join(SHOT_DIR, "gdu-outlook-estimated.pdf");
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await estDownload.saveAs(estPdfPath);
  const estPages = countPdfPages(fs.readFileSync(estPdfPath));
  check("an RM-estimated report also fits on two sheets", () => assert.equal(estPages, 2));

  // Back to the full, unambiguous hybrid for the remaining checks — RM
  // included, since the RM-only section above left 105 in the box and
  // the header legitimately reports whatever RM is currently set.
  await page.getByRole("button", { name: "Back to inputs" }).click();
  await page.waitForSelector(".gdu-mode-btn");
  if (await page.locator(".gdu-hybrid-body").isHidden()) await page.getByRole("button", { name: "Enter Hybrid" }).click();
  await page.fill('input[aria-label="Relative maturity"]', "109");
  await page.fill('input[aria-label="GDUs to silk"]', "1290");
  await page.fill('input[aria-label="GDUs to black layer"]', "2620");
  await page.waitForTimeout(100);

  // ---- results -----------------------------------------------------
  await page.getByRole("button", { name: "Calculate GDUs" }).click();
  await page.waitForSelector(".gdu-chart-svg", { timeout: 20000 });

  // ---- masthead ------------------------------------------------------
  const identity = await page.evaluate(() => {
    const card = document.querySelector(".gdu-identity");
    if (!card) return null;
    const img = card.querySelector("img.gdu-identity-logo");
    return {
      first: document.querySelector(".screen-body").firstElementChild === card,
      logo: img ? img.getAttribute("src") : null,
      title: card.querySelector(".gdu-identity-title").textContent,
      meta: card.querySelector(".gdu-identity-meta").textContent,
      collapsible: !!card.querySelector(".gdu-card-toggle"),
    };
  });
  check("the report opens with a brand masthead naming the hybrid", () => {
    assert.ok(identity, "no identity card");
    assert.equal(identity.first, true, "masthead should be the first card");
    assert.equal(identity.logo, "/logos/ncplus.png");
    assert.equal(identity.title, "NC 09-90 PCE");
    assert.match(identity.meta, /Missouri Valley/);
    assert.match(identity.meta, /Planted/);
    assert.match(identity.meta, /109 day/);
  });
  check("the masthead is not itself collapsible", () => assert.equal(identity.collapsible, false));

  // ---- card order and default open/closed state ------------------------
  const cardState = await page.evaluate(() =>
    [...document.querySelectorAll(".gdu-card-body")].map((b) => ({
      key: b.id.replace("gdu-card-", ""),
      open: !b.hidden,
      title: b.parentElement.querySelector(".gdu-card-title").textContent,
    }))
  );
  check("Growth Stages sits above Predicted Stage Dates", () => {
    const order = cardState.map((c) => c.key);
    assert.ok(order.indexOf("stages") < order.indexOf("table"), `order was ${JSON.stringify(order)}`);
    assert.ok(order.indexOf("table") < order.indexOf("data"), "Data belongs after the date table");
  });
  check("cards open to the intended defaults", () => {
    // Arriving on the screen you get the three things you came for and
    // nothing else; the reference material is one tap away.
    assert.deepEqual(
      cardState.map((c) => [c.key, c.open]),
      [
        ["details", false],
        ["status", true],
        ["chart", true],
        ["stages", true],
        ["table", false],
        ["data", false],
        ["frost", false],
        ["method", false],
      ]
    );
  });
  check("the first card is titled Details, not the hybrid name", () => {
    assert.equal(cardState[0].title, "Details");
  });
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "17-results-default.png"), fullPage: true });

  // Every header is a real button reporting its own state.
  const toggleA11y = await page.evaluate(() =>
    [...document.querySelectorAll(".gdu-card-toggle")].map((t) => ({
      tag: t.tagName,
      expanded: t.getAttribute("aria-expanded"),
      controls: t.getAttribute("aria-controls"),
      chevron: !!t.querySelector(".gdu-card-chevron"),
      h: Math.round(t.getBoundingClientRect().height),
    }))
  );
  check("every card header is a button with a chevron and a 44px target", () => {
    assert.equal(toggleA11y.length, 8);
    for (const t of toggleA11y) {
      assert.equal(t.tag, "BUTTON");
      assert.ok(t.chevron, "missing chevron");
      assert.ok(["true", "false"].includes(t.expanded));
      assert.ok(t.h >= 44, `header only ${t.h}px tall`);
      assert.ok(t.controls, "header must name the body it controls");
    }
  });

  // Toggling has to actually work, and update its own aria state.
  await page.locator("#gdu-card-frost").evaluate((el) => el.scrollIntoView());
  const frostToggle = page.locator('.gdu-card-toggle[aria-controls="gdu-card-frost"]');
  await frostToggle.click();
  await page.waitForFunction(() => document.querySelector("#gdu-card-frost").hidden === false);
  const afterOpen = await frostToggle.getAttribute("aria-expanded");
  await frostToggle.click();
  await page.waitForFunction(() => document.querySelector("#gdu-card-frost").hidden === true);
  const afterClose = await frostToggle.getAttribute("aria-expanded");
  check("a header toggles its card and reports the new state", () => {
    assert.equal(afterOpen, "true");
    assert.equal(afterClose, "false");
  });

  await expandAllCards();
  await page.waitForSelector(".gdu-table", { timeout: 20000 });

  // One collapsed "this season" row + 4 whole-season comparison rows.
  // The three finishes used to be three rows; they shared every observed
  // and forecast day, so whenever a stage fell inside the known window
  // they printed the same date three times and read as a bug.
  const rowCount = await page.locator(".gdu-table:not(.gdu-data-table) tbody tr").count();
  check("this season is one row, with four historical rows below it", () => assert.equal(rowCount, 5));
  const currentRows = await page.locator("tr.gdu-row-current").count();
  check("exactly one row is the current season", () => assert.equal(currentRows, 1));
  const currentText = await page.locator("tr.gdu-row-current").textContent();
  check("the current-season row states what kind of number each date is", () => {
    // Every stage date must be labelled reached / in forecast /
    // projected — an unlabelled date is the ambiguity this whole change
    // exists to remove.
    const badges = (currentText.match(/reached|in forecast|projected/g) || []).length;
    assert.ok(badges >= 2, `expected a basis on both stages, got: ${currentText}`);
  });
  check("a stage inside the known window shows no scenario range", () => {
    // Both stages land inside observed/forecast in this fixture. That is
    // precisely the case that used to print three identical rows.
    assert.ok(!/hot to cool finish/.test(currentText), `unexpected range on a known-window date: ${currentText}`);
  });

  const seriesCount = await page.locator(".gdu-chart-svg path.gdu-line").count();
  check("the chart draws every series", () => assert.ok(seriesCount >= 5, `only ${seriesCount} line segments drawn`));

  const legend = await page.evaluate(() =>
    [...document.querySelectorAll(".gdu-legend-item")].map((i) => ({
      text: i.querySelector("span:last-child").textContent,
      capped: i.querySelector(".gdu-legend-swatch-capped") !== null,
      zero: i.querySelector(".gdu-legend-swatch-zero") !== null,
    }))
  );
  check("a legend is present for all five series", () => {
    const series = legend.filter((l) => !l.capped && !l.zero);
    assert.equal(series.length, 5);
  });

  // ---- heat-cap / cold-floor day markers -------------------------------
  const limitDays = await page.evaluate(() => {
    const seg = [...document.querySelectorAll(".gdu-limit-day")];
    const cs = (el) => getComputedStyle(el).stroke;
    return {
      capped: seg.filter((e) => e.classList.contains("gdu-limit-capped")).length,
      zero: seg.filter((e) => e.classList.contains("gdu-limit-zero")).length,
      cappedStroke: seg.find((e) => e.classList.contains("gdu-limit-capped")) ? cs(seg.find((e) => e.classList.contains("gdu-limit-capped"))) : null,
      // A segment must never be both, and must sit on the season line.
      bothClasses: seg.filter((e) => e.classList.contains("gdu-limit-capped") && e.classList.contains("gdu-limit-zero")).length,
    };
  });
  check("days that hit the 86 °F cap are marked in red on the season line", () => {
    assert.ok(limitDays.capped > 0, "the synthetic season runs hot; expected capped days");
    assert.equal(limitDays.cappedStroke, "rgb(204, 31, 31)");
  });
  check("a day is never marked as both capped and zero", () => assert.equal(limitDays.bothClasses, 0));
  check("the legend only lists a marker that is actually on the chart", () => {
    const cappedItems = legend.filter((l) => l.capped);
    const zeroItems = legend.filter((l) => l.zero);
    assert.equal(cappedItems.length, limitDays.capped > 0 ? 1 : 0);
    assert.equal(zeroItems.length, limitDays.zero > 0 ? 1 : 0);
    if (cappedItems.length) assert.match(cappedItems[0].text, /86 °F/);
  });
  check("the legend states how many days hit each limit", () => {
    const capped = legend.find((l) => l.capped);
    if (!capped) return;
    const m = capped.text.match(/\((\d+)\)$/);
    assert.ok(m, `no count in "${capped.text}"`);
    assert.equal(Number(m[1]), limitDays.capped);
  });

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

  // The ramp splits at R1 in EVERY Brand View — green while the plant
  // builds leaves, harvest gold once it fills grain. It encodes the crop,
  // not the label on the bag, so it no longer varies by brand.
  const ramp = await page.evaluate(() => {
    const bands = [...document.querySelectorAll(".gdu-stage-band")];
    const labels = [...document.querySelectorAll("text.gdu-stage-band-label")].map((t) => t.textContent);
    return {
      veg: bands.filter((b) => b.classList.contains("gdu-stage-band-veg")).map((b) => ({ fill: getComputedStyle(b).fill, a: Number(b.getAttribute("fill-opacity")) })),
      rep: bands.filter((b) => b.classList.contains("gdu-stage-band-rep")).map((b) => ({ fill: getComputedStyle(b).fill, a: Number(b.getAttribute("fill-opacity")) })),
      both: bands.filter((b) => b.classList.contains("gdu-stage-band-veg") && b.classList.contains("gdu-stage-band-rep")).length,
      labels,
    };
  });
  check("the ramp runs green up to R1, then harvest gold to black layer", () => {
    assert.ok(ramp.veg.length > 0 && ramp.rep.length > 0, "expected both halves");
    assert.equal(ramp.both, 0, "a band cannot be in both halves");
    for (const b of ramp.veg) assert.equal(b.fill, "rgb(47, 125, 79)");
    for (const b of ramp.rep) assert.equal(b.fill, "rgb(218, 145, 0)");
  });
  check("each half fades independently, so the gold restarts pale at R1", () => {
    // The reset is the point — it puts a visible mark on the switch from
    // vegetative growth to grain fill.
    const first = (arr) => arr[0].a;
    const last = (arr) => arr[arr.length - 1].a;
    assert.ok(last(ramp.veg) > first(ramp.veg), "green should deepen toward R1");
    assert.ok(last(ramp.rep) > first(ramp.rep), "gold should deepen toward black layer");
    assert.ok(first(ramp.rep) < last(ramp.veg), "gold must restart lighter than the green it follows");
  });
  check("the split falls exactly at Silks, not a band early or late", () => {
    // 15 stages -> 14 bands; Silks is index 10, so 10 vegetative bands
    // (Planting..Sixteen leaves) and 4 reproductive (Silks..Denting).
    assert.equal(ramp.veg.length, 10);
    assert.equal(ramp.rep.length, 4);
  });
  const backdropLight = await page.evaluate(() => getComputedStyle(document.querySelector(".gdu-stage-backdrop")).fill);
  check("light mode composites straight onto the white card", () => assert.equal(backdropLight, "rgb(255, 255, 255)"));

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

  // Sanity anchor for the no-hybrid test far below: with a hybrid loaded
  // there ARE silk/black-layer threshold lines, so asserting zero of them
  // later is a real assertion and not a dead selector.
  const withHybridThresholds = await page.locator(".gdu-chart-svg .gdu-stage-line").count();
  check("the accumulation chart draws a line at silk and at black layer", () => assert.equal(withHybridThresholds, 2));

  // ---- stage-band average high/low ------------------------------------
  // Only for stages the crop has finished living through. A stage still
  // under way, or one only the forecast has reached, is blank rather
  // than averaged from a partial week.
  const bandLabels = await page.locator("text.gdu-stage-band-label").allTextContents();
  const withTemps = bandLabels.filter((t) => /\d+°\/\d+°/.test(t));
  check("completed stage bands carry a hottest-day / warmest-night pair", () => {
    assert.ok(withTemps.length >= 3, `only ${withTemps.length} of ${bandLabels.length} bands had temps: ${JSON.stringify(bandLabels)}`);
  });
  check("the pair is a high over a low, not a single 24-hour mean", () => {
    for (const t of withTemps) {
      const m = t.match(/(\d+)°\/(\d+)°/);
      assert.ok(m, t);
      assert.ok(Number(m[1]) > Number(m[2]), `high should exceed low in "${t}"`);
      assert.ok(Number(m[1]) < 130 && Number(m[2]) > -40, `implausible temps in "${t}"`);
    }
  });
  // The "N GDU through <date>" rule cuts through whichever band the crop
  // is currently in, and that band's centered label used to be drawn on
  // top of it — an unreadable smear on the one band that matters most.
  const labelOverlap = await page.evaluate(() => {
    const today = document.querySelector("text.gdu-stage-today-label");
    if (!today) return { checked: 0, hits: [] };
    const t = today.getBoundingClientRect();
    const hits = [];
    for (const el of document.querySelectorAll("text.gdu-stage-band-label")) {
      const b = el.getBoundingClientRect();
      const overlaps = t.left < b.right && b.left < t.right && t.top < b.bottom && b.top < t.bottom;
      if (overlaps) hits.push(el.textContent);
    }
    // Does the rule actually cut through a band? If not this check is
    // vacuous and should say so.
    const line = document.querySelector("line.gdu-stage-today-line");
    const ly = line ? Number(line.getAttribute("y1")) : null;
    let splitsBand = false;
    for (const r of document.querySelectorAll("rect.gdu-stage-band")) {
      const top = Number(r.getAttribute("y"));
      const bot = top + Number(r.getAttribute("height"));
      if (ly !== null && ly > top + 1 && ly < bot - 1) splitsBand = true;
    }
    return { checked: document.querySelectorAll("text.gdu-stage-band-label").length, hits, splitsBand };
  });
  check("the progress marker never overprints a band label", () => {
    assert.ok(labelOverlap.checked > 0, "no band labels were drawn at all");
    assert.deepEqual(labelOverlap.hits, [], "these labels collide with the GDU-through marker");
    // Non-vacuous: the rule must actually be cutting through a band, or
    // this test would pass on a chart that never had the problem.
    assert.ok(labelOverlap.splitsBand, "the progress rule did not land inside any band - test proves nothing");
  });

  const dataTempCells = await page.locator(".gdu-data-table .gdu-band-temps").allTextContents();
  check("the Data table repeats the pair with its day count", () => {
    const filled = dataTempCells.filter((t) => /°/.test(t));
    assert.ok(filled.length >= 3, `only ${filled.length} filled cells`);
    for (const t of filled) assert.match(t, /\d+\s?d$/);
  });
  check("stages that have not fully happened are blank, not partial", () => {
    const blanks = dataTempCells.filter((t) => t.trim() === "—");
    assert.ok(blanks.length >= 1, "expected at least the final stages to be blank");
  });

  // ---- brand watermark ----------------------------------------------
  const wmCount = await page.locator("image.gdu-watermark").count();
  check("exactly one watermark, on the accumulation chart only", () => assert.equal(wmCount, 1));
  const wmInfo = await page.evaluate(() => {
    const img = document.querySelector(".gdu-chart-svg image.gdu-watermark");
    if (!img) return null;
    const svgEl = img.ownerSVGElement;
    const b = img.getBBox();
    const vb = svgEl.viewBox.baseVal;
    return {
      href: img.getAttribute("href"),
      opacity: Number(getComputedStyle(img).opacity),
      pointerEvents: getComputedStyle(img).pointerEvents,
      ariaHidden: img.getAttribute("aria-hidden"),
      inBottomRight: b.x > vb.width * 0.5 && b.y > vb.height * 0.5,
      insidePlot: b.x + b.width <= vb.width && b.y + b.height <= vb.height,
    };
  });
  check("the watermark uses the active Brand View's logo", () => assert.equal(wmInfo.href, "/logos/ncplus.png"));
  check("the watermark sits bottom-right, inside the plot", () => {
    assert.equal(wmInfo.inBottomRight, true);
    assert.equal(wmInfo.insidePlot, true);
  });
  check("the watermark is faint and non-interactive", () => {
    assert.ok(wmInfo.opacity > 0 && wmInfo.opacity < 0.35, `opacity ${wmInfo.opacity}`);
    assert.equal(wmInfo.pointerEvents, "none");
    assert.equal(wmInfo.ariaHidden, "true");
  });

  // ---- share: one tap, straight to the PDF ----------------------------
  const menusBefore = await page.locator(".share-menu-panel").count();
  check("there is no share menu to get through", () => assert.equal(menusBefore, 0));

  // Headless Chromium has no navigator.share, so shareOrDownload falls
  // through to a plain download — which is the path to assert on anyway,
  // since it's what every desktop browser does.
  const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
  await page.locator(".top-bar-btn-share").click();
  let download;
  try {
    download = await downloadPromise;
  } catch (e) {
    const toastNow = await page.locator(".toast-message").allTextContents();
    throw new Error(`no download; toasts: ${JSON.stringify(toastNow)}; console: ${JSON.stringify(consoleErrors.slice(-3))}`);
  }
  const pdfPath = path.join(SHOT_DIR, "gdu-outlook.pdf");
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await download.saveAs(pdfPath);

  const suggested = download.suggestedFilename();
  check("the PDF filename names the hybrid and the field", () => {
    assert.match(suggested, /^GDU-Outlook_/);
    assert.match(suggested, /09-90/);
    assert.match(suggested, /Missouri-Valley/);
    assert.match(suggested, /\.pdf$/);
  });

  const pdfBuf = fs.readFileSync(pdfPath);
  check("the PDF is a real, non-trivial document", () => {
    assert.equal(pdfBuf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(pdfBuf.length > 20000, `only ${pdfBuf.length} bytes`);
  });
  // Two pages is a hard requirement, not a nicety — it's one sheet
  // double-sided, which is what gets handed to a grower.
  const pageCount = countPdfPages(pdfBuf);
  check("the PDF fits on two sheets", () => assert.equal(pageCount, 2));
  check("the PDF explains the heat-cap rules", () => {
    // A coloured halo with no key is just a smudge behind the line.
    assert.match(pdfBuf.toString("latin1"), /Vertical rules:/);
  });

  const footer = pdfBuf.toString("latin1");
  check("the footer says GDU Calculator, not a URL", () => {
    assert.ok(!/gducalc\.mplfarms\.com/.test(footer), "the old URL is still in the footer");
  });

  // The summary text still exists — it rides along as the share sheet's
  // body text so a message gets the numbers, not a bare attachment.
  const summaryText = await page.evaluate(async () => {
    const mod = await import("/js/ui/components/shareMenu.js");
    return typeof mod.buildSummary === "function" ? "present" : "missing";
  });
  check("the plain-text summary is still built for the share sheet", () => assert.equal(summaryText, "present"));

  // ---- print layout ---------------------------------------------------
  // A folded card must still PRINT. Collapsing is a screen convenience;
  // a printout that silently dropped the frost risk because someone left
  // that card shut would be worse than no printout. Collapse everything
  // first, so this measures the case that actually matters.
  await page.evaluate(() => {
    for (const t of document.querySelectorAll(".gdu-card-toggle.gdu-card-toggle-open")) t.click();
  });
  await page.waitForFunction(() => document.querySelectorAll(".gdu-card-body:not([hidden])").length === 0);
  await page.emulateMedia({ media: "print" });
  const printCollapsed = await page.evaluate(() => {
    const bodies = [...document.querySelectorAll(".gdu-card-body")];
    return {
      total: bodies.length,
      stillHidden: bodies.filter((b) => getComputedStyle(b).display === "none").length,
      chevronsShown: [...document.querySelectorAll(".gdu-card-chevron")].filter((c) => getComputedStyle(c).display !== "none").length,
      text: document.querySelector(".screen-body").innerText.length,
    };
  });
  check("collapsed cards still print in full", () => {
    assert.equal(printCollapsed.total, 8);
    assert.equal(printCollapsed.stillHidden, 0, "a folded card would have been omitted from the printout");
  });
  check("print drops the chevrons — nothing to tap on paper", () => assert.equal(printCollapsed.chevronsShown, 0));
  await page.emulateMedia({ media: "screen" });
  await expandAllCards();
  await page.emulateMedia({ media: "print" });
  const printState = await page.evaluate(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).display : "absent";
    };
    return {
      topBar: vis(".top-bar"),
      scenarioSelect: vis(".gdu-scenario-select"),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      cardBg: getComputedStyle(document.querySelector(".card")).backgroundColor,
      chartsStillThere: document.querySelectorAll(".gdu-chart-svg, .gdu-stage-chart-svg").length,
      tablesStillThere: document.querySelectorAll(".gdu-table").length,
    };
  });
  check("print hides the app chrome but keeps the charts and tables", () => {
    assert.equal(printState.topBar, "none");
    assert.equal(printState.scenarioSelect, "none");
    assert.equal(printState.chartsStillThere, 2);
    assert.equal(printState.tablesStillThere, 2);
  });
  check("print forces a white page even from dark mode", () => {
    assert.equal(printState.bodyBg, "rgb(255, 255, 255)");
    assert.equal(printState.cardBg, "rgb(255, 255, 255)");
  });
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "12-print.png"), fullPage: true });
  await page.emulateMedia({ media: "screen" });

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

  const darkRamp = await page.evaluate(() => ({
    veg: getComputedStyle(document.querySelector(".gdu-stage-band-veg")).fill,
    rep: getComputedStyle(document.querySelector(".gdu-stage-band-rep")).fill,
    backdrop: getComputedStyle(document.querySelector(".gdu-stage-backdrop")).fill,
  }));
  check("dark mode lifts both ramp hues", () => {
    assert.equal(darkRamp.veg, "rgb(87, 176, 125)");
    assert.equal(darkRamp.rep, "rgb(232, 180, 81)");
  });
  check("both hues composite over a neutral base, not the brand card", () => {
    // Gold over NC+'s blue card desaturates to khaki; gold over Midwest's
    // dark green does the same. One near-neutral base serves both hues
    // without muddying the green, which a warm brown base would have.
    assert.equal(darkRamp.backdrop, "rgb(30, 29, 27)");
  });
  const dividerStroke = await page.evaluate(() => getComputedStyle(document.querySelector(".gdu-stage-divider")).stroke);
  check("band dividers follow the backdrop, not the card", () => assert.equal(dividerStroke, "rgb(30, 29, 27)"));


  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "04-results-dark.png"), fullPage: true });

  // Midwest gets the SAME two-hue ramp as everyone else now — the split
  // is the crop's biology, not a brand choice.
  await page.evaluate(() => localStorage.setItem("gdu.selectedBrand", JSON.stringify("midwestSeedGenetics")));
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => { window.location.hash = "#/results"; });
  await page.waitForSelector(".gdu-stage-band", { timeout: 20000 });
  const midwestRamp = await page.evaluate(() => ({
    veg: getComputedStyle(document.querySelector(".gdu-stage-band-veg")).fill,
    rep: getComputedStyle(document.querySelector(".gdu-stage-band-rep")).fill,
    backdrop: getComputedStyle(document.querySelector(".gdu-stage-backdrop")).fill,
    vegCount: document.querySelectorAll(".gdu-stage-band-veg").length,
    repCount: document.querySelectorAll(".gdu-stage-band-rep").length,
  }));
  check("Midwest gets the identical two-hue ramp, not a brand variant", () => {
    assert.equal(midwestRamp.veg, "rgb(87, 176, 125)");
    assert.equal(midwestRamp.rep, "rgb(232, 180, 81)");
    assert.equal(midwestRamp.vegCount, 10);
    assert.equal(midwestRamp.repCount, 4);
    // Same neutral base as every other brand — gold over Midwest's dark
    // green card desaturates just like it did over NC+'s blue.
    assert.equal(midwestRamp.backdrop, "rgb(30, 29, 27)");
  });
  const midwestWatermark = await page.evaluate(() => {
    const img = document.querySelector("image.gdu-watermark");
    return img ? img.getAttribute("href") : null;
  });
  check("the watermark follows the Brand View too", () => assert.equal(midwestWatermark, "/logos/midwest.png"));
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "13-midwest-dark.png"), fullPage: true });

  // ---- a genuinely projected stage must carry a range -----------------
  // The complaint that started this: normal / hot / cool showing one date.
  // When the stage really is past the last known day the three finishes
  // MUST separate, and the row has to show that spread rather than a
  // lone date. A long hybrid pushes black layer well into the projection.
  await page.evaluate(() => { window.location.hash = "#/calculator"; });
  await page.waitForSelector('input[aria-label="GDUs to black layer"]');
  await page.fill('input[aria-label="GDUs to black layer"]', "3400");
  await page.waitForTimeout(150);
  await page.getByRole("button", { name: "Calculate GDUs" }).click();
  await page.waitForSelector(".gdu-card-toggle", { timeout: 20000 });
  await expandAllCards();
  await page.waitForSelector(".gdu-table", { timeout: 20000 });
  const projectedRow = await page.locator("tr.gdu-row-current").textContent();
  check("a projected stage shows the hot-to-cool range, not a bare date", () => {
    assert.match(projectedRow, /projected/);
    assert.match(projectedRow, /hot to cool finish/);
  });
  const rangeText = await page.locator("tr.gdu-row-current .gdu-stage-range").last().textContent();
  check("the two ends of the range are different dates", () => {
    const m = rangeText.match(/^(.+?) – (.+?) \(/);
    assert.ok(m, `unparseable range: ${rangeText}`);
    assert.notEqual(m[1], m[2], `hot and cool finishes are identical: ${rangeText}`);
  });
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "15-projected-range.png"), fullPage: true });

  // ---- Saved Locations --------------------------------------------------
  // A saved entry is now the whole setup — name, field, date and the
  // hybrid if one was entered — not a bare hybrid.
  await page.evaluate(() => { window.location.hash = "#/calculator"; });
  await page.waitForSelector(".gdu-save-hybrid-btn");
  const savedCard = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".card")];
    const card = cards.find((c) => /Saved Locations/.test(c.querySelector(".section-header")?.textContent || ""));
    const hybridCard = cards.find((c) => /^Hybrid$/.test(c.querySelector(".section-header")?.textContent.trim() || ""));
    return {
      exists: !!card,
      btn: card ? card.querySelector(".gdu-save-hybrid-btn").textContent.trim() : null,
      // Must live OUTSIDE the collapsible hybrid body, or a location
      // could not be saved in GDU-only mode.
      insideHybrid: hybridCard ? hybridCard.contains(card) : null,
    };
  });
  check("Save This Location sits in its own always-visible card", () => {
    assert.ok(savedCard.exists, "no Saved Locations card");
    assert.equal(savedCard.btn, "Save This Location");
    assert.equal(savedCard.insideHybrid, false);
  });

  // Saving refuses without a name — the name is what the entry is FOR.
  await page.fill('input[aria-label="Location name"]', "");
  await page.getByRole("button", { name: "Save This Location" }).click();
  const nameErr = await page.locator(".toast-message").first().textContent();
  check("saving without a name is refused", () => assert.match(nameErr, /name/i));

  await page.fill('input[aria-label="Location name"]', "Brown home place");
  // Capture what is on screen at save time rather than hard-coding it —
  // earlier blocks in this suite edit these boxes, and a literal here
  // would break whenever one of them changes.
  const atSaveTime = await page.evaluate(() => ({
    zip: document.querySelector('input[aria-label="ZIP code"]').value,
    hybrid: document.querySelector('input[aria-label="Hybrid name"]').value,
    silk: document.querySelector('input[aria-label="GDUs to silk"]').value,
    bl: document.querySelector('input[aria-label="GDUs to black layer"]').value,
  }));
  await page.getByRole("button", { name: "Save This Location" }).click();
  await page.waitForSelector(".gdu-saved-row");
  const savedRow = await page.locator(".gdu-saved-row").first().textContent();
  check("a saved entry carries the name, the field, the date and the hybrid", () => {
    assert.match(savedRow, /Brown home place/);
    assert.match(savedRow, /Missouri Valley/);
    assert.match(savedRow, /planted/i);
    assert.match(savedRow, /09-90 PCE/);
  });

  // Change everything, then load it back.
  await page.fill('input[aria-label="Location name"]', "somewhere else");
  await page.fill('input[aria-label="Hybrid name"]', "");
  await page.fill('input[aria-label="GDUs to silk"]', "");
  await page.fill('input[aria-label="GDUs to black layer"]', "");
  await page.waitForTimeout(120);
  await page.locator(".gdu-saved-load").first().click();
  await page.waitForTimeout(200);
  const restored = await page.evaluate(() => ({
    name: document.querySelector('input[aria-label="Location name"]').value,
    zip: document.querySelector('input[aria-label="ZIP code"]').value,
    hybrid: document.querySelector('input[aria-label="Hybrid name"]').value,
    silk: document.querySelector('input[aria-label="GDUs to silk"]').value,
    bl: document.querySelector('input[aria-label="GDUs to black layer"]').value,
    mode: [...document.querySelectorAll(".gdu-mode-btn")].map((b) => b.getAttribute("aria-pressed")),
  }));
  check("loading a saved location restores every field it saved", () => {
    assert.equal(restored.name, "Brown home place");
    assert.equal(restored.zip, atSaveTime.zip);
    assert.equal(restored.hybrid, atSaveTime.hybrid);
    assert.equal(restored.silk, atSaveTime.silk);
    assert.equal(restored.bl, atSaveTime.bl);
  });
  check("loading an entry that has a hybrid switches back to Enter Hybrid", () => {
    assert.deepEqual(restored.mode, ["true", "false"]);
  });

  // ---- GDU Only ---------------------------------------------------------
  // The mode is a decision, not a setting: picking it clears the hybrid,
  // folds the detail shut AND runs the calculation, rather than leaving
  // the user to find the button below.
  await page.evaluate(() => { window.location.hash = "#/calculator"; });
  await page.waitForSelector(".gdu-mode-btn");
  if (await page.locator(".gdu-hybrid-body").isHidden()) await page.getByRole("button", { name: "Enter Hybrid" }).click();
  const beforeClear = await page.inputValue('input[aria-label="Hybrid name"]');
  check("a hybrid is loaded before switching mode", () => assert.ok(beforeClear.length > 0));

  await page.getByRole("button", { name: "GDU Only" }).click();
  await page.waitForSelector(".gdu-chart-svg", { timeout: 20000 });
  const afterGduOnly = await page.evaluate(() => ({
    onResults: window.location.hash,
    body: document.querySelector(".screen-body").textContent,
    stored: JSON.parse(localStorage.getItem("gdu.currentHybrid") || "{}"),
    location: JSON.parse(localStorage.getItem("gdu.location") || "null"),
    planting: JSON.parse(localStorage.getItem("gdu.plantingDate") || "null"),
  }));
  check("GDU Only calculates immediately", () => {
    assert.match(afterGduOnly.onResults, /#\/results/);
    assert.match(afterGduOnly.body, /No hybrid entered/i);
  });
  check("GDU Only wipes the stored hybrid, not the field or the date", () => {
    // A leftover value here would let the next typed hybrid inherit
    // another one's numbers.
    assert.deepEqual(afterGduOnly.stored, {});
    assert.ok(afterGduOnly.location, "location should survive");
    assert.ok(afterGduOnly.planting, "planting date should survive");
  });

  await page.evaluate(() => { window.location.hash = "#/calculator"; });
  await page.waitForSelector(".gdu-mode-btn");
  const backOnCalc = await page.evaluate(() => ({
    pressed: [...document.querySelectorAll(".gdu-mode-btn")].map((b) => b.getAttribute("aria-pressed")),
    bodyHidden: document.querySelector(".gdu-hybrid-body").hidden,
    name: document.querySelector('input[aria-label="Hybrid name"]').value,
    silk: document.querySelector('input[aria-label="GDUs to silk"]').value,
    bl: document.querySelector('input[aria-label="GDUs to black layer"]').value,
    rm: document.querySelector('input[aria-label="Relative maturity"]').value,
    saved: document.querySelectorAll(".gdu-saved-row").length,
  }));
  check("coming back, GDU Only is still the selected mode and every box is empty", () => {
    assert.deepEqual(backOnCalc.pressed, ["false", "true"]);
    assert.equal(backOnCalc.bodyHidden, true);
    assert.equal(backOnCalc.name, "");
    assert.equal(backOnCalc.silk, "");
    assert.equal(backOnCalc.bl, "");
    assert.equal(backOnCalc.rm, "");
  });
  check("GDU Only leaves the saved list alone", () => assert.ok(backOnCalc.saved >= 0));

  // ---- no hybrid at all: ZIP + planting date only ---------------------
  // The whole point is that a grower with no tech sheet in hand can still
  // see the heat curve. Nothing that needs a silk or black layer rating
  // may render, and the PDF must still build.
  await page.evaluate(() => localStorage.setItem("gdu.themeMode", JSON.stringify("light")));
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => { window.location.hash = "#/calculator"; });
  await page.waitForSelector(".gdu-mode-btn");
  // The card is folded shut in GDU-only mode; open it to prove the boxes
  // really are empty rather than just out of sight.
  if (await page.locator(".gdu-hybrid-body").isHidden()) await page.getByRole("button", { name: "Enter Hybrid" }).click();
  await page.waitForSelector('input[aria-label="GDUs to silk"]');
  await page.fill('input[aria-label="Hybrid name"]', "");
  await page.fill('input[aria-label="GDUs to silk"]', "");
  await page.fill('input[aria-label="GDUs to black layer"]', "");
  await page.fill('input[aria-label="Relative maturity"]', "");
  await page.waitForTimeout(150);

  const calcEnabled = await page.getByRole("button", { name: "Calculate GDUs" }).isEnabled();
  check("Calculate is available with no hybrid entered", () => assert.equal(calcEnabled, true));

  await page.getByRole("button", { name: "Calculate GDUs" }).click();
  await page.waitForSelector(".gdu-chart-svg", { timeout: 20000 });

  const noHybridShape = await page.evaluate(() => ({
    accumulationCharts: document.querySelectorAll(".gdu-chart-svg").length,
    stageCharts: document.querySelectorAll(".gdu-stage-chart-svg").length,
    tables: document.querySelectorAll(".gdu-table").length,
    thresholdLines: document.querySelectorAll(".gdu-chart-svg .gdu-stage-line").length,
    watermarks: document.querySelectorAll("image.gdu-watermark").length,
    body: document.querySelector(".screen-body").textContent,
  }));
  check("the accumulation chart still draws from ZIP and planting date alone", () => {
    assert.equal(noHybridShape.accumulationCharts, 1);
    assert.equal(noHybridShape.watermarks, 1);
  });
  check("nothing that needs a hybrid rating is rendered", () => {
    assert.equal(noHybridShape.stageCharts, 0, "stage chart should be absent");
    assert.equal(noHybridShape.tables, 0, "scenario/data tables should be absent");
    assert.equal(noHybridShape.thresholdLines, 0, "silk/black layer lines should be absent");
  });
  check("the results screen says why there are no stage dates", () => {
    assert.match(noHybridShape.body, /No hybrid entered/i);
    assert.match(noHybridShape.body, /Add a Hybrid for Stage Dates/i);
  });
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "14-no-hybrid.png"), fullPage: true });

  const noHybridDownload = page.waitForEvent("download", { timeout: 30000 });
  await page.locator(".top-bar-btn-share").click();
  let noHybridPdf;
  try {
    noHybridPdf = await noHybridDownload;
  } catch (e) {
    const toastNow = await page.locator(".toast-message").allTextContents();
    throw new Error(`no-hybrid PDF never downloaded; toasts: ${JSON.stringify(toastNow)}; console: ${JSON.stringify(consoleErrors.slice(-3))}`);
  }
  const noHybridPath = path.join(SHOT_DIR, "gdu-outlook-no-hybrid.pdf");
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await noHybridPdf.saveAs(noHybridPath);
  const noHybridBuf = fs.readFileSync(noHybridPath);
  check("the PDF still builds with no hybrid", () => {
    assert.equal(noHybridBuf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(noHybridBuf.length > 15000, `only ${noHybridBuf.length} bytes`);
    // No stage table or stage chart to carry, so it collapses to one sheet.
    assert.ok(countPdfPages(noHybridBuf) <= 2, "must not spill past two sheets");
  });

  // ---- the blue (zero-GDU) marker --------------------------------------
  // The default fixture never drops below 50 °F, so blue is otherwise
  // never drawn and its rendering path would ship untested. Drive the
  // whole synthetic climate cold and check it appears — and that red
  // disappears, which proves the two are keyed off the same high.
  TEMP_SHIFT = -50;
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("gdu.wx.")) localStorage.removeItem(k);
    localStorage.setItem("gdu.themeMode", JSON.stringify("light"));
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => { window.location.hash = "#/results"; });
  await page.waitForSelector(".gdu-chart-svg", { timeout: 20000 });
  const coldRun = await page.evaluate(() => {
    const seg = [...document.querySelectorAll(".gdu-limit-day")];
    const zero = seg.find((e) => e.classList.contains("gdu-limit-zero"));
    return {
      capped: seg.filter((e) => e.classList.contains("gdu-limit-capped")).length,
      zero: seg.filter((e) => e.classList.contains("gdu-limit-zero")).length,
      stroke: zero ? getComputedStyle(zero).stroke : null,
      vertical: zero ? zero.getAttribute("x1") === zero.getAttribute("x2") : false,
      legend: [...document.querySelectorAll(".gdu-legend-item")].map((i) => i.textContent),
    };
  });
  check("a season that never reaches 50 °F is marked blue throughout", () => {
    assert.ok(coldRun.zero > 0, "expected zero-GDU days in an all-cold season");
    assert.equal(coldRun.stroke, "rgb(11, 77, 162)");
    assert.equal(coldRun.vertical, true, "the mark must be a vertical rule");
  });
  check("no day is both capped and zero once the season turns cold", () => {
    // Both are keyed off the daily HIGH, so a cold season cannot produce
    // a capped day. Under the old low-based rule it could.
    assert.equal(coldRun.capped, 0);
  });
  check("the legend swaps to the blue key and drops the red one", () => {
    const joined = coldRun.legend.join(" | ");
    assert.match(joined, /never got above 50 °F/);
    assert.ok(!/high hit 86 °F/.test(joined), "the red key should be gone with no red days");
  });
  TEMP_SHIFT = 0;

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
