// src/ui/router.js
//
// Hash router, same minimal shape as Corn Plot Harvest's — screens are
// modules with a render(container, params) function, and navigation
// params that don't belong in a URL are held in memory.
//
// This app has no sign-in, so there is no auth guard here: a GDU
// calculation is derived entirely from public weather data and numbers
// the user types, with nothing to protect.

import * as brandSelect from "./screens/brandSelect.js";
import * as home from "./screens/home.js";
import * as savedLocations from "./screens/savedLocations.js";
import * as calculator from "./screens/calculator.js";
import * as results from "./screens/results.js";
import * as settings from "./screens/settings.js";
import * as help from "./screens/help.js";
import * as brandStore from "./stores/brandStore.js";

const routes = {
  "brand-select": brandSelect,
  home,
  "saved-locations": savedLocations,
  calculator,
  results,
  settings,
  help,
};

/**
 * Where a bare hash lands, and where an unknown one falls back to.
 *
 * This was "calculator" until the brand landing screen existed. Opening
 * the app straight onto a form is right for "new field" and wrong for
 * the more common trip — "check the field I set up last week" — which
 * used to mean scrolling three-quarters of the way down that form to
 * find the saved list.
 */
const DEFAULT_PATH = "home";

let appContainer = null;
let currentParams = {};
const rememberedOrigin = {};
const BACK_SENSITIVE = new Set(["settings", "help"]);

function currentPath() {
  const m = (window.location.hash || "").match(/^#\/([a-zA-Z0-9-]+)/);
  return m ? m[1] : null;
}

export function rememberedOriginFor(path) {
  return rememberedOrigin[path] || null;
}

function renderCurrent() {
  if (!appContainer) return;
  // Normalize a bare URL to a real route rather than rendering the
  // default screen under a hashless address. Without this, "/" renders
  // Home but the URL stays "/", so a reload or a shared link is a
  // different thing from what the address bar is showing — and every
  // other screen in the app does carry its hash. Setting the hash
  // re-enters through hashchange, so this returns.
  if (!currentPath()) {
    window.location.hash = `#/${DEFAULT_PATH}`;
    return;
  }
  let path = currentPath();
  // Every screen is themed by the selected Brand View, so a first-time
  // visitor picks one before anything else can render — otherwise the
  // app would flash the default Midwest green at someone who works for
  // NC+ or Crow's.
  if (path !== "brand-select" && !brandStore.getState().selectedBrand) {
    window.location.hash = "#/brand-select";
    return;
  }
  const screen = routes[path] || routes[DEFAULT_PATH];
  screen.render(appContainer, currentParams);
  window.scrollTo(0, 0);
}

/**
 * @param {string} path
 * @param {Object} [params] — `_skipOriginTracking: true` for a return
 *   trip, so a Back button doesn't overwrite the remembered true origin.
 */
export function navigate(path, params) {
  const from = currentPath();
  if (BACK_SENSITIVE.has(path) && from && from !== path && !(params && params._skipOriginTracking)) {
    rememberedOrigin[path] = from;
  }
  currentParams = params || {};
  const nextHash = `#/${path}`;
  if (window.location.hash === nextHash) renderCurrent();
  else window.location.hash = nextHash;
}

export function initRouter(container) {
  appContainer = container;
  window.addEventListener("hashchange", renderCurrent);
  renderCurrent();
}
