// src/core/location.js
//
// ZIP code to a {lat, lon, label}. That's the whole module.
//
// Device GPS was here and was removed, per explicit request. Two things
// made it easy to give up: a seed rep is usually NOT standing in the
// field being calculated — they're at the shop or driving to the next
// customer, so "here" is the wrong answer more often than the right one
// — and the weather behind all of this is a 6-to-15-mile grid, on which
// a GPS fix and the ZIP centroid for the same township return byte-
// identical numbers. It cost a permission prompt and an HTTPS-only code
// path to be no more accurate than typing five digits.
//
// api.zippopotam.us is free, needs no key, is CORS-enabled, and was
// verified live against real ZIPs before this was written.

/**
 * @typedef {Object} FieldLocation
 * @property {number} lat
 * @property {number} lon
 * @property {string} label human-readable, e.g. "Missouri Valley, IA"
 * @property {"zip"} source
 * @property {string} zip
 */

const ZIP_URL = "https://api.zippopotam.us/us/";

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
