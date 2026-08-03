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
import { BRANDS, getBrand } from "../brand.js";
import * as brandStore from "../stores/brandStore.js";
import * as inputStore from "../stores/inputStore.js";
import { navigate } from "../router.js";
import { lookupZip, requestDeviceLocation } from "../../core/location.js";
import { openHybridPicker } from "../components/hybridPicker.js";
import * as catalog from "../../core/hybridCatalog.js";
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
      locationValueEl.appendChild(h("span", { className: "gdu-location-empty" }, "No field location set yet."));
      return;
    }
    locationValueEl.appendChild(h("div", { className: "gdu-location-name" }, loc.label));
    locationValueEl.appendChild(
      h("div", { className: "gdu-location-coords" }, `${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)} · ${loc.source === "gps" ? "device GPS" : "ZIP centroid"}`)
    );
  }
  paintLocation();

  const gpsBtn = h(
    "button",
    {
      type: "button",
      className: "btn btn-secondary btn-block",
      onclick: async () => {
        gpsBtn.disabled = true;
        setStatus("Getting your location…", "locating");
        const res = await requestDeviceLocation();
        gpsBtn.disabled = false;
        if (!res.ok) {
          setStatus(res.error, "failure");
          return;
        }
        inputStore.setLocation(res.location);
        paintLocation();
        setStatus(`Location set to ${res.location.label}.`, "success");
      },
    },
    "Use My Location"
  );

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
    statusEl,
    gpsBtn,
    h("div", { className: "gdu-or-divider" }, "or"),
    h("div", { className: "field" }, [
      h("label", { className: "field-label" }, "ZIP Code"),
      h("div", { className: "gdu-inline-row" }, [zipInput, zipBtn]),
    ]),
    h(
      "p",
      { className: "field-note" },
      "Weather comes from a gridded reanalysis about 6 to 15 miles per cell, so a ZIP centroid and a GPS pin inside the same township usually return identical numbers."
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
  const brandSelectEl = h(
    "select",
    {
      className: "text-input",
      "aria-label": "Brand",
      onchange: (e) => inputStore.updateHybrid({ brand: e.target.value }),
    },
    [
      h("option", { value: "" }, "— Select brand —"),
      ...Object.values(BRANDS).map((b) => h("option", { value: b.catalogBrandName }, b.catalogBrandName)),
      h("option", { value: "Other" }, "Other / competitor"),
    ]
  );
  // Default the brand field to the active Brand View — it's right far
  // more often than not, and it's one less tap.
  brandSelectEl.value = state.hybrid.brand || (brand ? brand.catalogBrandName : "");
  if (brandSelectEl.value !== (state.hybrid.brand || "")) inputStore.updateHybrid({ brand: brandSelectEl.value });

  const nameInput = h("input", {
    className: "text-input",
    type: "text",
    placeholder: "e.g. 09-90 PCE",
    value: state.hybrid.name || "",
    oninput: (e) => {
      inputStore.updateHybrid({ name: e.target.value });
      paintCatalogNote();
    },
  });

  const silkInput = numberInput("GDUs to silk", state.hybrid.gduToSilk, (v) => {
    inputStore.updateHybrid({ gduToSilk: v });
    paintCatalogNote();
  }, "1250");
  const blInput = numberInput("GDUs to black layer", state.hybrid.gduToBlackLayer, (v) => {
    inputStore.updateHybrid({ gduToBlackLayer: v });
    paintCatalogNote();
  }, "2650");

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
    inputStore.updateHybrid({ name: hy.variety, gduToSilk: hy.gduToSilk, gduToBlackLayer: hy.gduToBlackLayer, rm: hy.rm });
    nameInput.value = hy.variety;
    silkInput.input.value = String(hy.gduToSilk);
    blInput.input.value = String(hy.gduToBlackLayer);
    paintCatalogNote();
  }

  const pickBtn = h(
    "button",
    {
      type: "button",
      className: "btn btn-secondary btn-block gdu-pick-hybrid-btn",
      disabled: true,
      onclick: () =>
        openHybridPicker({
          value: inputStore.getState().hybrid.name,
          onChange: (hy) => {
            applyCatalogHybrid(hy);
            showToast(`Loaded ${hy.variety} — ${hy.gduToSilk.toLocaleString()} silk / ${hy.gduToBlackLayer.toLocaleString()} black layer.`, { type: "success", duration: 3000 });
          },
        }),
    },
    "Loading hybrid list…"
  );

  // The catalog is a static JSON asset in the service worker precache, so
  // after the first visit this resolves off disk and the button is
  // enabled before anyone can look at it. On a cold first load it stays
  // disabled for a beat rather than opening an empty picker.
  catalog.ensureLoaded().then(() => {
    if (catalog.isAvailable()) {
      pickBtn.disabled = false;
      pickBtn.textContent = `Choose from Hybrid List (${catalog.getAll().length})`;
    } else {
      pickBtn.textContent = "Hybrid list unavailable — enter numbers below";
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
                silkInput.input.value = s.gduToSilk ?? "";
                blInput.input.value = s.gduToBlackLayer ?? "";
                paintCatalogNote();
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

  const hybridCard = h("section", { className: "card" }, [
    h("h3", { className: "section-header" }, "Hybrid"),
    pickBtn,
    h("div", { className: "gdu-or-divider" }, "or enter it yourself"),
    h("div", { className: "field" }, [h("label", { className: "field-label" }, "Brand"), brandSelectEl]),
    h("div", { className: "field" }, [h("label", { className: "field-label" }, "Hybrid"), nameInput]),
    h("div", { className: "gdu-two-col" }, [
      h("div", { className: "field" }, [h("label", { className: "field-label" }, "GDUs to Silk"), silkInput.input]),
      h("div", { className: "field" }, [h("label", { className: "field-label" }, "GDUs to Black Layer"), blInput.input]),
    ]),
    catalogNote,
    h(
      "p",
      { className: "field-note" },
      "Anything not on the built-in list can be typed in directly — use the numbers off that brand's own tech sheet. The built-in ratings are reproduced exactly as supplied and are never derived from relative maturity."
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
