// src/ui/pdfLibLoader.js
//
// Loads jsPDF on demand rather than on every page load.
//
// Corn Plot Harvest pulls jsPDF in with a <script defer> tag in its HTML.
// This app doesn't, deliberately: the PDF is one action on one screen,
// and a ~350 KB library has no business being fetched by someone who
// opened the app in a pickup to check a silk date. It's injected the
// first time someone asks for a PDF, and the service worker caches it
// cache-first from then on (see the CDN allowance in sw.js), so the
// second export works with no signal at all.
//
// Pinned to an exact version — a floating "latest" URL would mean an
// upstream release could change the output of a report someone printed
// last week, and it would defeat the immutable-cache assumption sw.js
// makes.

export const JSPDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";

/** @type {Promise<any>|null} */
let loadPromise = null;

/**
 * @returns {Promise<any>} the jsPDF constructor
 */
export function loadJsPdf() {
  if (typeof window !== "undefined" && window.jspdf && window.jspdf.jsPDF) {
    return Promise.resolve(window.jspdf.jsPDF);
  }
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = JSPDF_URL;
    script.async = true;
    script.onload = () => {
      if (window.jspdf && window.jspdf.jsPDF) resolve(window.jspdf.jsPDF);
      else reject(new Error("PDF library loaded but didn't register itself"));
    };
    script.onerror = () => {
      // Let a later attempt retry rather than caching the failure — the
      // usual cause is no signal, which is temporary.
      loadPromise = null;
      reject(new Error("Couldn't load the PDF library — check your connection"));
    };
    document.head.appendChild(script);
  });
  return loadPromise;
}
