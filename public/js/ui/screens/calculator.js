// src/ui/screens/calculator.js
//
// The input screen: where the field is, when it went in, and what the
// hybrid is rated at. Three cards, in the order someone actually
// answers them, with a single primary action at the bottom.
//
// Inputs persist as they're typed (see inputStore) rather than on a
// Save button, because the common return visit is "same field, same
// hybrid, two weeks later" and re-entering four values to get an
// updated projection would make that a chore instead of a glance.

import { h, mount } from "../dom.js";
import { createTopBar } from "../components/topBar.js";
import { createDatePicker } from "../components/datePicker.js";
import { showToast } from "../components/toast.js";
import { showConfirm } from "../components/modal.js";
import { BRANDS, getBrand, brandedHybridName } from "../brand.js";
import * as brandStore from "../stores/brandStore.js";
import * as inputStore from "../stores/inputStore.js";
import { navigate } from "../router.js";
import { lookupZip } from "../../core/location.js";
import { openHybridPicker } from "../components/hybridPicker.js";
import * as catalog from "../../core/hybridCatalog.js";
import { resolve as resolveHybridInputs, sourceLabel, accuracyNote, RM_FITTED_MIN, RM_FITTED_MAX, FITTED_N } from "../../core/hybridEstimate.js";
import { formatShort, todayIso, yearOf } from "../../core/dates.js";

