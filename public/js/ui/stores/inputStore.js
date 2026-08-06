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
// `rm` (relative maturity) is both a display field and, when the GDU
// boxes are empty, the input an estimate is built from — see
// core/hybridEstimate.js. The GDU engine itself still never reads RM:
// everything downstream consumes the two resolved GDU numbers, and
// whether those were typed or estimated is carried alongside as
// provenance so every screen can label them.

import { createPubSub, readJson, writeJson } from "./pubsub.js";
import { resolve as resolveHybridInputs } from "../../core/hybridEstimate.js";
import * as brandStore from "./brandStore.js";
import { getBrand, brandedHybridName } from "../brand.js";

const LOCATION_KEY = "gdu.location";
const LOCATION_NAME_KEY = "gdu.locationName";
const PLANTING_KEY = "gdu.plantingDate";
const HYBRIDS_KEY = "gdu.savedHybrids"; // legacy, read once for migration
const SAVED_KEY = "gdu.savedLocations";
const CURRENT_KEY = "gdu.currentHybrid";

const pubsub = createPubSub();

/**
 * The saved list used to hold bare hybrids. It now holds LOCATIONS —
 * a name, the field, the planting date, and the hybrid if one was
 * entered — because "same field, same hybrid, check again in two weeks"
 * is the actual pattern, and re-entering the ZIP and date every time was
 * most of the typing.
 *
 * Old saved hybrids are migrated rather than dropped: each becomes an
 * entry carrying only its hybrid, which loads exactly as it used to.
 * Silently deleting somebody's saved list to change a data shape is not
 * a trade that was ours to make.
 */
function migrateLegacyHybrids() {
  const legacy = readJson(HYBRIDS_KEY, []);
  if (!Array.isArray(legacy) || legacy.length === 0) return [];
  return legacy.map((hy) => ({
    id: hy.id,
    name: hy.name,
    location: null,
    plantingIso: null,
    hybrid: { brand: hy.brand || "", name: hy.name, gduToSilk: hy.gduToSilk, gduToBlackLayer: hy.gduToBlackLayer, rm: hy.rm ?? null },
  }));
}

function initialSaved() {
  const current = readJson(SAVED_KEY, null);
  if (Array.isArray(current)) return current;
  const migrated = migrateLegacyHybrids();
  if (migrated.length) writeJson(SAVED_KEY, migrated);
  return migrated;
}

