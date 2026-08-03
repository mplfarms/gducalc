// src/core/weather.js
//
// All network access for temperature data. Two endpoints, both free,
// both no-API-key, both CORS-enabled (verified live from a browser
// against this exact parameter set before this file was written):
//
//   1. archive-api.open-meteo.com/v1/archive — ERA5 reanalysis, daily
//      max/min back to 1940 on a ~9-25 km grid. One request covers the
//      whole 30-year baseline AND the current season to date: a
//      1996-01-01 → today pull for a single point measured ~250 KB and
//      ~2.5 s, with zero null days. Splitting it per-year would be 30
//      round trips for the same bytes.
//
//   2. api.open-meteo.com/v1/forecast?forecast_days=16 — the 16-day
//      outlook, used to extend the current season past the last
//      observed day before the climatological projection takes over.
//
// Everything here fails soft and returns a structured error rather than
// throwing: this app is useless without data, so the UI needs to be
// able to say WHICH part failed (no signal? bad ZIP? Open-Meteo down?)
// instead of showing a blank chart.
//
// Units are requested in °F directly from the API rather than converted
// client-side. GDU base 50 / cap 86 are °F thresholds, and rounding a
// converted value at the wrong step is a classic source of off-by-a-few
// GDU drift against other tools.

import { todayIso } from "./dates.js";

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const CACHE_PREFIX = "gdu.wx.";
// Two locations' worth of 30-year history is ~500 KB — comfortably
// inside a 5 MB localStorage budget while still making "check my home
// farm, check the other farm, go back" instant. A third entry evicts
// the oldest.
const MAX_CACHED_LOCATIONS = 2;

/**
 * Coordinates are rounded to 2 decimals (~1.1 km) for the cache key.
 * The underlying grid cell is 9-25 km across, so two points 500 m apart
 * return byte-identical data — caching them separately would just evict
 * each other.
 */
function cacheKey(lat, lon, startYear) {
  return `${CACHE_PREFIX}${lat.toFixed(2)},${lon.toFixed(2)},${startYear}`;
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // The archive gains a new day every day; anything fetched on an
    // earlier calendar date is stale for the current season even though
    // its 30-year tail is still perfectly good.
    if (parsed.fetchedOn !== todayIso()) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function writeCache(key, value) {
  try {
    const existing = Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX));
    if (existing.length >= MAX_CACHED_LOCATIONS) {
      // Cheapest sensible eviction: drop everything but the entry we're
      // about to write. There are at most a couple of keys, and a true
      // LRU would need its own bookkeeping for no real benefit here.
      for (const k of existing) if (k !== key) localStorage.removeItem(k);
    }
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // Quota exceeded / private-browsing localStorage. Caching is an
    // optimization, never a requirement — the fetch already succeeded.
    console.warn("[weather] could not cache", e);
  }
}

/** Clears every cached location (Settings > Clear cached weather data). */
export function clearCache() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
    }
  } catch (e) {
    /* nothing actionable */
  }
}

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) {
    // Open-Meteo returns its own {error:true, reason:"..."} body on a
    // bad parameter — surface that reason rather than a bare status.
    const reason = body && body.reason ? body.reason : `HTTP ${res.status}`;
    throw new Error(reason);
  }
  if (body.error) throw new Error(body.reason || "Weather service error");
  return body;
}

/**
 * Pulls everything the season engine needs for one point.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number} startYear first year of the baseline window
 * @returns {Promise<{ok: true, archive: Object, forecast: Object|null, forecastError: string|null, cached: boolean} | {ok: false, error: string}>}
 */
export async function loadTemperatureData(lat, lon, startYear) {
  const key = cacheKey(lat, lon, startYear);
  const cached = readCache(key);
  if (cached) return { ok: true, archive: cached.archive, forecast: cached.forecast, forecastError: null, cached: true };

  const common = `latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=auto`;
  const archiveUrl = `${ARCHIVE_URL}?${common}&start_date=${startYear}-01-01&end_date=${todayIso()}`;
  const forecastUrl = `${FORECAST_URL}?${common}&forecast_days=16`;

  let archive;
  try {
    archive = await getJson(archiveUrl);
  } catch (e) {
    return { ok: false, error: `Couldn't load historical weather: ${e.message}` };
  }

  // The forecast is an enhancement, not a requirement — without it the
  // projection simply starts from the last observed day instead of 16
  // days later. A forecast outage should not blank the whole screen, so
  // its failure is reported alongside a successful result rather than
  // as one.
  let forecast = null;
  let forecastError = null;
  try {
    forecast = await getJson(forecastUrl);
  } catch (e) {
    forecastError = e.message;
  }

  writeCache(key, { fetchedOn: todayIso(), archive, forecast });
  return { ok: true, archive, forecast, forecastError, cached: false };
}

/**
 * Normalizes an Open-Meteo daily payload into the shape buildDailyIndex
 * expects, trimming any trailing all-null tail (the archive occasionally
 * returns "today" as a null row early in the morning before that day's
 * reanalysis lands).
 * @param {Object|null} payload
 * @param {"observed"|"forecast"} source
 * @returns {{time: string[], tmax: (number|null)[], tmin: (number|null)[], source: string}}
 */
export function toSeries(payload, source) {
  const daily = (payload && payload.daily) || {};
  const time = daily.time || [];
  const tmax = daily.temperature_2m_max || [];
  const tmin = daily.temperature_2m_min || [];
  let end = time.length;
  while (end > 0 && (tmax[end - 1] === null || tmin[end - 1] === null)) end--;
  return { time: time.slice(0, end), tmax: tmax.slice(0, end), tmin: tmin.slice(0, end), source };
}
