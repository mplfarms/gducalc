// Tiny hand-rolled pub/sub helper shared by all stores in src/ui/stores/.
// Each store keeps its own plain-object state and calls notify() after
// every mutation; subscribers are plain functions invoked with no args
// (callers re-read state via the store's getState()).

export function createPubSub() {
  /** @type {Set<Function>} */
  const listeners = new Set();
  return {
    /**
     * @param {Function} fn
     * @returns {Function} unsubscribe
     */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    notify() {
      for (const fn of Array.from(listeners)) {
        try {
          fn();
        } catch (e) {
          console.error("[store] subscriber threw", e);
        }
      }
    },
  };
}

/**
 * Debounce helper: returns a function that, when called repeatedly,
 * only invokes `fn` after `ms` milliseconds of quiet.
 * @param {Function} fn
 * @param {number} ms
 */
export function debounce(fn, ms) {
  let timer = null;
  const debounced = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  debounced.flush = (...args) => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    fn(...args);
  };
  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return debounced;
}

/**
 * @param {string} key
 * @param {*} fallback
 */
export function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[store] failed to read ${key}`, e);
    return fallback;
  }
}

/**
 * @param {string} key
 * @param {*} value
 */
export function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error(`[store] failed to write ${key}`, e);
  }
}
