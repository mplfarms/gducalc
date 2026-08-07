// src/ui/screens/home.js
//
// The brand-view landing screen: the app's home once a Brand View has
// been chosen. Brand logo on the brand's own chrome color, and the two
// things a rep actually opens the app to do.
//
// Deliberately the same layout as Corn Plot Harvest's plot chooser —
// same .home-hero / .home-logo / .home-btn classes out of the shared
// stylesheet, not a copy of them — so a rep who uses both apps finds the
// same shape in the same place. The one filled white button is the
// common path; the outlined one is the alternative. That hierarchy is
// the point of the screen: two equally-weighted buttons would just be a
// menu.
//
// Why this exists at all: before it, choosing a Brand View dropped you
// straight onto the input form, which is the right screen for "new
// field" and the wrong one for "check the field I set up last week" —
// the saved list was three-quarters of the way down that form. Saved
// Locations is the more common trip and now it is one tap from launch.

import { h, mount } from "../dom.js";
import { createTopBar } from "../components/topBar.js";
import { getBrand } from "../brand.js";
import * as brandStore from "../stores/brandStore.js";
import * as inputStore from "../stores/inputStore.js";
import { navigate } from "../router.js";
import { APP_VERSION } from "../../version.js";

/**
 * The logo badge.
 *
 * Crow's gets a white CIRCLE rather than the white rounded rectangle the
 * other two use — its rooster mark is drawn to sit in one, and the
 * shared stylesheet already carries both treatments (see
 * .home-logo-circle in styles.css, which explains why the circular clip
 * lives on a wrapper div rather than on the img itself).
 */
function homeLogo(brand) {
  if (brand.id === "crows") {
    return h("div", { className: "home-logo-circle" }, h("img", { className: "home-logo-circle-img", src: brand.logo, alt: `${brand.displayName} logo` }));
  }
  return h("img", { className: "home-logo", src: brand.logo, alt: `${brand.displayName} logo` });
}

export function render(container) {
  const brand = getBrand(brandStore.getState().selectedBrand);
  // The router sends anyone without a Brand View to brand-select before
  // this screen can render, so `brand` is set in practice. Falling back
  // rather than dereferencing null keeps a stale #/home bookmark from
  // being a white screen.
  if (!brand) {
    navigate("brand-select");
    return;
  }

  const savedCount = inputStore.getState().saved.length;

  mount(
    container,
    h("div", { className: "screen home-screen" }, [
      // No Home button on the Home screen — a button that reloads the
      // screen you are already on reads as broken. Settings still needs
      // to be reachable, so the bar stays.
      createTopBar({ title: brand.displayName, onHome: null, showHome: false }),
      h("div", { className: "home-hero" }, [
        h("div", { className: "home-hero-top" }, [h("h1", { className: "home-title" }, "GDU Calculator"), homeLogo(brand)]),
        h("div", { className: "home-actions" }, [
          h(
            "button",
            { type: "button", className: "home-btn home-btn-primary", onclick: () => navigate("saved-locations") },
            [
              "Saved Locations",
              // The count is the useful part: it says at a glance whether
              // there is anything behind the button before you spend a
              // tap finding out.
              savedCount ? h("span", { className: "home-btn-badge" }, String(savedCount)) : null,
            ]
          ),
          h(
            "button",
            {
              type: "button",
              className: "home-btn home-btn-secondary",
              onclick: () => {
                // "Add" means a new one. Landing on the form still
                // holding the last field's ZIP, date and hybrid is how
                // someone ends up overwriting a saved location by
                // filling in a name and hitting Save.
                inputStore.startNewLocation();
                navigate("calculator");
              },
            },
            "Add Location"
          ),
          // Inside the hero, not below it. As a sibling it sat on the
          // page background — a pale strip cutting across the bottom of
          // an otherwise full-bleed brand color, with white-on-white
          // text in it.
          h("p", { className: "home-version" }, APP_VERSION),
        ]),
      ]),
    ])
  );
}
