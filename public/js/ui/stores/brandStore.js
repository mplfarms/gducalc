// src/ui/stores/brandStore.js
//
// Persists the chosen Brand View. Same shape as Corn Plot Harvest's own
// brandStore, but under its own localStorage key ("gdu." rather than
// "cph.") so the two apps can be served from the same origin without
// one clobbering the other's settings.

import { createPubSub, readJson, writeJson } from "./pubsub.js";
import { applyBrandTheme } from "../brand.js";

const KEY = "gdu.selectedBrand";

const pubsub = createPubSub();

let state = {
  selectedBrand: readJson(KEY, null),
};

applyBrandTheme(state.selectedBrand);

export function getState() {
  return state;
}

export function subscribe(fn) {
  return pubsub.subscribe(fn);
}

/** @param {"midwestSeedGenetics"|"ncPlus"|"crows"} brandId */
export function selectBrand(brandId) {
  state = { ...state, selectedBrand: brandId };
  writeJson(KEY, brandId);
  applyBrandTheme(brandId);
  pubsub.notify();
}
