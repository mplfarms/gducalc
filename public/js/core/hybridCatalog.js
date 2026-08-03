// src/core/hybridCatalog.js
//
// The built-in hybrid list: variety, relative maturity, GDUs to silk,
// GDUs to black layer. Loaded once from /data/hybrids.json (a static
// asset in the service worker's precache list, so it works offline after
// the first visit — same pattern as the Corn Plot app's counties/cityZips
// data, and for the same reason: this gets used in places without signal).
//
// Values are reproduced EXACTLY as supplied on the grower's own sheet.
// Nothing here derives, interpolates, smooths or sanity-corrects a GDU
// rating from relative maturity — a hybrid that breaks the usual
// RM-to-GDU pattern is a real thing, and quietly "fixing" one would be
// worse than showing it. The one thing this module will do is TELL you
// when a rating is unusual for its maturity (see rmOutlierNote), so a
// person can double-check it against the tech sheet; it never changes
// the number.
//
// Variety names are shown verbatim, with no Brand View prefix applied —
// per explicit request. The Brand View themes the app; it does not
// relabel hybrids here the way Corn Plot Harvest's Plot Summary does.

const CATALOG_URL = "/data/hybrids.json";

/** @typedef {{variety: string, rm: number, gduToSilk: number, gduToBlackLayer: number}} CatalogHybrid */

/** @type {CatalogHybrid[]} */
let hybrids = [];
let loadPromise = null;
let loadFailed = false;

/**
 * Fetches the catalog once. Safe to call from anywhere, any number of
 * times — subsequent calls get the same in-flight/settled promise.
 *
 * Never throws. A failure leaves the list empty, which the UI presents
 * as "catalog unavailable, enter the numbers manually" rather than as an
 * error — manual entry has always been the primary path, the catalog is
 * a shortcut.
 * @returns {Promise<void>}
 */
export function ensureLoaded() {
  if (loadPromise) return loadPromise;
  loadPromise = fetch(CATALOG_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((doc) => {
      hybrids = (doc && Array.isArray(doc.hybrids) ? doc.hybrids : [])
        .map((row) => ({
          variety: String(row.v || "").trim(),
          rm: Number(row.rm),
          gduToSilk: Number(row.s),
          gduToBlackLayer: Number(row.b),
        }))
        // A malformed row is dropped rather than shown with a NaN or a
        // reversed pair — the app's own validation would reject it at
        // Calculate time anyway, and a bad row in a picker is a trap.
        .filter((x) => x.variety && Number.isFinite(x.rm) && Number.isFinite(x.gduToSilk) && Number.isFinite(x.gduToBlackLayer) && x.gduToSilk < x.gduToBlackLayer)
        .sort((a, b) => a.rm - b.rm || a.variety.localeCompare(b.variety));
    })
    .catch((e) => {
      loadFailed = true;
      console.error("[hybridCatalog] failed to load", e);
    });
  return loadPromise;
}

/** @returns {CatalogHybrid[]} */
export function getAll() {
  return hybrids;
}

export function isAvailable() {
  return hybrids.length > 0;
}

export function didFail() {
  return loadFailed;
}

/** @param {string} variety @returns {CatalogHybrid|null} */
export function findByVariety(variety) {
  const key = String(variety || "").trim().toLowerCase();
  if (!key) return null;
  return hybrids.find((x) => x.variety.toLowerCase() === key) || null;
}

/**
 * Case-insensitive substring search across the variety name and the RM,
 * so typing "109" finds both the RM-109 hybrids and anything with 109 in
 * its number, and typing "PCE" finds the whole PCE trait family.
 * @param {string} query
 * @returns {CatalogHybrid[]}
 */
export function search(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return hybrids;
  return hybrids.filter((x) => x.variety.toLowerCase().includes(q) || String(x.rm).includes(q));
}

/**
 * Flags a hybrid whose GDU-to-black-layer rating is far off what the
 * rest of the catalog shows for its relative maturity.
 *
 * This is a "look twice" prompt, not a correction. RM and GDU measure
 * related but different things and a genuine outlier exists in most
 * lineups, so the threshold is deliberately loose: it only fires when a
 * hybrid sits more than 250 GDU away from the median of everything
 * within 2 RM days of it, and only when there are at least three other
 * hybrids in that window to compare against.
 *
 * @param {CatalogHybrid|null} hybrid
 * @returns {string|null} a sentence to show, or null when nothing's odd
 */
export function rmOutlierNote(hybrid) {
  if (!hybrid) return null;
  const neighbors = hybrids.filter((x) => x.variety !== hybrid.variety && Math.abs(x.rm - hybrid.rm) <= 2);
  if (neighbors.length < 3) return null;
  const values = neighbors.map((x) => x.gduToBlackLayer).sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  const delta = hybrid.gduToBlackLayer - median;
  if (Math.abs(delta) <= 250) return null;
  return `Heads up: at ${hybrid.gduToBlackLayer.toLocaleString()} GDU to black layer, ${hybrid.variety} sits ${Math.abs(Math.round(delta)).toLocaleString()} GDU ${delta > 0 ? "above" : "below"} the ${Math.round(median).toLocaleString()} median of other ${hybrid.rm - 2}–${hybrid.rm + 2} day hybrids in this list. The value is loaded exactly as supplied — worth a second look against the tech sheet before you lean on it.`;
}
