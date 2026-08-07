// src/ui/components/topBar.js
//
// Shared toolbar — the same chrome-colored bar, white glyphs, permanent
// Home + Settings pattern as Corn Plot Harvest, so the two apps feel
// like one product.
//
// The home glyph is a corn ear rather than that app's barn: this app's
// "home" is a hybrid calculation, not a farm's plot book, and using a
// distinct silhouette keeps the two apps' home buttons from being
// confused with each other on a phone home screen. stroke="currentColor"
// so it tracks the bar's white text in both themes.

import { h } from "../dom.js";
import { navigate } from "../router.js";

const CORN_ICON_SVG = `
<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 2.5c3 2.2 4.5 5.6 4.5 9.2 0 4.2-2 7.6-4.5 9.8-2.5-2.2-4.5-5.6-4.5-9.8 0-3.6 1.5-7 4.5-9.2Z" />
  <path d="M12 4.5v16" />
  <path d="M9.2 8.2h5.6M8.6 11.6h6.8M9 15h6" />
</svg>
`.trim();

/**
 * @param {{title: string, onHome?: () => void, showHome?: boolean, onBack?: () => void, backLabel?: string, right?: Node|Node[]}} opts
 *   `showHome: false` omits the Home button entirely — used by the Home
 *   screen itself, where a button that reloads the screen you are
 *   already looking at reads as broken.
 */
export function createTopBar(opts) {
  const left = [];
  if (opts.showHome !== false) {
    left.push(
      h(
        "button",
        {
          type: "button",
          className: "top-bar-btn top-bar-btn-nav top-bar-btn-home",
          "aria-label": "Home",
          // Home is the brand landing screen, not the input form. It was
          // the input form until that screen existed, and the two things
          // it offers — an existing location or a new one — are exactly
          // what "home" should mean here.
          onclick: opts.onHome || (() => navigate("home")),
        },
        h("span", { className: "top-bar-home-icon", html: CORN_ICON_SVG })
      )
    );
  }
  if (opts.onBack) {
    left.push(
      h(
        "button",
        { type: "button", className: "top-bar-btn top-bar-btn-nav", "aria-label": opts.backLabel || "Back", onclick: opts.onBack },
        "‹"
      )
    );
  }

  const right = [];
  if (opts.right) right.push(opts.right);
  right.push(
    h(
      "button",
      { type: "button", className: "top-bar-btn top-bar-btn-settings", "aria-label": "Settings", onclick: () => navigate("settings") },
      "⚙"
    )
  );

  return h("header", { className: "top-bar" }, [
    h("div", { className: "top-bar-left" }, left),
    h("div", { className: "top-bar-title" }, opts.title),
    h("div", { className: "top-bar-right" }, right),
  ]);
}