export function render(container) {
  const brand = getBrand(brandStore.getState().selectedBrand);
  const state = inputStore.getState();

  const statusEl = h("p", { className: "location-status" }, "");

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = `location-status${kind ? ` location-status-${kind}` : ""}`;
  }

  // ---------------------------------------------------------------
  // Location
  // ---------------------------------------------------------------
  const locationValueEl = h("div", { className: "gdu-location-readout" });

  function paintLocation() {
    const loc = inputStore.getState().location;
    locationValueEl.textContent = "";
    if (!loc) {
      locationValueEl.appendChild(h("span", { className: "gdu-location-empty" }, "Enter a ZIP code to set the field location."));
      return;
    }
    locationValueEl.appendChild(h("div", { className: "gdu-location-name" }, loc.label));
    locationValueEl.appendChild(
      h("div", { className: "gdu-location-coords" }, `${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)} · ZIP centroid`)
    );
  }
  paintLocation();

  const zipInput = h("input", {
    className: "text-input",
    type: "text",
    inputmode: "numeric",
    maxlength: "5",
    placeholder: "e.g. 51555",
    value: (state.location && state.location.zip) || "",
    "aria-label": "ZIP code",
  });

  const zipBtn = h(
    "button",
    {
      type: "button",
      className: "btn btn-secondary",
      onclick: async () => {
        zipBtn.disabled = true;
        setStatus("Looking up ZIP…", "locating");
        const res = await lookupZip(zipInput.value);
        zipBtn.disabled = false;
        if (!res.ok) {
          setStatus(res.error, "failure");
          return;
        }
        inputStore.setLocation(res.location);
        paintLocation();
        setStatus(`Location set to ${res.location.label}.`, "success");
      },
    },
    "Look Up"
  );

  zipInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      zipBtn.click();
    }
  });

  const locationCard = h("section", { className: "card" }, [
    h("h3", { className: "section-header" }, "Field Location"),
    locationValueEl,
    h("div", { className: "field" }, [
      h("label", { className: "field-label" }, "ZIP Code"),
      h("div", { className: "gdu-inline-row" }, [zipInput, zipBtn]),
    ]),
    statusEl,
    h(
      "p",
      { className: "field-note" },
      "Weather comes from a gridded reanalysis roughly 6 to 15 miles per cell, so every field in the same township returns the same numbers — a ZIP is as precise as this data gets."
    ),
  ]);

  // ---------------------------------------------------------------
  // Planting date
  // ---------------------------------------------------------------
  const datePicker = createDatePicker({
    value: state.plantingIso,
    placeholder: "Select planting date",
    onChange: (iso) => {
      inputStore.setPlantingDate(iso);
      paintPlantingNote();
    },
  });

  const plantingNote = h("p", { className: "field-note" }, "");
  function paintPlantingNote() {
    const iso = inputStore.getState().plantingIso;
    if (!iso) {
      plantingNote.textContent = "GDUs are counted starting on the planting date itself.";
      return;
    }
    const plantYear = yearOf(iso);
    const thisYear = yearOf(todayIso());
    if (iso > todayIso()) {
      plantingNote.textContent = `Planned for ${formatShort(iso, { withYear: true })}. With nothing in the ground yet there's no actual accumulation to show — you'll get the normal, hot and cool projections only.`;
    } else if (plantYear < thisYear) {
      plantingNote.textContent = `Looking back at the ${plantYear} season. Every day is already on the books, so these are actuals, not a forecast.`;
    } else {
      plantingNote.textContent = "GDUs are counted starting on the planting date itself.";
    }
  }
  paintPlantingNote();

  const dateCard = h("section", { className: "card" }, [
    h("h3", { className: "section-header" }, "Planting Date"),
    h("div", { className: "field" }, [datePicker.el, plantingNote]),
  ]);

  // ---------------------------------------------------------------
  // Hybrid
  // ---------------------------------------------------------------
  // Only ONE house brand is offered: the Brand View you are currently in.
  // Midwest, NC+ and Crow's are the same genetics under three regional
  // labels, so listing all three inside a single Brand View invited a rep
  // to build a report headed "Crow's" while sitting in the NC+ view. The
  // choice that remains is the one that is actually a choice — our
  // hybrid, or somebody else's.
  const houseBrands = brand ? [brand] : Object.values(BRANDS);
  const brandSelectEl = h(
    "select",
    {
      className: "text-input",
      "aria-label": "Brand",
      onchange: (e) => {
        inputStore.updateHybrid({ brand: e.target.value });
        paintCatalogNote();
        paintResolved();
      },
    },
    [
      h("option", { value: "" }, "— Select brand —"),
      ...houseBrands.map((b) => h("option", { value: b.catalogBrandName }, b.catalogBrandName)),
      h("option", { value: "Other" }, "Other / competitor"),
    ]
  );
  // Default the brand field to the active Brand View — it's right far
  // more often than not, and it's one less tap.
  //
  // Switching Brand View also MIGRATES a stored house brand to the new
  // one rather than leaving a value the dropdown no longer offers (which
  // renders as a blank select and silently drops the brand off the
  // report). "Other" is left alone — a competitor hybrid does not become
  // ours because the view changed.
  const storedBrand = String(state.hybrid.brand || "");
  const isStoredHouse = storedBrand !== "" && storedBrand !== "Other" && !houseBrands.some((b) => b.catalogBrandName === storedBrand);
  const wantBrand = isStoredHouse || storedBrand === "" ? (brand ? brand.catalogBrandName : storedBrand) : storedBrand;
  brandSelectEl.value = wantBrand;
  if (wantBrand !== storedBrand) inputStore.updateHybrid({ brand: wantBrand });

  const nameInput = h("input", {
    className: "text-input",
    type: "text",
    // The visible <label> isn't wired up with for/id, so screen readers
    // (and tests) had nothing stable to key on while the placeholder
    // moves with the Brand View.
    "aria-label": "Hybrid name",
    placeholder: `e.g. ${brandedHybridName("09-90 PCE", brand)}`,
    value: state.hybrid.name || "",
    oninput: (e) => {
      inputStore.updateHybrid({ name: e.target.value });
      paintCatalogNote();
    },
  });

  const rmInput = numberInput("Relative maturity", state.hybrid.rm, (v) => {
    inputStore.updateHybrid({ rm: v });
    paintCatalogNote();
    paintResolved();
  }, "e.g. 105");
  const silkInput = numberInput("GDUs to silk", state.hybrid.gduToSilk, (v) => {
    inputStore.updateHybrid({ gduToSilk: v });
    paintCatalogNote();
    paintResolved();
  }, "optional");
  const blInput = numberInput("GDUs to black layer", state.hybrid.gduToBlackLayer, (v) => {
    inputStore.updateHybrid({ gduToBlackLayer: v });
    paintCatalogNote();
    paintResolved();
  }, "optional");

  // ---- what will actually be calculated with ----
  // Shown live under the inputs. Any ONE of RM / silk / black layer is
  // enough; the rest gets estimated (core/hybridEstimate.js) and is
  // labeled as an estimate here rather than being written into the input
  // boxes, which would make a guess look like something someone typed.
  const resolvedNote = h("div", { className: "gdu-resolved-note" });

  function paintResolved() {
    const hy = inputStore.getState().hybrid;
    resolvedNote.textContent = "";
    const r = resolveHybridInputs({ gduToSilk: hy.gduToSilk, gduToBlackLayer: hy.gduToBlackLayer, rm: hy.rm });

    if (!r.ok) {
      // With nothing entered at all this is not an error — it's the
      // ZIP-and-date-only path, which is a supported way to use the app.
      resolvedNote.appendChild(
        h(
          "p",
          { className: "gdu-resolved-empty" },
          inputStore.hasNoHybridInput()
            ? "No hybrid yet — Calculate will still chart GDU accumulation for this location and planting date. Add any one of the three above to get silk and black layer dates."
            : r.error
        )
      );
      return;
    }

    const rows = [
      ["Silk", r.silk],
      ["Black layer", r.blackLayer],
    ].map(([label, rv]) => {
      const src = sourceLabel(rv, r.rm);
      return h("div", { className: "gdu-resolved-row" }, [
        h("span", { className: "gdu-resolved-label" }, label),
        h("span", { className: "gdu-resolved-value" }, `${rv.value.toLocaleString()} GDU`),
        src
          ? h("span", { className: "field-locked-tag gdu-tag-estimated" }, "est.")
          : h("span", { className: "gdu-resolved-src" }, "entered"),
        src ? h("span", { className: "gdu-resolved-src" }, src) : null,
      ]);
    });

    resolvedNote.appendChild(h("h4", { className: "gdu-subheading gdu-subheading-tight" }, "Will calculate with"));
    resolvedNote.appendChild(h("div", { className: "gdu-resolved-table" }, rows));

    const notes = [];
    for (const rv of [r.silk, r.blackLayer]) {
      const acc = accuracyNote(rv);
      if (acc && !notes.includes(acc)) notes.push(acc);
    }
    if (notes.length) {
      resolvedNote.appendChild(
        h("p", { className: "gdu-resolved-accuracy" }, `Estimated values are ${notes.join("; ")}. Checked by leaving each of the ${FITTED_N} listed hybrids out of the fit in turn and predicting it — real out-of-sample error, not the fit's own memory.`)
      );
    }
    if (r.rmOutsideFit) {
      resolvedNote.appendChild(
        h("p", { className: "gdu-resolved-warn" }, `The estimator was fitted on hybrids from ${RM_FITTED_MIN} to ${RM_FITTED_MAX} day. At ${r.rm} day it's extrapolating past its data — treat the result as a rough bracket and use real ratings if you can get them.`)
      );
    }
  }

  // ---- built-in hybrid list ----
  const catalogNote = h("div", { className: "gdu-catalog-note" });

  /**
   * Says where the numbers in the two GDU boxes came from. Three states,
   * and the distinction matters: a value straight off the sheet, a value
   * someone has since changed, and a value typed from scratch are three
   * different levels of confidence, and the app should not let an edited
   * number keep wearing the catalog's badge.
   */
  function paintCatalogNote() {
    const hy = inputStore.getState().hybrid;
    catalogNote.textContent = "";
    const match = catalog.findByVariety(hy.name);
    if (!match) return;

    const silk = Number(hy.gduToSilk);
    const bl = Number(hy.gduToBlackLayer);
    const unchanged = silk === match.gduToSilk && bl === match.gduToBlackLayer;

    catalogNote.appendChild(
      h("p", { className: "gdu-catalog-line" }, [
        h("span", { className: unchanged ? "field-locked-tag" : "field-locked-tag gdu-tag-edited" }, unchanged ? "From hybrid list" : "Edited"),
        h(
          "span",
          { className: "gdu-catalog-text" },
          unchanged
            ? `${match.rm} day relative maturity.`
            : `${match.rm} day. List values are ${match.gduToSilk.toLocaleString()} silk / ${match.gduToBlackLayer.toLocaleString()} black layer.`
        ),
        unchanged
          ? null
          : h(
              "button",
              {
                type: "button",
                className: "gdu-catalog-reset",
                onclick: () => applyCatalogHybrid(match),
              },
              "Reset to list values"
            ),
      ])
    );

    // Only shown for a genuinely unusual rating, and only as a prompt to
    // look twice — see hybridCatalog.rmOutlierNote. The number itself is
    // never altered.
    const outlier = catalog.rmOutlierNote(match);
    if (outlier && unchanged) catalogNote.appendChild(h("p", { className: "gdu-catalog-outlier" }, outlier));
  }

  function applyCatalogHybrid(hy) {
    // Stored and displayed under the active Brand View's code. The list
    // itself is brand-neutral ("09-90 PCE") because it is one set of
    // genetics; the code is how the grower in front of you buys it.
    // catalog.findByVariety() strips the code again on the way back, so
    // the "From hybrid list" badge still matches.
    const shown = brandedHybridName(hy.variety, brand);
    inputStore.updateHybrid({ name: shown, gduToSilk: hy.gduToSilk, gduToBlackLayer: hy.gduToBlackLayer, rm: hy.rm });
    nameInput.value = shown;
    rmInput.input.value = String(hy.rm);
    silkInput.input.value = String(hy.gduToSilk);
    blInput.input.value = String(hy.gduToBlackLayer);
    paintCatalogNote();
    paintResolved();
  }

  const pickBtn = h(
    "button",
    {
      type: "button",
      className: "btn btn-secondary gdu-pick-hybrid-btn",
      disabled: true,
      onclick: () =>
        openHybridPicker({
          value: inputStore.getState().hybrid.name,
          onChange: (hy) => {
            applyCatalogHybrid(hy);
            showToast(`Loaded ${brandedHybridName(hy.variety, brand)} — ${hy.gduToSilk.toLocaleString()} silk / ${hy.gduToBlackLayer.toLocaleString()} black layer.`, {
              type: "success",
              duration: 3000,
            });
          },
        }),
    },
    "Loading…"
  );

  // The catalog is a static JSON asset in the service worker precache, so
  // after the first visit this resolves off disk and the button is
  // enabled before anyone can look at it. On a cold first load it stays
  // disabled for a beat rather than opening an empty picker.
  catalog.ensureLoaded().then(() => {
    if (catalog.isAvailable()) {
      pickBtn.disabled = false;
      pickBtn.textContent = "Choose Hybrid";
    } else {
      pickBtn.textContent = "List unavailable";
    }
    paintCatalogNote();
  });

  const savedListEl = h("div", { className: "gdu-saved-list" });

  function paintSavedList() {
    const saved = inputStore.getState().saved;
    savedListEl.textContent = "";
    if (!saved.length) {
      savedListEl.appendChild(h("p", { className: "empty-state" }, "No saved hybrids yet."));
      return;
    }
    for (const item of saved) {
      savedListEl.appendChild(
        h("div", { className: "gdu-saved-row" }, [
          h(
            "button",
            {
              type: "button",
              className: "gdu-saved-load",
              onclick: () => {
                inputStore.loadSavedHybrid(item.id);
                const s = inputStore.getState().hybrid;
                brandSelectEl.value = s.brand || "";
                nameInput.value = s.name || "";
                rmInput.input.value = s.rm ?? "";
                silkInput.input.value = s.gduToSilk ?? "";
                blInput.input.value = s.gduToBlackLayer ?? "";
                paintCatalogNote();
                paintResolved();
                showToast(`Loaded ${item.name}.`, { type: "success", duration: 2500 });
              },
            },
            [
              h("span", { className: "gdu-saved-name" }, item.name),
              h("span", { className: "gdu-saved-meta" }, `${item.brand ? `${item.brand} · ` : ""}${item.rm ? `${item.rm} day · ` : ""}${item.gduToSilk.toLocaleString()} silk · ${item.gduToBlackLayer.toLocaleString()} BL`),
            ]
          ),
          h(
            "button",
            {
              type: "button",
              className: "icon-btn icon-btn-danger",
              "aria-label": `Delete ${item.name}`,
              onclick: async () => {
                const yes = await showConfirm({
                  title: "Delete hybrid?",
                  message: `Remove ${item.name} from your saved list?`,
                  confirmLabel: "Delete",
                  destructive: true,
                });
                if (yes) {
                  inputStore.deleteSavedHybrid(item.id);
                  paintSavedList();
                }
              },
            },
            "✕"
          ),
        ])
      );
    }
  }
  paintSavedList();
  paintResolved();

  // Everything below the header collapses to one line when there is no
  // hybrid, so a ZIP-and-date run isn't scrolling past four empty boxes
  // to reach Calculate. Collapsed is a VIEW state, not stored input —
  // reopening it finds exactly what was there.
  // Choose and Clear are a pair, so they sit together at the top of the
  // card — the two things you do to the hybrid as a whole, before any of
  // the individual fields below them.
  const clearBtn = h(
    "button",
    {
      type: "button",
      className: "btn btn-secondary gdu-clear-hybrid-btn",
      onclick: () => {
        inputStore.clearHybrid();
        nameInput.value = "";
        rmInput.input.value = "";
        silkInput.input.value = "";
        blInput.input.value = "";
        setHybridCollapsed(true);
        paintCatalogNote();
        paintResolved();
        showToast("Hybrid cleared — this will calculate GDUs for the field and planting date only.", { type: "success", duration: 3500 });
      },
    },
    "Clear Hybrid"
  );

  const hybridBody = h("div", { className: "gdu-hybrid-body" }, [
    h("div", { className: "gdu-inline-row gdu-hybrid-actions" }, [pickBtn, clearBtn]),
    h("div", { className: "gdu-or-divider" }, "or enter it yourself"),
    h("div", { className: "field" }, [h("label", { className: "field-label" }, "Brand"), brandSelectEl]),
    h("div", { className: "field" }, [h("label", { className: "field-label" }, "Hybrid"), nameInput]),
    h("div", { className: "field" }, [
      h("label", { className: "field-label" }, "Relative Maturity (days)"),
      rmInput.input,
      h("p", { className: "field-note" }, `Enough on its own — with RM and no GDU numbers, both get estimated from the ${FITTED_N} hybrids in the built-in list.`),
    ]),
    h("div", { className: "gdu-two-col" }, [
      h("div", { className: "field" }, [h("label", { className: "field-label" }, "GDUs to Silk"), silkInput.input]),
      h("div", { className: "field" }, [h("label", { className: "field-label" }, "GDUs to Black Layer"), blInput.input]),
    ]),
    resolvedNote,
    catalogNote,
    h(
      "p",
      { className: "field-note" },
      "Anything not on the built-in list can be typed in directly — use the numbers off that brand's own tech sheet where you have them. A real GDU rating always beats an estimate, and one real rating beats RM: the app estimates a missing black layer from a known silk before it will fall back to maturity."
    ),
    h(
      "button",
      {
        type: "button",
        className: "btn btn-secondary btn-block gdu-save-hybrid-btn",
        onclick: () => {
          const res = inputStore.saveCurrentHybrid();
          if (!res.ok) {
            showToast(res.error, { type: "error" });
            return;
          }
          paintSavedList();
          showToast("Hybrid saved.", { type: "success", duration: 2500 });
        },
      },
      "Save This Hybrid"
    ),
    h("h4", { className: "gdu-subheading" }, "Saved Hybrids"),
    savedListEl,
  ]);

  const hybridToggle = h("button", {
    type: "button",
    className: "gdu-hybrid-toggle",
    "aria-expanded": "true",
    "aria-controls": "gdu-hybrid-body",
    onclick: () => setHybridCollapsed(!hybridBody.hidden),
  });
  hybridBody.id = "gdu-hybrid-body";

  const hybridEmptyNote = h(
    "p",
    { className: "field-note gdu-hybrid-empty" },
    "No hybrid — Calculate will chart GDU accumulation for this field and planting date, with no silk or black layer dates."
  );

  function setHybridCollapsed(collapsed) {
    hybridBody.hidden = collapsed;
    hybridEmptyNote.hidden = !collapsed;
    hybridToggle.textContent = collapsed ? "Add a hybrid" : "Hide";
    hybridToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  // The toggle lives INSIDE the header bar, not in a flex row beside it.
  // Wrapping the <h3> in a sibling div made the bar a flex item, so its
  // negative-margin bleed only spanned its own width and the green
  // stopped partway across the card while the button hung off the end.
  // Every other card's header runs edge to edge; this one has to as well.
  const hybridCard = h("section", { className: "card" }, [
    h("h3", { className: "section-header gdu-section-header-action" }, [h("span", {}, "Hybrid (optional)"), hybridToggle]),
    hybridEmptyNote,
    hybridBody,
  ]);

  // Open on arrival only when there is something to look at.
  setHybridCollapsed(inputStore.hasNoHybridInput() && !String(state.hybrid.name || "").trim());

  // ---------------------------------------------------------------
  // Go
  // ---------------------------------------------------------------
  const goBtn = h(
    "button",
    {
      type: "button",
      className: "btn btn-primary btn-block gdu-go-btn",
      onclick: () => {
        const s = inputStore.getState();
        if (!s.location) {
          showToast("Set a field location first — GPS or ZIP.", { type: "error" });
          return;
        }
        if (!s.plantingIso) {
          showToast("Pick a planting date.", { type: "error" });
          return;
        }
        // A hybrid is optional. With none, the results screen shows the
        // accumulation curves for the location alone; with a bad partial
        // entry (a typo, a reversed pair) it still refuses, because that
        // is a mistake rather than a choice.
        const hybrid = inputStore.validatedHybrid();
        if (!hybrid.ok) {
          showToast(hybrid.error, { type: "error" });
          return;
        }
        navigate("results");
      },
    },
    "Calculate GDUs"
  );

  mount(
    container,
    h("div", { className: "screen" }, [
      createTopBar({ title: "GDU Calculator", onHome: () => navigate("calculator") }),
      h("main", { className: "screen-body" }, [locationCard, dateCard, hybridCard, goBtn]),
    ])
  );
}

/**
 * A numeric field that keeps the store in sync without fighting the
 * user mid-type: an empty box stores null rather than 0, so a
 * half-deleted "12" never reads as a real 12-GDU rating.
 */
function numberInput(ariaLabel, value, onChange, placeholder) {
  const input = h("input", {
    className: "text-input",
    type: "number",
    inputmode: "numeric",
    min: "1",
    step: "1",
    placeholder,
    "aria-label": ariaLabel,
    value: value === null || value === undefined ? "" : String(value),
    oninput: (e) => {
      const raw = e.target.value.trim();
      onChange(raw === "" ? null : Number(raw));
    },
  });
  return { input };
}
