// src/ui/stores/inputStore.js
//
// Everything the user types or picks: field location, planting date, the
// hybrid currently being calculated, and the list of saved hybrids.
//
// All of it persists to localStorage, because the realistic usage
// pattern is "same field, same hybrid, check again in two weeks" — not
// "fill in five inputs from scratch every time". The saved-hybrid list
// exists for the same reason: a rep works from a handful of numbers off
// a tech sheet, and typing 1,250 and 2,650 forty times a fall is how
// digits get transposed.
//
// NOTE on hybrid GDU ratings: this store holds whatever numbers are in
// the two GDU boxes, wherever they came from — the built-in hybrid list
// (see core/hybridCatalog.js), a saved entry, or typed by hand. It does
// not distinguish between those, on purpose: once a number is in the
// box it is the number the calculation uses, and the store should not
// be the thing deciding a typed value is less real than a loaded one.
// The Hybrid card does show WHERE a value came from and flags one that
// has been edited away from its list value — that's a display concern,
// handled in calculator.js.
//
// `rm` (relative maturity) rides along for display only. Nothing in the
// GDU engine reads it: RM and GDU measure related but different things,
// and deriving one from the other is exactly the kind of shortcut that
// puts a wrong number on screen wearing a confident face.

import { createPubSub, readJson, writeJson } from "./pubsub.js";

const LOCATION_KEY = "gdu.location";
const PLANTING_KEY = "gdu.plantingDate";
const HYBRIDS_KEY = "gdu.savedHybrids";
const CURRENT_KEY = "gdu.currentHybrid";

const pubsub = createPubSub();

/** @type {{location: any, plantingIso: string|null, hybrid: any, saved: any[]}} */
let state = {
  location: readJson(LOCATION_KEY, null),
  plantingIso: readJson(PLANTING_KEY, null),
  hybrid: readJson(CURRENT_KEY, { brand: "", name: "", gduToSilk: null, gduToBlackLayer: null, rm: null }),
  saved: readJson(HYBRIDS_KEY, []),
};

export function getState() {
  return state;
}

export function subscribe(fn) {
  return pubsub.subscribe(fn);
}

export function setLocation(location) {
  state = { ...state, location };
  writeJson(LOCATION_KEY, location);
  pubsub.notify();
}

export function setPlantingDate(iso) {
  state = { ...state, plantingIso: iso };
  writeJson(PLANTING_KEY, iso);
  pubsub.notify();
}

/** Merges a partial hybrid patch into the one currently being edited. */
export function updateHybrid(patch) {
  state = { ...state, hybrid: { ...state.hybrid, ...patch } };
  writeJson(CURRENT_KEY, state.hybrid);
  pubsub.notify();
}

/**
 * Saves the current hybrid to the list, replacing any existing entry
 * with the same brand + name (case-insensitive) rather than piling up
 * near-duplicates — re-saving after fixing a typo'd GDU number is the
 * common case, and it should update, not append.
 * @returns {{ok: boolean, error?: string}}
 */
export function saveCurrentHybrid() {
  const h = state.hybrid || {};
  const name = String(h.name || "").trim();
  if (!name) return { ok: false, error: "Give the hybrid a name before saving it." };
  if (!Number.isFinite(Number(h.gduToSilk)) || !Number.isFinite(Number(h.gduToBlackLayer))) {
    return { ok: false, error: "Enter both GDU numbers before saving." };
  }
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    brand: String(h.brand || "").trim(),
    name,
    gduToSilk: Number(h.gduToSilk),
    gduToBlackLayer: Number(h.gduToBlackLayer),
    rm: Number.isFinite(Number(h.rm)) ? Number(h.rm) : null,
  };
  const key = (x) => `${String(x.brand || "").trim().toLowerCase()}|${String(x.name || "").trim().toLowerCase()}`;
  const next = state.saved.filter((x) => key(x) !== key(entry));
  next.push(entry);
  next.sort((a, b) => (a.brand || "").localeCompare(b.brand || "") || a.name.localeCompare(b.name));
  state = { ...state, saved: next };
  writeJson(HYBRIDS_KEY, next);
  pubsub.notify();
  return { ok: true };
}

export function deleteSavedHybrid(id) {
  const next = state.saved.filter((x) => x.id !== id);
  state = { ...state, saved: next };
  writeJson(HYBRIDS_KEY, next);
  pubsub.notify();
}

export function loadSavedHybrid(id) {
  const found = state.saved.find((x) => x.id === id);
  if (!found) return;
  updateHybrid({
    brand: found.brand,
    name: found.name,
    gduToSilk: found.gduToSilk,
    gduToBlackLayer: found.gduToBlackLayer,
    rm: found.rm ?? null,
  });
}

/**
 * @returns {{ok: true, value: {gduToSilk: number, gduToBlackLayer: number, label: string, rm: number|null}} | {ok: false, error: string}}
 */
export function validatedHybrid() {
  const h = state.hybrid || {};
  const silk = Number(h.gduToSilk);
  const bl = Number(h.gduToBlackLayer);
  if (!Number.isFinite(silk) || silk <= 0) return { ok: false, error: "Enter the hybrid's GDUs to silk." };
  if (!Number.isFinite(bl) || bl <= 0) return { ok: false, error: "Enter the hybrid's GDUs to black layer." };
  // Silk always precedes black layer; a reversed pair is a data-entry
  // slip that would otherwise produce a silently nonsensical chart
  // (a "silk" line above the "black layer" line).
  if (silk >= bl) return { ok: false, error: "GDUs to silk must be lower than GDUs to black layer — check the two numbers." };
  const label = [String(h.brand || "").trim(), String(h.name || "").trim()].filter(Boolean).join(" ") || "This hybrid";
  const rm = Number.isFinite(Number(h.rm)) ? Number(h.rm) : null;
  return { ok: true, value: { gduToSilk: silk, gduToBlackLayer: bl, label, rm } };
}
