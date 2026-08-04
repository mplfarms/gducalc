// GDU Calculator service worker.
//
// Cache-first for the app shell so the app opens instantly and survives
// a dead signal; NETWORK-ONLY for cross-origin requests, with exactly
// one allowance.
//
// The network-only rule matters because nearly every cross-origin
// request this app makes is a weather query whose whole value is being
// current — caching an Open-Meteo response here would mean silently
// serving yesterday's accumulation with no way for the user to tell.
// Weather caching happens one layer up instead, in weather.js's
// localStorage cache, which is explicitly dated (it expires at the end
// of the calendar day it was fetched), is surfaced in the UI ("cached
// earlier today"), and can be cleared from Settings.
//
// The allowance is the pinned jsPDF bundle (see ui/pdfLibLoader.js).
// It's an immutable versioned URL, so "stale" is not a state it can be
// in, and caching it is what makes a second PDF export work with no
// signal — which is the whole point of exporting one from a field.

const JSPDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";

const CACHE_VERSION = "v2.1-beta";
const CACHE_NAME = `gdu-calculator-${CACHE_VERSION}`;

// Enumerated app shell — the Cache API has no wildcard support, so this
// list has to be kept in step with the actual contents of public/.
// Cross-check with: find public -type f -not -path '*/data/*'
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/css/styles.css",
  "/css/gdu.css",

  "/data/hybrids.json",

  "/js/main.js",
  "/js/version.js",

  "/js/core/dates.js",
  "/js/core/gdu.js",
  "/js/core/season.js",
  "/js/core/weather.js",
  "/js/core/location.js",
  "/js/core/hybridCatalog.js",
  "/js/core/stages.js",
  "/js/core/hybridEstimate.js",
  "/js/core/pdfBuilder.js",

  "/js/ui/brand.js",
  "/js/ui/chart.js",
  "/js/ui/stageChart.js",
  "/js/ui/dom.js",
  "/js/ui/router.js",
  "/js/ui/theme.js",
  "/js/ui/fileSave.js",
  "/js/ui/logoCache.js",
  "/js/ui/pdfLibLoader.js",

  "/js/ui/components/datePicker.js",
  "/js/ui/components/hybridPicker.js",
  "/js/ui/components/shareMenu.js",
  "/js/ui/components/modal.js",
  "/js/ui/components/toast.js",
  "/js/ui/components/topBar.js",

  "/js/ui/screens/brandSelect.js",
  "/js/ui/screens/calculator.js",
  "/js/ui/screens/help.js",
  "/js/ui/screens/results.js",
  "/js/ui/screens/settings.js",

  "/js/ui/stores/brandStore.js",
  "/js/ui/stores/inputStore.js",
  "/js/ui/stores/pubsub.js",
  "/js/ui/stores/themeStore.js",

  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-512-maskable.png",
  "/logos/midwest.png",
  "/logos/ncplus.png",
  "/logos/crows.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // addAll() is all-or-nothing: one 404 in the list above would
      // leave the app with NO precache at all. Adding them individually
      // means a mistyped path costs one uncached file, not the feature.
      Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((e) => {
            console.warn("[sw] precache miss", url, e);
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("gdu-calculator-") && k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    // Weather, ZIP lookup, reverse geocode — always live. See the header.
    if (req.url !== JSPDF_URL) return;
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match("/index.html"));
    })
  );
});
