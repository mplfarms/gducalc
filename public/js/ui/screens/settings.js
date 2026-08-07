// src/ui/screens/settings.js
//
// Brand View, appearance, cached-data control, version. Same three
// controls in the same order as Corn Plot Harvest's Settings screen, so
// muscle memory carries over.

import { h, mount } from "../dom.js";
import { createTopBar } from "../components/topBar.js";
import { navigate, rememberedOriginFor } from "../router.js";
import { showToast } from "../components/toast.js";
import { BRANDS } from "../brand.js";
import * as brandStore from "../stores/brandStore.js";
import * as themeStore from "../stores/themeStore.js";
import { clearCache } from "../../core/weather.js";
import { APP_VERSION } from "../../version.js";

export function render(container) {
  const selectedBrand = brandStore.getState().selectedBrand;
  const mode = themeStore.getState().mode;

  const brandControl = h(
    "div",
    { className: "segmented-control" },
    Object.values(BRANDS).map((b) =>
      h(
        "button",
        {
          type: "button",
          className: `segmented-btn brand-view-btn${b.id === selectedBrand ? " segmented-btn-active" : ""}`,
          "aria-label": b.displayName,
          "aria-pressed": b.id === selectedBrand ? "true" : "false",
          onclick: () => {
            brandStore.selectBrand(b.id);
            render(container);
          },
        },
        h("img", { className: "brand-view-logo", src: b.logo, alt: b.displayName })
      )
    )
  );

  const themeControl = h(
    "div",
    { className: "segmented-control" },
    [
      ["light", "Light"],
      ["dark", "Dark"],
      ["system", "System"],
    ].map(([value, label]) =>
      h(
        "button",
        {
          type: "button",
          className: `segmented-btn${value === mode ? " segmented-btn-active" : ""}`,
          "aria-pressed": value === mode ? "true" : "false",
          onclick: () => {
            themeStore.setMode(value);
            render(container);
          },
        },
        label
      )
    )
  );

  mount(
    container,
    h("div", { className: "screen" }, [
      createTopBar({
        title: "Settings",
        onBack: () => navigate(rememberedOriginFor("settings") || "home", { _skipOriginTracking: true }),
        backLabel: "Back",
      }),
      h("main", { className: "screen-body" }, [
        h("section", { className: "card" }, [
          h("h3", { className: "section-header" }, "Brand View"),
          brandControl,
          h("p", { className: "field-note" }, "Sets the app's colors and logo, and pre-fills the Brand field on a new hybrid. It does not change any calculation."),
        ]),
        h("section", { className: "card" }, [h("h3", { className: "section-header" }, "Appearance"), themeControl]),
        h("section", { className: "card" }, [
          h("h3", { className: "section-header" }, "Weather Data"),
          h(
            "p",
            { className: "field-note" },
            "The 30-year history for each location is cached on this device for the rest of the day so repeat checks are instant. Clearing it forces a fresh pull on the next calculation."
          ),
          h(
            "button",
            {
              type: "button",
              className: "btn btn-secondary btn-block",
              onclick: () => {
                clearCache();
                showToast("Cached weather data cleared.", { type: "success", duration: 2500 });
              },
            },
            "Clear Cached Weather Data"
          ),
        ]),
        h("section", { className: "card" }, [
          h("h3", { className: "section-header" }, "About"),
          h("button", { type: "button", className: "btn btn-secondary btn-block", onclick: () => navigate("help") }, "How GDUs Are Calculated"),
        ]),
        h("p", { className: "settings-version-footer" }, APP_VERSION),
      ]),
    ])
  );
}
