// src/ui/screens/savedLocations.js
//
// Every saved location, on a screen of its own, reached from the Home
// screen's primary button.
//
// The list itself is the shared component — the same one the input form
// renders inside its Saved Locations card — so the rows, the summary
// lines, the delete confirmation and the "does this row have enough to
// calculate" guards cannot drift between the two places they appear.
// The only thing this screen adds is the frame around it.

import { h, mount } from "../dom.js";
import { createTopBar } from "../components/topBar.js";
import { createSavedLocationList } from "../components/savedLocationList.js";
import * as inputStore from "../stores/inputStore.js";
import { navigate } from "../router.js";

export function render(container) {
  // Tapping a row calculates and leaves for the results screen, so this
  // list is never long-lived enough to need a live subscription — but a
  // delete repaints it in place, and an empty list has to stop offering
  // an empty list.
  const list = createSavedLocationList({
    emptyText: "No saved locations yet. Add one and it shows up here.",
    // There is no form on this screen, so an entry that cannot calculate
    // has to be handed to one rather than leaving the user looking at a
    // toast with nothing to act on.
    sendToFormWhenIncomplete: true,
    onChanged: () => paintHint(),
  });

  // The card header carries the COUNT rather than repeating the screen
  // title that sits two lines above it in the top bar.
  const header = h("h3", { className: "section-header" }, "");
  const hint = h("p", { className: "field-note" }, "");
  function paintHint() {
    const n = inputStore.getState().saved.length;
    header.textContent = n ? `${n} Saved ${n === 1 ? "Location" : "Locations"}` : "Saved Locations";
    hint.textContent = n
      ? "Tap a location to calculate it. Locations are saved on this device only."
      : "Locations are saved from the input screen, once you've given one a name.";
  }
  paintHint();

  mount(
    container,
    h("div", { className: "screen" }, [
      // Home only. A Back button whose destination is also Home put two
      // controls labelled "Home" on one bar — a screen reader read
      // "Home button, Home button, Settings button", and the "‹" chevron
      // looked like it would return to wherever you came from when it
      // could only ever do one thing.
      createTopBar({ title: "Saved Locations" }),
      h("main", { className: "screen-body" }, [
        h("section", { className: "card" }, [header, list.el, hint]),
        h(
          "button",
          {
            type: "button",
            className: "btn btn-secondary btn-block",
            onclick: () => {
              inputStore.startNewLocation();
              navigate("calculator");
            },
          },
          "Add a Location"
        ),
      ]),
    ])
  );
}
