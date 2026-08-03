// src/ui/stores/themeStore.js
//
// Persists the user's chosen theme mode ("light" | "dark" | "system") to
// localStorage. Mirrors brandStore.js's pattern exactly.
//
// Defaults to "light" (per explicit request) for anyone who's never
// touched the Appearance control on Settings — readJson's fallback below
// only ever applies on that very first, nothing-saved-yet load; the
// instant someone taps Light/Dark/System in Settings, setMode() persists
// that exact choice to localStorage and every future load reads it back
// via readJson instead, regardless of what this default is.

import { createPubSub, readJson, writeJson } from "./pubsub.js";
import { applyThemeMode } from "../theme.js";

const KEY = "gdu.themeMode";
const VALID_MODES = ["light", "dark", "system"];
const DEFAULT_MODE = "light";

function normalizeMode(mode) {
  return VALID_MODES.includes(mode) ? mode : DEFAULT_MODE;
}

const pubsub = createPubSub();

let state = {
  mode: normalizeMode(readJson(KEY, DEFAULT_MODE)),
};

applyThemeMode(state.mode);

export function getState() {
  return state;
}

export function subscribe(fn) {
  return pubsub.subscribe(fn);
}

/**
 * @param {"light"|"dark"|"system"} mode
 */
export function setMode(mode) {
  const normalized = normalizeMode(mode);
  state = { ...state, mode: normalized };
  writeJson(KEY, normalized);
  applyThemeMode(normalized);
  pubsub.notify();
}
