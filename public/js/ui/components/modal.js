// src/ui/components/modal.js
//
// A small custom modal/dialog system used instead of window.alert/confirm/
// prompt (which can't be styled and read badly on mobile). Used by the
// extendable wheel-select "+ Add New…" flow and by destructive-action
// confirmations ("Start a New Trial").

import { h, mount, clear } from "../dom.js";

let overlayEl = null;

function ensureOverlay() {
  if (overlayEl) return overlayEl;
  overlayEl = h("div", { className: "modal-overlay hidden" });
  document.body.appendChild(overlayEl);
  return overlayEl;
}

function closeModal() {
  const overlay = ensureOverlay();
  overlay.classList.add("hidden");
  clear(overlay);
}

/**
 * @param {{title: string, message?: string, confirmLabel?: string, cancelLabel?: string, destructive?: boolean}} opts
 * @returns {Promise<boolean>}
 */
export function showConfirm(opts) {
  return new Promise((resolve) => {
    const overlay = ensureOverlay();
    const finish = (result) => {
      closeModal();
      resolve(result);
    };

    const card = h("div", { className: "modal-card" }, [
      h("h3", { className: "modal-title" }, opts.title),
      opts.message ? h("p", { className: "modal-message" }, opts.message) : null,
      h("div", { className: "modal-actions" }, [
        h(
          "button",
          {
            type: "button",
            className: "btn btn-secondary",
            onclick: () => finish(false),
          },
          opts.cancelLabel || "Cancel"
        ),
        h(
          "button",
          {
            type: "button",
            className: opts.destructive ? "btn btn-danger" : "btn btn-primary",
            onclick: () => finish(true),
          },
          opts.confirmLabel || "OK"
        ),
      ]),
    ]);

    mount(overlay, card);
    overlay.classList.remove("hidden");
    overlay.onclick = (e) => {
      if (e.target === overlay) finish(false);
    };
  });
}

/**
 * @param {{title: string, message?: string, placeholder?: string, initialValue?: string, confirmLabel?: string, cancelLabel?: string}} opts
 * @returns {Promise<string|null>} null if cancelled
 */
export function showPrompt(opts) {
  return new Promise((resolve) => {
    const overlay = ensureOverlay();
    const finish = (result) => {
      closeModal();
      resolve(result);
    };

    const input = h("input", {
      type: "text",
      className: "modal-input",
      placeholder: opts.placeholder || "",
      value: opts.initialValue || "",
    });

    const submit = () => finish(input.value);

    const card = h("div", { className: "modal-card" }, [
      h("h3", { className: "modal-title" }, opts.title),
      opts.message ? h("p", { className: "modal-message" }, opts.message) : null,
      input,
      h("div", { className: "modal-actions" }, [
        h(
          "button",
          {
            type: "button",
            className: "btn btn-secondary",
            onclick: () => finish(null),
          },
          opts.cancelLabel || "Cancel"
        ),
        h(
          "button",
          {
            type: "button",
            className: "btn btn-primary",
            onclick: submit,
          },
          opts.confirmLabel || "Add"
        ),
      ]),
    ]);

    mount(overlay, card);
    overlay.classList.remove("hidden");
    overlay.onclick = (e) => {
      if (e.target === overlay) finish(null);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        finish(null);
      }
    });
    setTimeout(() => input.focus(), 0);
  });
}

/**
 * Generic modal with arbitrary body content and buttons, used for the
 * "searchable list" trait/seed-treatment picker.
 * @param {{title: string, bodyNode: Node, onClose?: () => void}} opts
 * @returns {{close: () => void}}
 */
export function showCustomModal(opts) {
  const overlay = ensureOverlay();
  const close = () => {
    closeModal();
    if (opts.onClose) opts.onClose();
  };
  // dismissable: false removes every way OUT other than what the body
  // itself provides (no ✕ button, overlay taps ignored) — for the rare
  // modal whose answers are REQUIRED before the app can continue (e.g.
  // the new-user Welcome! form, per explicit request — see
  // newUserDetailsModal.js). Default remains dismissable.
  const dismissable = !opts || opts.dismissable !== false;
  const card = h("div", { className: "modal-card modal-card-large" }, [
    h("div", { className: "modal-header" }, [
      h("h3", { className: "modal-title" }, opts.title),
      dismissable
        ? h(
            "button",
            { type: "button", className: "modal-close-btn", "aria-label": "Close", onclick: close },
            "✕"
          )
        : null,
    ]),
    opts.bodyNode,
  ]);
  mount(overlay, card);
  overlay.classList.remove("hidden");
  overlay.onclick = (e) => {
    if (e.target === overlay && dismissable) close();
  };
  return { close };
}
