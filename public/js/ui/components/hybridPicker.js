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
//
// The list is sorted by relative maturity but carries no RM section
// headings — per explicit request. Most variety numbers already encode
// maturity (09-90 is a 109 day, 77-70 a 77 day), so a heading above each
// group mostly repeated what the row underneath already said. RM moved
// onto the row's own meta line instead, which keeps it available for the
// seven varieties whose names DON'T encode it (10T84, 42W96, 42U97,
// 5110, 77P13, 77A14, 77C14) without a band of repeated headings.

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

    for (const hy of matches) {
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
            h("span", { className: "hybrid-picker-gdu" }, `${hy.rm} day · ${hy.gduToSilk.toLocaleString()} silk · ${hy.gduToBlackLayer.toLocaleString()} black layer`),
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
    h("p", { className: "search-list-add-new-hint" }, `${catalog.getAll().length} hybrids, shortest maturity first. GDU ratings are loaded exactly as supplied — you can still edit them after picking.`),
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
