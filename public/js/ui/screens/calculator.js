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
    // Coordinates deliberately not shown. They are the ZIP centroid, not
    // the field, and four decimal places implied a precision the ~6-15
    // mile grid behind them does not have.
    locationValueEl.appendChild(h("div", { className: "gdu-location-name" }, loc.label));
  }
  paintLocation();

  const locationNameInput = h("input", {
    className: "text-input",
    type: "text",
    "aria-label": "Location name",
    placeholder: "e.g. Brown home place",
    value: state.locationName || "",
    oninput: (e) => inputStore.setLocationName(e.target.value),
  });

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

  // Location and planting date are one card: they are the two things a
  // run cannot happen without, they are filled at the same moment, and
  // splitting them across two headers made a short form look long.
  const locationCard = h("section", { className: "card" }, [
    h("h3", { className: "section-header" }, "Location Details"),
    h("div", { className: "field" }, [h("label", { className: "field-label" }, "Location Name"), locationNameInput]),
    h("div", { className: "field" }, [
      h("label", { className: "field-label" }, "ZIP Code"),
      h("div", { className: "gdu-inline-row" }, [zipInput, zipBtn]),
      locationValueEl,
    ]),
    statusEl,
    h("div", { className: "field" }, [h("label", { className: "field-label" }, "Planting Date"), datePicker.el]),
    plantingNote,
    h(
      "p",
      { className: "field-note" },
      "Weather comes from a gridded reanalysis roughly 6 to 15 miles per cell, so every field in the same township returns the same numbers — a ZIP is as precise as this data gets."
    ),
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
        paintHybridField();
        closeSuggest();
        paintCatalogNote();
        paintResolved();
      },
    },
    [
      h("option", { value: "" }, "— Select brand —"),
      ...houseBrands.map((b) => h("option", { value: b.catalogBrandName }, b.catalogBrandName)),
      h("option", { value: "Other" }, "Other"),
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

  // The built-in list used to live behind a modal. It now hangs off this
  // field directly: type to filter, or tap and scroll the whole list.
  // One control instead of two, and no round trip through a dialog for
  // what is fundamentally "fill in this box".
  const suggestEl = h("div", { className: "gdu-suggest", role: "listbox", "aria-label": "Hybrid list" });
  let suggestOpen = false;
  let activeIdx = -1;

  const nameInput = h("input", {
    className: "text-input gdu-hybrid-input",
    type: "text",
    // The visible <label> isn't wired up with for/id, so screen readers
    // (and tests) had nothing stable to key on while the placeholder
    // moves with the Brand View.
    "aria-label": "Hybrid name",
    // A combobox has to announce itself as one, or a screen-reader user
    // gets a plain text box with an invisible list under it.
    role: "combobox",
    autocomplete: "off",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    placeholder: `e.g. ${brandedHybridName("09-90 PCE", brand)}`,
    value: state.hybrid.name || "",
    oninput: (e) => {
      inputStore.updateHybrid({ name: e.target.value });
      paintCatalogNote();
      openSuggest(e.target.value);
    },
    onfocus: () => openSuggest(nameInput.value),
    onkeydown: (e) => {
      if (e.key === "Escape") {
        closeSuggest();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!suggestOpen) return openSuggest(nameInput.value);
        moveActive(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (e.key === "Enter") {
        const rows = suggestEl.querySelectorAll(".gdu-suggest-option");
        if (!suggestOpen || rows.length === 0) return;
        e.preventDefault();
        // Enter with nothing highlighted takes the only match — the fast
        // path when someone types a variety number they already know.
        const pick = activeIdx >= 0 ? rows[activeIdx] : rows.length === 1 ? rows[0] : null;
        if (pick) pick.click();
      }
    },
    // A click on a row fires after blur, so hiding has to wait a beat or
    // the list is gone before the tap lands. The handle is kept so a
    // reopen can CANCEL it — otherwise a blur, then a reopen inside the
    // same 160 ms, leaves a stale timer that shuts the list a moment
    // after it was deliberately opened.
    onblur: () => {
      clearTimeout(blurTimer);
      blurTimer = setTimeout(closeSuggest, 160);
    },
  });

  /** @type {any} */
  let blurTimer = null;

  // The chevron matches the Brand select above it, and is a real button
  // rather than a background image: with the box already filled, tapping
  // it has to be able to reopen the full list, which focusing the text
  // alone would not do on a device where the field is already focused.
  const suggestChevron = h(
    "button",
    {
      type: "button",
      className: "gdu-suggest-chevron",
      tabindex: "-1", // the input owns the keyboard path; this is a pointer affordance
      "aria-label": "Show hybrid list",
      onmousedown: (e) => e.preventDefault(), // don't steal focus and fire blur
      onclick: () => {
        if (suggestOpen) return closeSuggest();
        nameInput.focus();
        openSuggest(nameInput.value);
      },
    },
    [chevronSvg()]
  );

  function closeSuggest() {
    clearTimeout(blurTimer);
    suggestOpen = false;
    activeIdx = -1;
    // Emptied, not just hidden: 133 stale rows left in the DOM outlive
    // the reason they were built, and the next open rebuilds them from
    // the current query anyway.
    suggestEl.textContent = "";
    suggestEl.hidden = true;
    nameInput.setAttribute("aria-expanded", "false");
  }
  closeSuggest();

  function moveActive(delta) {
    const rows = [...suggestEl.querySelectorAll(".gdu-suggest-option")];
    if (!rows.length) return;
    activeIdx = (activeIdx + delta + rows.length) % rows.length;
    rows.forEach((r, i) => r.classList.toggle("gdu-suggest-active", i === activeIdx));
    rows[activeIdx].scrollIntoView({ block: "nearest" });
  }

  // Placeholder and helper text both follow the Brand field: under
  // "Other" there is no list to filter and no house variety worth
  // showing as an example, and saying otherwise would be an instruction
  // that doesn't work.
  const hybridFieldNote = h("p", { className: "field-note" }, "");

  function paintHybridField() {
    // No list under Other, so no arrow promising one.
    suggestChevron.hidden = isOtherBrand();
    nameInput.classList.toggle("gdu-hybrid-input-listable", !isOtherBrand());
    if (isOtherBrand()) {
      nameInput.placeholder = "e.g. DKC62-08";
      hybridFieldNote.textContent = "Not one of ours, so there's no list to pick from — type the variety, then its GDU numbers off that brand's tech sheet.";
    } else {
      nameInput.placeholder = `e.g. ${brandedHybridName("09-90 PCE", brand)}`;
      hybridFieldNote.textContent = `Start typing to filter, or tap the box to scroll all ${FITTED_N}. Anything not on the list can be typed straight in.`;
    }
  }

  /** True when the Brand field is set to something other than our own. */
  function isOtherBrand() {
    return brandSelectEl.value === "Other";
  }

  function openSuggest(query) {
    // The built-in list is OUR genetics. Offering it under "Other" would
    // suggest a competitor hybrid can be looked up in it, and a rep who
    // picked one from the list would silently end up with our numbers
    // filed under somebody else's name.
    if (!catalog.isAvailable() || isOtherBrand()) return closeSuggest();
    // A value that exactly matches an entry is a hybrid already CHOSEN,
    // not a search in progress — so show the whole list, which is what
    // reopening a <select> does. Filtering by it would give a redundant
    // list of one, and an earlier build showed nothing at all, which
    // left a filled box with no way to browse to a different hybrid.
    clearTimeout(blurTimer);
    const matches = catalog.findByVariety(query) ? catalog.getAll() : catalog.search(query);
    suggestEl.textContent = "";
    activeIdx = -1;
    if (!matches.length) return closeSuggest();
    for (const hy of matches) {
      suggestEl.appendChild(
        h(
          "div",
          {
            className: "gdu-suggest-option",
            role: "option",
            "aria-selected": "false",
            onmousedown: (e) => e.preventDefault(), // keep focus so blur can't beat the click
            onclick: () => {
              applyCatalogHybrid(hy);
              closeSuggest();
            },
          },
          [
            h("span", { className: "gdu-suggest-name" }, brandedHybridName(hy.variety, brand)),
            h("span", { className: "gdu-suggest-meta" }, `${hy.rm} day · ${hy.gduToSilk.toLocaleString()} silk · ${hy.gduToBlackLayer.toLocaleString()} black layer`),
          ]
        )
      );
    }
    suggestOpen = true;
    suggestEl.hidden = false;
    nameInput.setAttribute("aria-expanded", "true");
  }

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

  // ---------------------------------------------------------------
  // Mode toggle
  // ---------------------------------------------------------------
  // Two mutually exclusive ways to run this: with a hybrid, or without.
  // A segmented control says that; two plain buttons said "here are two
  // things you can do", which is a different and less true statement.
  // Exactly one is always selected, so the card's state is never
  // ambiguous.
  const modeBtns = {};
  let hybridMode = !inputStore.hasNoHybridInput() || !!String(state.hybrid.name || "").trim();

  function paintMode() {
    for (const [key, btn] of Object.entries(modeBtns)) {
      const on = (key === "hybrid") === hybridMode;
      btn.classList.toggle("gdu-mode-btn-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function selectHybridMode() {
    hybridMode = true;
    paintMode();
    setHybridCollapsed(false);
    // Land the caret in the field they came here to fill.
    setTimeout(() => nameInput.focus(), 0);
  }

  function selectGduOnlyMode() {
    hybridMode = false;
    inputStore.clearHybrid();
    nameInput.value = "";
    rmInput.input.value = "";
    silkInput.input.value = "";
    blInput.input.value = "";
    closeSuggest();
    paintMode();
    setHybridCollapsed(true);
    paintCatalogNote();
    paintResolved();
    // "GDU Only" is a decision, not a setting — so it runs. It still
    // refuses when the two things a run actually needs are missing,
    // rather than bouncing the user to a screen that can only say the
    // same thing less clearly.
    const s2 = inputStore.getState();
    if (!s2.location) return showToast("Set a field location first — GPS or ZIP.", { type: "error" });
    if (!s2.plantingIso) return showToast("Pick a planting date.", { type: "error" });
    navigate("results");
  }

  modeBtns.hybrid = h(
    "button",
    { type: "button", className: "btn gdu-mode-btn gdu-pick-hybrid-btn", "aria-pressed": "false", onclick: selectHybridMode },
    "Enter Hybrid"
  );
  modeBtns.gduOnly = h(
    "button",
    { type: "button", className: "btn gdu-mode-btn gdu-clear-hybrid-btn", "aria-pressed": "false", onclick: selectGduOnlyMode },
    "GDU Only"
  );
  const modeToggle = h("div", { className: "gdu-mode-toggle", role: "group", "aria-label": "Calculate with a hybrid, or GDUs only" }, [
    modeBtns.hybrid,
    modeBtns.gduOnly,
  ]);

  // The catalog is a static JSON asset in the service worker precache, so
  // after the first visit this resolves off disk. Until it lands the
  // field still accepts typing — the list is an accelerator, not a gate.
  catalog.ensureLoaded().then(() => {
    paintCatalogNote();
  });

  const savedListEl = h("div", { className: "gdu-saved-list" });

  function paintSavedList() {
    const saved = inputStore.getState().saved;
    savedListEl.textContent = "";
    if (!saved.length) {
      savedListEl.appendChild(h("p", { className: "empty-state" }, "No saved locations yet."));
      return;
    }
    for (const item of saved) {
      // A migrated entry from the old saved-hybrids list has no location
      // or date. It still loads its hybrid, and says so rather than
      // showing a blank second line.
      const bits = [];
      if (item.location) bits.push(item.location.label);
      if (item.plantingIso) bits.push(`planted ${formatShort(item.plantingIso, { withYear: true })}`);
      if (item.hybrid && item.hybrid.name) {
        const hy = item.hybrid;
        const nums = hy.gduToSilk && hy.gduToBlackLayer ? ` (${hy.gduToSilk.toLocaleString()} / ${hy.gduToBlackLayer.toLocaleString()})` : "";
        bits.push(`${hy.name}${hy.rm ? ` · ${hy.rm} day` : ""}${nums}`);
      } else if (item.location) {
        bits.push("GDU only");
      }
      if (!bits.length) bits.push("hybrid only — no location saved");

      savedListEl.appendChild(
        h("div", { className: "gdu-saved-row" }, [
          h(
            "button",
            {
              type: "button",
              className: "gdu-saved-load",
              onclick: () => {
                inputStore.loadSavedLocation(item.id);
                const st = inputStore.getState();
                locationNameInput.value = st.locationName || "";
                if (st.location) {
                  zipInput.value = st.location.zip || "";
                  paintLocation();
                }
                if (st.plantingIso) datePicker.setValue(st.plantingIso);
                paintPlantingNote();
                const hy = st.hybrid;
                brandSelectEl.value = hy.brand || "";
                nameInput.value = hy.name || "";
                rmInput.input.value = hy.rm ?? "";
                silkInput.input.value = hy.gduToSilk ?? "";
                blInput.input.value = hy.gduToBlackLayer ?? "";
                hybridMode = !!(hy.name || hy.gduToSilk || hy.gduToBlackLayer || hy.rm);
                paintMode();
                setHybridCollapsed(!hybridMode);
                paintHybridField();
                paintCatalogNote();
                paintResolved();
                showToast(`Loaded ${item.name}.`, { type: "success", duration: 2500 });
              },
            },
            [
              h("span", { className: "gdu-saved-name" }, item.name),
              h("span", { className: "gdu-saved-meta" }, bits.join(" · ")),
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
                  title: "Delete location?",
                  message: `Remove ${item.name} from your saved list?`,
                  confirmLabel: "Delete",
                  destructive: true,
                });
                if (yes) {
                  inputStore.deleteSavedLocation(item.id);
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

  // The detail fields collapse to one line in GDU-only mode, so a
  // ZIP-and-date run isn't scrolling past four empty boxes to reach
  // Calculate. Collapsed is a VIEW state, not stored input — reopening
  // it finds exactly what was there.
  const hybridBody = h("div", { className: "gdu-hybrid-body" }, [
    h("div", { className: "field" }, [h("label", { className: "field-label" }, "Brand"), brandSelectEl]),
    h("div", { className: "field gdu-hybrid-field" }, [
      h("label", { className: "field-label" }, "Hybrid"),
      h("div", { className: "gdu-hybrid-input-wrap" }, [nameInput, suggestChevron]),
      suggestEl,
      hybridFieldNote,
    ]),
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
  ]);

  // Saving is its own card, deliberately OUTSIDE the collapsible hybrid
  // body. What gets saved is the whole setup — field, date and the
  // hybrid if there is one — so burying the button inside a section that
  // folds shut in GDU-only mode would have made a location impossible to
  // save without a hybrid.
  const savedCard = h("section", { className: "card" }, [
    h("h3", { className: "section-header" }, "Saved Locations"),
    h(
      "button",
      {
        type: "button",
        className: "btn btn-secondary btn-block gdu-save-hybrid-btn",
        onclick: () => {
          const res = inputStore.saveCurrentLocation();
          if (!res.ok) {
            showToast(res.error, { type: "error" });
            return;
          }
          paintSavedList();
          showToast("Location saved.", { type: "success", duration: 2500 });
        },
      },
      "Save This Location"
    ),
    savedListEl,
  ]);

  hybridBody.id = "gdu-hybrid-body";
  modeBtns.hybrid.setAttribute("aria-controls", "gdu-hybrid-body");

  const hybridEmptyNote = h(
    "p",
    { className: "field-note gdu-hybrid-empty" },
    "GDU only — Calculate will chart accumulation for this field and planting date, with no silk or black layer dates."
  );

  // The separate Hide/Add chevron in the header bar is gone: the mode
  // toggle IS the expander now, and two controls for one piece of state
  // is how they end up disagreeing.
  function setHybridCollapsed(collapsed) {
    hybridBody.hidden = collapsed;
    hybridEmptyNote.hidden = !collapsed;
    modeBtns.hybrid.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  const hybridCard = h("section", { className: "card" }, [
    h("h3", { className: "section-header" }, "Hybrid"),
    modeToggle,
    hybridEmptyNote,
    hybridBody,
  ]);

  // Arrive in whichever mode the stored input implies.
  paintHybridField();
  paintMode();
  setHybridCollapsed(!hybridMode);

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
      h("main", { className: "screen-body" }, [locationCard, hybridCard, savedCard, goBtn]),
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

/** The same chevron the Brand select draws, as an inline SVG. */
function chevronSvg() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 12 8");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M1 1.5 L6 6.5 L11 1.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.8");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}
