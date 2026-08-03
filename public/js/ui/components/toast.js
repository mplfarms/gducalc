// src/ui/components/toast.js
//
// A small dismissible status/error banner, used in place of native
// alert() — mirrors the Swift app's "Couldn't Export" alert pattern but
// as an unobtrusive on-screen banner instead of a blocking dialog.

import { h } from "../dom.js";

let containerEl = null;

function ensureContainer() {
  if (containerEl) return containerEl;
  containerEl = h("div", { className: "toast-container" });
  document.body.appendChild(containerEl);
  return containerEl;
}

/**
 * @param {string} message
 * @param {{type?: "info"|"error"|"success", duration?: number}} [opts]
 */
export function showToast(message, opts) {
  const type = (opts && opts.type) || "info";
  const duration = opts && typeof opts.duration === "number" ? opts.duration : 5000;
  const container = ensureContainer();

  const toastEl = h("div", { className: `toast toast-${type}` }, [
    h("span", { className: "toast-message" }, message),
    h(
      "button",
      {
        type: "button",
        className: "toast-close-btn",
        "aria-label": "Dismiss",
        onclick: () => remove(),
      },
      "✕"
    ),
  ]);

  function remove() {
    if (toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
  }

  container.appendChild(toastEl);

  if (duration > 0) {
    setTimeout(remove, duration);
  }

  return { dismiss: remove };
}
