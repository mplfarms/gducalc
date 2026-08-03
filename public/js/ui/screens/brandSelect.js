// src/ui/screens/brandSelect.js
//
// First-run Brand View picker. Deliberately a near-copy of Corn Plot
// Harvest's own brand-select screen — same Republic royal-blue field,
// same logo buttons, same copy rhythm — because a rep who has already
// used that app should recognize this one in the first half second.
//
// The Brand View is cosmetic here (it themes the app and pre-fills the
// hybrid's brand field); it does not change any calculation. That's
// stated on the screen so nobody wonders whether picking the wrong one
// skewed their numbers.

import { h, mount } from "../dom.js";
import { BRANDS } from "../brand.js";
import * as brandStore from "../stores/brandStore.js";
import { navigate } from "../router.js";
import { APP_VERSION } from "../../version.js";

export function render(container) {
  const buttons = Object.values(BRANDS).map((brand) =>
    h(
      "button",
      {
        type: "button",
        className: "brand-select-btn",
        onclick: () => {
          brandStore.selectBrand(brand.id);
          navigate("calculator");
        },
      },
      [
        h("img", { className: "brand-select-logo", src: brand.logo, alt: `${brand.displayName} logo` }),
        h("span", { className: "brand-select-name" }, brand.displayName),
      ]
    )
  );

  mount(
    container,
    h("div", { className: "screen brand-select-screen" }, [
      h("div", { className: "brand-select-content" }, [
        h("h1", { className: "brand-select-title" }, "GDU Calculator"),
        h("p", { className: "brand-select-subtitle" }, "Choose your Brand View"),
        h("div", { className: "brand-select-buttons" }, buttons),
      ]),
      h(
        "p",
        { className: "brand-select-footer" },
        `Brand View sets the app's colors and logo only — every GDU number is the same regardless. Change it any time in Settings. ${APP_VERSION}`
      ),
    ])
  );
}
