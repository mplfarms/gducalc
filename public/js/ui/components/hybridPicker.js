// src/ui/components/hybridPicker.js
//
// Searchable modal list of the built-in hybrids. Reuses Corn Plot
// Harvest's .search-list / .search-list-input / .search-list-option
// classes verbatim so it looks and behaves exactly like that app's
// Hybrid and Trait pickers — the only addition is a second line per row
// carrying RM and the two GDU numbers, because picking a hybrid here is
// really picking a pair of numbers and hiding them until after the tap
// would be a strange thing to do.
//
// Deliberately no "+ Add New" row (unlike searchListPicker.js): adding a
// hybrid the catalog doesn't have means typing GDU ratings, which the
// form behind this modal already does better. The empty state says so.

import { h, clear, debounceGuard } from "../dom.js";
import { showCustomModal } from "./modal.js";
import * as catalog from "../../core/hybridCatalog.js";

/**
 * @param {{value?: string|null, onChange: (hybrid: import('../../core/hybridCatalog.js').CatalogHybrid) => void}} opts
 */
export function openHybridPicker(opts) {
  let query = "";

  const listEl = h("div", { className: "search-list", role: "listbox" });
  const guard = debounceGuard;

  function renderList() {
    clear(listEl);
    const matches = catalog.search(query);

    if (matches.length === 0) {
      listEl.appendChild(
        h(
          "div",
          { className: "search-list-empty" },
          catalog.isAvailable()
            ? `No hybrid matches “${query.trim()}”. Close this and type the variety and its GDU numbers by hand.`
            : "The built-in hybrid list didn't load. Close this and enter the variety and GDU numbers by hand."
        )
      );
      return;
    }

    let lastRm = null;
    for (const hy of matches) {
      // The list is sorted by maturity, so a sticky RM heading turns a
      // 72-row list into something you can thumb through by maturity —
      // which is how a hybrid actually gets chosen for a field.
      if (hy.rm !== lastRm) {
        lastRm = hy.rm;
        listEl.appendChild(h("div", { className: "hybrid-picker-rm-head" }, `${hy.rm} day`));
      }
      const selected = opts.value && hy.variety.toLowerCase() === String(opts.value).trim().toLowerCase();
      listEl.appendChild(
        h(
          "div",
          {
            className: `search-list-option hybrid-picker-option${selected ? " search-list-option-selected" : ""}`,
            role: "option",
            "aria-selected": selected ? "true" : "false",
            tabindex: "0",
            onclick: guard(() => choose(hy)),
            onkeydown: (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                choose(hy);
              }
            },
          },
          [
            h("span", { className: "hybrid-picker-name" }, hy.variety),
            h("span", { className: "hybrid-picker-gdu" }, `${hy.gduToSilk.toLocaleString()} silk · ${hy.gduToBlackLayer.toLocaleString()} black layer`),
          ]
        )
      );
    }
  }

  const input = h("input", {
    className: "search-list-input",
    type: "text",
    placeholder: "Search variety or maturity — e.g. 09-90, PCE, 109",
    "aria-label": "Search hybrids",
    oninput: (e) => {
      query = e.target.value;
      renderList();
    },
    onkeydown: (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      // Enter picks the only remaining match — the fast path when
      // someone types a variety number they already know.
      const matches = catalog.search(query);
      if (matches.length === 1) choose(matches[0]);
    },
  });

  const body = h("div", { className: "search-list-body" }, [
    input,
    h("p", { className: "search-list-add-new-hint" }, `${catalog.getAll().length} hybrids, sorted by maturity. GDU ratings are loaded exactly as supplied — you can still edit them after picking.`),
    listEl,
  ]);

  const modal = showCustomModal({ title: "Choose a Hybrid", bodyNode: body });

  function choose(hy) {
    modal.close();
    opts.onChange(hy);
  }

  renderList();
  setTimeout(() => input.focus(), 0);
}
