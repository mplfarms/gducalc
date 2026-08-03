// src/main.js (served at public/js/main.js)
//
// Entry point: register the service worker, then start the router.
// Deliberately thinner than Corn Plot Harvest's equivalent — there's no
// sign-in, no cloud sync and no shared catalog to reconcile before the
// first screen can render, so there is nothing to await.

import "./ui/stores/themeStore.js"; // self-applies the persisted theme on import
import "./ui/stores/brandStore.js"; // self-applies the persisted brand palette on import
import { initRouter } from "./ui/router.js";
import * as hybridCatalog from "./core/hybridCatalog.js";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) => {
      console.error("[main] service worker registration failed", e);
    });
  });
}

// Fire-and-forget: the hybrid picker awaits this itself, but kicking it
// off here means the list is usually already in hand by the time anyone
// scrolls down to the Hybrid card. Never throws (see ensureLoaded).
hybridCatalog.ensureLoaded();

if (!window.location.hash) window.location.hash = "#/calculator";
initRouter(document.getElementById("app"));
