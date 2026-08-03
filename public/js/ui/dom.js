// src/ui/dom.js
//
// Minimal DOM-construction helper used by every screen/component in this
// no-framework app. `h(tag, attrs, children)` creates an element, applies
// attrs (with special-cased `on*` event handlers, `className`, `style`
// object, and `dataset`), and appends children (strings, nodes, or
// arrays thereof, nulls/undefined skipped).

/**
 * @param {string} tag
 * @param {Object<string, any>|null} [attrs]
 * @param {Array<Node|string|null|undefined>|Node|string} [children]
 * @returns {HTMLElement}
 */
export function h(tag, attrs, children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "className") {
        el.className = value;
      } else if (key === "style" && typeof value === "object") {
        Object.assign(el.style, value);
      } else if (key === "dataset" && typeof value === "object") {
        Object.assign(el.dataset, value);
      } else if (key.startsWith("on") && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === "html") {
        el.innerHTML = value;
      } else if (value === true) {
        el.setAttribute(key, "");
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  if (children === null || children === undefined) return;
  if (Array.isArray(children)) {
    for (const c of children) appendChildren(el, c);
    return;
  }
  if (typeof children === "string" || typeof children === "number") {
    el.appendChild(document.createTextNode(String(children)));
    return;
  }
  if (children instanceof Node) {
    el.appendChild(children);
    return;
  }
}

/** Removes all children from a container. */
export function clear(container) {
  while (container.firstChild) container.removeChild(container.firstChild);
}

/**
 * Mounts `node` into `container`, replacing any existing content.
 * @param {HTMLElement} container
 * @param {Node} node
 */
export function mount(container, node) {
  clear(container);
  container.appendChild(node);
}

/**
 * Wraps a tap/click handler so a duplicate activation arriving within
 * `ms` of the last one is dropped instead of re-running it.
 *
 * Reproduced with real touch-event emulation (not just theorized): a
 * single tap on mobile can dispatch more than one "click" event in quick
 * succession — one targeting whatever element sits at the exact touch
 * coordinate (often an inner <span>/<div>), and a second targeting the
 * tappable ancestor itself. A plain toggle/select handler run twice
 * means "opens and immediately closes again", or a second stray
 * selection landing on whatever the first click's re-render shifted
 * into that screen position — which is exactly what "the lists don't
 * work on mobile" looks like from the outside, even though desktop
 * mouse clicks (always exactly one per click) never show it.
 *
 * Use this directly (`onclick: debounceGuard(fn)`) for a handler on an
 * element that is NOT rebuilt in between the duplicate events (e.g. a
 * static modal button, or a list option whose click closes the whole
 * list rather than re-rendering it in place) — each call creates its
 * own private clock, which is fine there since both duplicate events
 * land on the same still-attached closure.
 *
 * For a component that rebuilds its own DOM (and therefore creates a
 * brand-new handler closure) as part of handling the very first of the
 * two duplicate events — the wheel picker's expand/collapse and
 * select-and-close both do this — a fresh per-call clock would not
 * catch the second event, since it targets a different closure
 * instance. Use `createTapGuard()` once per component instance instead,
 * and wrap every handler in that instance with the single `guard`
 * function it returns, so they all share one clock.
 * @param {(...args: any[]) => void} fn
 * @param {number} [ms]
 * @returns {(...args: any[]) => void}
 */
export function debounceGuard(fn, ms = 80) {
  return createTapGuard(ms)(fn);
}

/**
 * The default window is deliberately short (80ms): its job is only to
 * collapse the two clicks the browser dispatches for one physical tap
 * (which land within a handful of milliseconds of each other), not to
 * rate-limit the user. createTapGuard's clock is shared across every
 * handler in a component instance (header + every option + add-new), so
 * a window much longer than one tap's own event burst would also eat
 * the *next*, entirely deliberate tap if the user acts quickly — e.g.
 * tap to expand, immediately tap an option.
 * @param {number} [ms]
 * @returns {(fn: (...args: any[]) => void) => (...args: any[]) => void}
 */
export function createTapGuard(ms = 80) {
  let last = 0;
  return function guard(fn) {
    return (...args) => {
      const now = Date.now();
      if (now - last < ms) return;
      last = now;
      fn(...args);
    };
  };
}
