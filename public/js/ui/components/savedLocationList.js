// src/ui/components/savedLocationList.js
//
// The saved-locations list, in one place.
//
// It is rendered twice — on its own screen (screens/savedLocations.js)
// and inside the input form's Saved Locations card
// (screens/calculator.js) — and the row markup, the summary line under
// each name, the delete confirmation and, most importantly, the
// "tapping a row runs the calculation" rules are all here rather than
// once per caller. Two copies of a list is a cosmetic problem; two
// copies of the guards that decide whether a row can calculate is how
// one screen quietly starts behaving differently from the other.
//
// The one thing that legitimately differs between the two callers is
// what happens AFTER an entry is loaded: the input form has to repaint
// its own boxes to match, and the standalone list has no boxes. That is
// the `onAfterLoad` hook, and it is the only hook.

import { h } from "../dom.js";
import { showToast } from "./toast.js";
import { showConfirm } from "./modal.js";
import * as inputStore from "../stores/inputStore.js";
import { navigate } from "../router.js";
import { formatShort } from "../../core/dates.js";

/**
 * The line under a saved entry's name.
 *
 * A migrated entry from the old saved-hybrids list has no location or
 * date. It still loads its hybrid, and says so rather than showing a
 * blank second line — and that note has to LEAD rather than being a
 * fallback for an empty line, because a migrated row always has a
 * hybrid, so as a fallback it never fired on the very rows that need it
 * and they looked like normal locations that simply would not calculate.
 *
 * @param {Object} item
 * @returns {string}
 */
export function describeSavedLocation(item) {
  const bits = [];
  if (!item.location) bits.push("hybrid only — no field or date saved");
  if (item.location) bits.push(item.location.label);
  if (item.plantingIso) bits.push(`planted ${formatShort(item.plantingIso, { withYear: true })}`);
  if (item.hybrid && item.hybrid.name) {
    const hy = item.hybrid;
    const nums = hy.gduToSilk && hy.gduToBlackLayer ? ` (${hy.gduToSilk.toLocaleString()} / ${hy.gduToBlackLayer.toLocaleString()})` : "";
    bits.push(`${hy.name}${hy.rm ? ` · ${hy.rm} day` : ""}${nums}`);
  } else if (item.location) {
    bits.push("GDU only");
  }
  return bits.join(" · ");
}

/**
 * Loads a saved entry and does whatever that entry can support.
 *
 * Tapping a saved location is a request for its answer, not a request to
 * look at the form again — so it runs. The guards are the same ones the
 * Calculate button applies.
 *
 * @param {Object} item
 * @param {{onAfterLoad?: (state: Object) => void, sendToFormWhenIncomplete?: boolean}} opts
 * @returns {"ran"|"incomplete"|"invalid"} what actually happened, so a
 *   caller can decide whether to repaint
 */
export function openSavedLocation(item, { onAfterLoad, sendToFormWhenIncomplete = false } = {}) {
  inputStore.loadSavedLocation(item.id);
  if (onAfterLoad) onAfterLoad(inputStore.getState());

  // Gated on what THIS ENTRY saved, not on what happens to be in the
  // store. loadSavedLocation deliberately leaves the field and date
  // alone for a migrated hybrid-only row — blanking them with nulls that
  // were never really saved would be worse — but that meant the guard
  // passed on leftovers from the previous row and the entry calculated
  // silently against somebody else's field. On the input form the stale
  // ZIP was at least visible in the box above the list; on the
  // standalone screen there was nothing on screen to give it away.
  const missing = [];
  if (!item.location) missing.push("a ZIP");
  if (!item.plantingIso) missing.push("a planting date");
  if (missing.length) {
    showToast(`Loaded ${item.name}. Add ${missing.join(" and ")} to calculate.`, { type: "success", duration: 3500 });
    // From the standalone list there is no form on screen to act on that
    // message, so it has to go to one. From inside the form there is,
    // and navigating would just reload the screen the user is on.
    if (sendToFormWhenIncomplete) navigate("calculator");
    return "incomplete";
  }
  const check = inputStore.validatedHybrid();
  if (!check.ok) {
    showToast(check.error, { type: "error" });
    if (sendToFormWhenIncomplete) navigate("calculator");
    return "invalid";
  }
  navigate("results");
  return "ran";
}

/**
 * A self-repainting list element.
 *
 * @param {{emptyText?: string, onAfterLoad?: (state: Object) => void, sendToFormWhenIncomplete?: boolean, onChanged?: () => void}} opts
 * @returns {{el: HTMLElement, paint: () => void}}
 */
export function createSavedLocationList(opts = {}) {
  const el = h("div", { className: "gdu-saved-list" });

  function paint() {
    const saved = inputStore.getState().saved;
    el.textContent = "";
    if (!saved.length) {
      el.appendChild(h("p", { className: "empty-state" }, opts.emptyText || "No saved locations yet."));
      return;
    }
    for (const item of saved) {
      el.appendChild(
        h("div", { className: "gdu-saved-row" }, [
          h(
            "button",
            {
              type: "button",
              className: "gdu-saved-load",
              onclick: () =>
                openSavedLocation(item, {
                  onAfterLoad: opts.onAfterLoad,
                  sendToFormWhenIncomplete: opts.sendToFormWhenIncomplete,
                }),
            },
            [h("span", { className: "gdu-saved-name" }, item.name), h("span", { className: "gdu-saved-meta" }, describeSavedLocation(item))]
          ),
          h(
            "button",
            {
              type: "button",
              className: "icon-btn icon-btn-danger",
              "aria-label": `Delete ${item.name}`,
              onclick: async () => {
                const yes = await showConfirm({
                  title: "Delete location?",
                  message: `Remove ${item.name} from your saved list?`,
                  confirmLabel: "Delete",
                  destructive: true,
                });
                if (!yes) return;
                inputStore.deleteSavedLocation(item.id);
                paint();
                if (opts.onChanged) opts.onChanged();
              },
            },
            "✕"
          ),
        ])
      );
    }
  }

  paint();
  return { el, paint };
}
