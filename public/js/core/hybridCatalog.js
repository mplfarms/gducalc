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
 *
 * A FAILED load is not memoized. This app is used in field approaches
 * where the first load lands with no signal; caching the rejection meant
 * the picker stayed permanently empty for the life of the page even
 * after the phone reconnected, and the only cure was a hard reload the
 * user had no reason to think of. A success is still memoized, so the
 * normal path is unchanged and the file is never fetched twice.
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
      loadFailed = false;
    })
    .catch((e) => {
      loadFailed = true;
      // Clear the memo so the NEXT call retries. Without this the first
      // failure is permanent for the page's lifetime.
      loadPromise = null;
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
/**
 * Leading rebadge code, if present. The list is stored brand-neutral
 * ("09-90 PCE") but the app displays and stores it under the active
 * Brand View's code ("NC 09-90 PCE"), so every lookup has to see past
 * that prefix or a picked hybrid would stop matching its own list entry
 * the moment it was branded.
 *
 * Only these three exact codes are stripped. A competitor variety that
 * happens to start with two letters and a space is left alone.
 *
 * The trailing group matches whitespace OR end-of-string, and the match
 * runs BEFORE the trim. Both matter for search-as-you-type: a user who
 * has typed "NC " and no more should see the whole list, not nothing.
 * Trimming first turned "NC " into "NC", which then failed the \s+ and
 * was searched as the literal substring "nc" — a query that matches no
 * variety in the list, so the picker went blank at exactly the moment
 * the user was about to type the number.
 */
const REBADGE_CODE_RE = /^(?:MW|NC|CR)(?:\s+|$)/i;

/** Strips a leading Brand View code from a variety name. */
export function bareVariety(variety) {
  return String(variety || "").replace(/^\s+/, "").replace(REBADGE_CODE_RE, "").trim();
}

export function findByVariety(variety) {
  const key = bareVariety(variety).toLowerCase();
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
  // Searching "NC 09-90" has to work as well as "09-90" — the code is
  // what the user sees on screen, so it is what they will type.
  const q = bareVariety(query).toLowerCase();
  if (!q) return hybrids;
  return hybrids.filter((x) => x.variety.toLowerCase().includes(q) || String(x.rm).includes(q));
}

/**
 * Flags a hybrid whose GDU rating is far off what the rest of the
 * catalog shows for its relative maturity.
 *
 * This is a "look twice" prompt, not a correction. RM and GDU measure
 * related but different things and a genuine outlier exists in most
 * lineups, so the threshold is deliberately loose: it only fires when a
 * hybrid sits more than 250 GDU (black layer) or 150 GDU (silk) away
 * from the median of everything within 2 RM days of it.
 *
 * Three things the first version of this got wrong, all of which made it
 * fire — or stay silent — for reasons that had nothing to do with the
 * hybrid:
 *
 * 1. REBADGED DUPLICATES WERE COUNTED SEPARATELY. The list carries the
 *    same genetics under more than one trait suffix, identical RM, silk
 *    and black layer. Three copies of one hybrid satisfied the
 *    "at least three neighbors" bar and dragged the median onto their
 *    own shared value, so the comparison was against one observation
 *    wearing three name tags. Neighbors are now deduped on the
 *    (rm, silk, black layer) triple.
 *
 * 2. THE WINDOW WENT ONE-SIDED AT THE ENDS. At RM 77 — the shortest in
 *    the list — every neighbor is longer, so the median sits above the
 *    hybrid by construction and the shortest hybrids got flagged for
 *    being short. The check now requires at least one neighbor on each
 *    side before it will speak.
 *
 * 3. SILK WAS NEVER CHECKED. A transposed silk rating drives every
 *    vegetative stage date in the app and sailed through untouched.
 *
 * @param {CatalogHybrid|null} hybrid
 * @param {CatalogHybrid[]} [list] the catalog to compare against; defaults
 *        to the loaded one. Exists so the test suite can drive this
 *        function itself instead of reimplementing the rule beside it —
 *        the old test carried its own copy of the median-and-threshold
 *        logic, which meant the two could drift apart and the test would
 *        keep passing while the app did something else.
 * @returns {string|null} a sentence to show, or null when nothing's odd
 */
export function rmOutlierNote(hybrid, list = hybrids) {
  if (!hybrid) return null;

  const inWindow = list.filter((x) => x.variety !== hybrid.variety && Math.abs(x.rm - hybrid.rm) <= 2);

  // Collapse rebadges: same RM and same two GDU numbers is the same
  // hybrid as far as this comparison is concerned, however many trait
  // suffixes it ships under.
  const seen = new Set();
  const neighbors = [];
  for (const x of inWindow) {
    const key = `${x.rm}|${x.gduToSilk}|${x.gduToBlackLayer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    neighbors.push(x);
  }
  if (neighbors.length < 3) return null;

  // Both sides, or the median is just "the rest of the list is longer".
  if (!neighbors.some((x) => x.rm < hybrid.rm) || !neighbors.some((x) => x.rm > hybrid.rm)) return null;

  const windowLabel = `${hybrid.rm - 2}–${hybrid.rm + 2} day hybrids in this list`;

  // Black layer first — it drives the whole back half of the season, so
  // if both are off it is the one worth naming.
  const bl = outlierDelta(neighbors, hybrid, "gduToBlackLayer", 250);
  if (bl) return outlierSentence(hybrid, "GDU to black layer", hybrid.gduToBlackLayer, bl, windowLabel);

  const silk = outlierDelta(neighbors, hybrid, "gduToSilk", 150);
  if (silk) return outlierSentence(hybrid, "GDU to silk", hybrid.gduToSilk, silk, windowLabel);

  return null;
}

/** @returns {{delta: number, median: number}|null} */
function outlierDelta(neighbors, hybrid, field, threshold) {
  const values = neighbors.map((x) => x[field]).sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  const delta = hybrid[field] - median;
  return Math.abs(delta) <= threshold ? null : { delta, median };
}

function outlierSentence(hybrid, what, value, { delta, median }, windowLabel) {
  return `Heads up: at ${value.toLocaleString()} ${what}, ${hybrid.variety} sits ${Math.abs(Math.round(delta)).toLocaleString()} GDU ${delta > 0 ? "above" : "below"} the ${Math.round(median).toLocaleString()} median of other ${windowLabel}. The value is loaded exactly as supplied — worth a second look against the tech sheet before you lean on it.`;
}