/** @type {{location: any, locationName: string, plantingIso: string|null, hybrid: any, saved: any[]}} */
let state = {
  location: readJson(LOCATION_KEY, null),
  locationName: readJson(LOCATION_NAME_KEY, ""),
  plantingIso: readJson(PLANTING_KEY, null),
  hybrid: readJson(CURRENT_KEY, { brand: "", name: "", gduToSilk: null, gduToBlackLayer: null, rm: null }),
  saved: initialSaved(),
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

/** The grower's own name for this field — "Brown home place", "north 80". */
export function setLocationName(name) {
  state = { ...state, locationName: String(name || "") };
  writeJson(LOCATION_NAME_KEY, state.locationName);
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
 * Saves the whole current setup — location, planting date and the hybrid
 * if one is entered — under a name.
 *
 * Replaces any existing entry with the same name (case-insensitive)
 * rather than piling up near-duplicates: re-saving after fixing a typo
 * is the common case, and it should update, not append.
 *
 * @returns {{ok: boolean, error?: string}}
 */
export function saveCurrentLocation() {
  const name = String(state.locationName || "").trim();
  if (!name) return { ok: false, error: "Give this location a name before saving it." };
  if (!state.location) return { ok: false, error: "Set a ZIP code before saving this location." };

  const h = state.hybrid || {};
  // Saving stores exactly what was typed, estimates included as blanks —
  // re-resolving on load means a saved RM-only hybrid picks up any later
  // change to the estimator instead of freezing today's guess.
  const hasHybrid = !hasNoHybridInput() || !!String(h.name || "").trim();
  if (hasHybrid) {
    const check = resolveHybridInputs({ gduToSilk: h.gduToSilk, gduToBlackLayer: h.gduToBlackLayer, rm: h.rm });
    if (!check.ok) return { ok: false, error: check.error };
  }

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    location: state.location,
    plantingIso: state.plantingIso || null,
    hybrid: hasHybrid
      ? {
          brand: String(h.brand || "").trim(),
          name: String(h.name || "").trim(),
          gduToSilk: Number.isFinite(Number(h.gduToSilk)) ? Number(h.gduToSilk) : null,
          gduToBlackLayer: Number.isFinite(Number(h.gduToBlackLayer)) ? Number(h.gduToBlackLayer) : null,
          rm: Number.isFinite(Number(h.rm)) ? Number(h.rm) : null,
        }
      : null,
  };
  const key = (x) => String(x.name || "").trim().toLowerCase();
  const next = state.saved.filter((x) => key(x) !== key(entry));
  next.push(entry);
  next.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  state = { ...state, saved: next };
  writeJson(SAVED_KEY, next);
  pubsub.notify();
  return { ok: true };
}

export function deleteSavedLocation(id) {
  const next = state.saved.filter((x) => x.id !== id);
  state = { ...state, saved: next };
  writeJson(SAVED_KEY, next);
  pubsub.notify();
}

/**
 * Restores a saved entry. A migrated legacy row carries only a hybrid,
 * so the location and date are left exactly as they are rather than
 * being blanked by nulls that were never really saved.
 */
export function loadSavedLocation(id) {
  const found = state.saved.find((x) => x.id === id);
  if (!found) return;
  setLocationName(found.name || "");
  if (found.location) setLocation(found.location);
  if (found.plantingIso) setPlantingDate(found.plantingIso);
  if (found.hybrid) {
    updateHybrid({
      brand: found.hybrid.brand,
      name: found.hybrid.name,
      gduToSilk: found.hybrid.gduToSilk,
      gduToBlackLayer: found.hybrid.gduToBlackLayer,
      rm: found.hybrid.rm ?? null,
    });
  } else {
    clearHybrid();
  }
}

/**
 * Wipes the hybrid being edited back to empty.
 *
 * Resets the whole hybrid object rather than blanking fields one by
 * one, so nothing survives that a later field could be matched against —
 * the "from hybrid list" badge is derived from the name, so clearing the
 * name clears the badge with it.
 *
 * Deliberately does NOT touch the saved list, the location or the
 * planting date: clearing the hybrid means "calculate the heat for this
 * field without a hybrid", not "start over".
 */
export function clearHybrid() {
  state = { ...state, hybrid: {} };
  writeJson(CURRENT_KEY, state.hybrid);
  pubsub.notify();
}

/**
 * How the hybrid is titled on every screen, the PDF and the filename.
 *
 * A HOUSE hybrid is titled with the active Brand View's own 2-letter
 * code — "NC 09-90 PCE" under NC+, "MW 09-90 PCE" under Midwest. Same
 * genetics, three regional labels, and the report should carry the one
 * the grower actually buys. Spelling out the full catalog name instead
 * ("NC+ Hybrids 09-90 PCE") reads like a database row, not a hybrid.
 *
 * A COMPETITOR hybrid is titled with just what was typed. Prefixing
 * "Other" onto someone else's hybrid produced "Other DKC62-08", which
 * was never right.
 */
function hybridLabel(h) {
  const name = String(h.name || "").trim();
  const activeBrand = getBrand(brandStore.getState().selectedBrand);
  const isHouse = activeBrand && String(h.brand || "").trim() === activeBrand.catalogBrandName;
  if (isHouse) return brandedHybridName(name, activeBrand) || activeBrand.displayName;
  return name || "This hybrid";
}

/** True when no hybrid information has been entered at all. */
export function hasNoHybridInput() {
  const h = state.hybrid || {};
  const empty = (v) => v === null || v === undefined || v === "";
  return empty(h.gduToSilk) && empty(h.gduToBlackLayer) && empty(h.rm);
}

/**
 * Resolves the current hybrid into the pair of GDU numbers to calculate
 * with, filling in whichever is missing from the other or from RM (see
 * core/hybridEstimate.js). Any one of the three inputs is enough — and
 * NONE is also fine: a hybrid is optional, and with no ratings at all
 * this returns `{ok: true, value: null}` so the caller can run a plain
 * location-and-date accumulation with no stage predictions.
 *
 * The returned value carries provenance for both numbers, so the input
 * card, the results header and the method card can all label an
 * estimate as an estimate rather than letting it pass as a reading off
 * a tech sheet.
 *
 * @returns {{ok: true, value: {gduToSilk: number, gduToBlackLayer: number, label: string, rm: number|null, silk: Object, blackLayer: Object, anyEstimated: boolean, rmOutsideFit: boolean}} | {ok: false, error: string}}
 */
export function validatedHybrid() {
  const h = state.hybrid || {};
  if (hasNoHybridInput()) return { ok: true, value: null };
  const resolved = resolveHybridInputs({ gduToSilk: h.gduToSilk, gduToBlackLayer: h.gduToBlackLayer, rm: h.rm });
  if (!resolved.ok) return resolved;

  const label = hybridLabel(h);
  return {
    ok: true,
    value: {
      gduToSilk: resolved.silk.value,
      gduToBlackLayer: resolved.blackLayer.value,
      label,
      rm: resolved.rm,
      silk: resolved.silk,
      blackLayer: resolved.blackLayer,
      anyEstimated: resolved.anyEstimated,
      rmOutsideFit: resolved.rmOutsideFit,
    },
  };
}
