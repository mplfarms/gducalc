// src/core/location.js
//
// Two ways to answer "where is this field": the device's own GPS, and a
// ZIP code. Both end in the same place — a {lat, lon, label} — because
// everything downstream only cares about the coordinate.
//
// ZIP is worth supporting alongside GPS for a specific reason: a seed
// rep is usually NOT standing in the field they're calculating for.
// GPS answers "here", ZIP answers "the customer's place I'm driving to
// next", and both are normal ways to use this.
//
// Services used (both free, no key, CORS-enabled — same class of
// endpoint the Corn Plot app already relies on):
//   * api.zippopotam.us — US ZIP → lat/lon + city/state. Verified live.
//   * api.bigdatacloud.net reverse-geocode-client — coordinate → nearest
//     town, used only to put a human-readable label on a GPS fix. Purely
//     cosmetic; a failure here leaves the coordinate itself intact.

/**
 * @typedef {Object} FieldLocation
 * @property {number} lat
 * @property {number} lon
 * @property {string} label human-readable, e.g. "Missouri Valley, IA"
 * @property {"gps"|"zip"} source
 * @property {string|null} zip
 */

const ZIP_URL = "https://api.zippopotam.us/us/";
const REVERSE_GEOCODE_URL = "https://api.bigdatacloud.net/data/reverse-geocode-client";

/**
 * @param {string} zip 5-digit US ZIP
 * @returns {Promise<{ok: true, location: FieldLocation} | {ok: false, error: string}>}
 */
export async function lookupZip(zip) {
  const clean = String(zip || "").trim();
  if (!/^\d{5}$/.test(clean)) return { ok: false, error: "Enter a 5-digit ZIP code." };
  try {
    const res = await fetch(ZIP_URL + clean);
    // Zippopotam answers an unknown ZIP with a 404 and an empty body,
    // not an error object — so the status IS the signal here.
    if (res.status === 404) return { ok: false, error: `No US location found for ZIP ${clean}.` };
    if (!res.ok) return { ok: false, error: `ZIP lookup failed (HTTP ${res.status}).` };
    const body = await res.json();
    const place = body && body.places && body.places[0];
    if (!place) return { ok: false, error: `No US location found for ZIP ${clean}.` };
    const lat = Number(place.latitude);
    const lon = Number(place.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, error: "ZIP lookup returned no coordinates." };
    const city = place["place name"] || "";
    const st = place["state abbreviation"] || "";
    return {
      ok: true,
      location: {
        lat,
        lon,
        label: city && st ? `${city}, ${st} ${clean}` : clean,
        source: "zip",
        zip: clean,
      },
    };
  } catch (e) {
    return { ok: false, error: "ZIP lookup failed — check your connection." };
  }
}

/**
 * Device GPS. Wraps the callback-style geolocation API in a promise and
 * translates its numeric error codes into something a person can act on.
 * @param {{timeout?: number}} [opts]
 * @returns {Promise<{ok: true, location: FieldLocation} | {ok: false, error: string}>}
 */
export function requestDeviceLocation(opts) {
  const timeout = (opts && opts.timeout) || 15000;
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({ ok: false, error: "This browser can't provide a location. Enter a ZIP code instead." });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        const label = await reverseGeocodeLabel(lat, lon);
        resolve({
          ok: true,
          location: {
            lat,
            lon,
            label: label || `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
            source: "gps",
            zip: null,
          },
        });
      },
      (err) => {
        const messages = {
          1: "Location permission was denied. Allow it in your browser settings, or enter a ZIP code.",
          2: "Couldn't get a location fix. Try again outdoors, or enter a ZIP code.",
          3: "Location request timed out. Try again, or enter a ZIP code.",
        };
        resolve({ ok: false, error: messages[err && err.code] || "Couldn't get your location." });
      },
      { enableHighAccuracy: true, timeout, maximumAge: 0 }
    );
  });
}

/**
 * Best-effort "City, ST" for a coordinate. Returns null on any failure —
 * the caller falls back to showing the raw lat/lon, which is still a
 * perfectly usable label.
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<string|null>}
 */
export async function reverseGeocodeLabel(lat, lon) {
  try {
    const res = await fetch(`${REVERSE_GEOCODE_URL}?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    if (!res.ok) return null;
    const body = await res.json();
    const city = body.city || body.locality || "";
    const state = body.principalSubdivisionCode ? String(body.principalSubdivisionCode).replace(/^US-/, "") : "";
    if (city && state) return `${city}, ${state}`;
    return city || null;
  } catch (e) {
    return null;
  }
}
