// src/ui/brand.js (served at public/js/ui/brand.js)
//
// Brand palettes + theming, mirrors Theme.swift/Brand.swift. Three
// brands, each with a set of colors that stay fixed across light/dark
// mode (accent, accentLight, accentPale, highlight, chrome, danger) plus
// light/dark variants for backgrounds and cards.

/** @typedef {"midwestSeedGenetics"|"ncPlus"|"crows"} BrandId */

export const BRANDS = {
  midwestSeedGenetics: {
    id: "midwestSeedGenetics",
    accent: "#09452C",
    accentLight: "#4C9A6B",
    accentPale: "#9CC93B",
    highlight: "#FEBE10",
    chrome: "#08341F",
    cardLight: "#F4F8F1",
    danger: "#C94A4A",
    bgLight: "#F4F8F1",
    bgDark: "#04140C",
    cardDark: "#0C4A2C",
    displayName: "Midwest Seed Genetics",
    // The exact string this brand is stored as in the Brand / Company
    // catalog (DefaultLists.json's "companies" list) and therefore on
    // every PlotEntry.brand value for it — used anywhere brand data needs
    // to be matched or defaulted against real entries (see
    // trialStore.js's defaultBrandForNewEntry() and
    // yieldCalculator.js's orderBrandFirst()). displayName above is for
    // cosmetic UI text only (logo alt text, email subject lines) and
    // isn't guaranteed to match the catalog string — for Midwest the two
    // happen to be identical, but they are NOT for NC+ (see below).
    catalogBrandName: "Midwest Seed Genetics",
    logo: "/logos/midwest.png",
    operationsEmail: "operations@midwestseed.com",
  },
  ncPlus: {
    id: "ncPlus",
    accent: "#D7282F",
    accentLight: "#E2555B",
    accentPale: "#EDA0A3",
    highlight: "#FFDC32",
    // Chrome (the top bar / browser theme-color background) uses NC+'s
    // official "Seed Corn+" identity blue directly (HEX 215AA8, per NC+
    // Brand Standards Annex I) rather than the brand red — requested so
    // the app's dominant background reads as NC+ blue, not red.
    chrome: "#215AA8",
    // bgLight/bgDark/cardDark are pale/dark tints of that same blue,
    // mirroring how Midwest's bgLight/bgDark are tints of its accent
    // rather than the saturated brand color itself (keeps body text
    // readable). Accent/highlight stay the brand's red/yellow — those
    // are used for buttons and small highlights, not backgrounds.
    cardLight: "#EAF1F8",
    danger: "#C94A4A",
    bgLight: "#EAF1F8",
    bgDark: "#071633",
    cardDark: "#163E73",
    displayName: "NC+",
    // The catalog (DefaultLists.json) lists this brand's company entry as
    // "NC+ Hybrids", not "NC+" — see the comment on Midwest's
    // catalogBrandName above for why this field exists separately from
    // displayName.
    catalogBrandName: "NC+ Hybrids",
    logo: "/logos/ncplus.png",
    operationsEmail: "operations@nc-pluse.com",
  },
  // Per explicit request, added as a 3rd Brand View. Crow's official
  // standards (per the brand sheet provided) specify exactly two colors —
  // black (PMS Black 6, HEX 231f20) and red (PMS 7621, HEX b12028) — no
  // third accent hue is defined. accentLight/accentPale below are just
  // lighter tints of that same red (matching how NC+'s own accentLight/
  // accentPale are tints of ITS red), and `highlight` is a muted gold NOT
  // from Crow's standards — every brand needs some light, high-visibility
  // color for status banners that still reads with the fixed dark text
  // color those banners use (see .update-banner/.badge-current/etc in
  // styles.css), and gold/yellow is what the other two brands already use
  // for that same role. If Crow's has an official secondary color, swap
  // this value for it.
  crows: {
    id: "crows",
    accent: "#B12028",
    accentLight: "#C8565C",
    accentPale: "#E9AEB1",
    highlight: "#D9A441",
    // Chrome (top bar / browser theme-color background) is Crow's black —
    // matches the black nav bar on crowsseed.com and the brand sheet's
    // PMS Black 6.
    chrome: "#231F20",
    cardLight: "#F5F4F3",
    danger: "#C94A4A",
    bgLight: "#F5F4F3",
    bgDark: "#141313",
    cardDark: "#2A2827",
    displayName: "Crow's",
    // Matches DefaultLists.json's "companies"/"hybridDefaultBrands" entry
    // exactly (see listsStore.js's HYBRID_HYPHEN_ONLY_BRANDS comment,
    // which already calls out Crow's as a hybridDefaultBrand distinct
    // from Midwest/NC+).
    catalogBrandName: "Crow's",
    // The real rooster-mark + "CROW'S" wordmark logo, provided directly —
    // background made transparent to match midwest.png/ncplus.png's
    // format (see public/logos/crows.png).
    logo: "/logos/crows.png",
    // Best guess from crowsseed.com's domain — confirm/correct with Mike.
    operationsEmail: "operations@crowsseed.com",
  },
};

/**
 * @param {string|null|undefined} brandId
 * @returns {typeof BRANDS[BrandId]|null}
 */
export function getBrand(brandId) {
  if (!brandId) return null;
  return BRANDS[brandId] || null;
}

// Midwest Seed Genetics, NC+ Hybrids, and Crow's are the same underlying
// genetics sold under three regional labels — that's the whole reason
// entriesForBrandView() below relabels between them (per explicit
// request extending Crow's into this group exactly like Midwest/NC+
// already worked). Every brand listed here is a mutual rebadge partner
// of every OTHER brand in the list — not just a fixed pair — so adding a
// 4th rebadge brand later just means appending its id here, not
// rewriting the matching logic. A brand NOT in this group (a genuinely
// separate third-party company, or a future Brand View that isn't a
// rebadge of the others) is simply left out of this list and
// entriesForBrandView() leaves its entries untouched.
const REBADGE_GROUP_BRAND_IDS = ["midwestSeedGenetics", "ncPlus", "crows"];

// Each rebadge brand also has its own 2-letter hybrid-name code — the
// SAME hybrid genetics gets entered under a different code per brand
// (e.g. "MW 09-90 PCE" under Midwest is the identical hybrid as
// "NC 09-90 PCE" under NC+ and "CR 09-90 PCE" under Crow's — per
// explicit request/example). entriesForBrandView() swaps this prefix
// alongside the .brand field, so an entry relabeled from NC+ to Midwest
// shows BOTH "Midwest Seed Genetics" AND "MW 09-90 PCE" — never a
// relabeled brand sitting next to a stale other-brand hybrid prefix.
const HYBRID_CODE_BY_BRAND_ID = {
  midwestSeedGenetics: "MW",
  ncPlus: "NC",
  crows: "CR",
};

/**
 * Swaps a leading "<CODE> " hybrid-name prefix (one of
 * HYBRID_CODE_BY_BRAND_ID's codes, case-insensitive) for `toBrand`'s own
 * code — e.g. "nc 09-90 pce" (from-code "NC") -> "MW 09-90 pce" when
 * relabeling to Midwest. Only swaps when the hybrid actually starts with
 * `fromBrand`'s own code; anything else (a hybrid with no recognized
 * prefix at all, e.g. "P1185Q", or one that's inconsistent with its
 * entry's real brand) is left exactly as typed rather than guessed at.
 * @param {string} hybrid
 * @param {typeof BRANDS[BrandId]} fromBrand
 * @param {typeof BRANDS[BrandId]} toBrand
 * @returns {string}
 */
function swapHybridBrandCode(hybrid, fromBrand, toBrand) {
  const fromCode = HYBRID_CODE_BY_BRAND_ID[fromBrand.id];
  const toCode = HYBRID_CODE_BY_BRAND_ID[toBrand.id];
  const trimmed = String(hybrid || "").trim();
  if (!fromCode || !toCode || !trimmed) return hybrid;
  const match = trimmed.match(/^([a-z]+)(\s+)(.*)$/i);
  if (!match || match[1].toUpperCase() !== fromCode) return hybrid;
  return `${toCode}${match[2]}${match[3]}`;
}

/**
 * Returns a copy of `entries` with .brand (and, when recognized, the
 * hybrid name's brand code prefix — see swapHybridBrandCode() above)
 * relabeled for display purposes when a Brand View is selected: any
 * entry belonging to one of that Brand View's *rebadge partners* (any
 * OTHER brand in REBADGE_GROUP_BRAND_IDS, matched by its
 * catalogBrandName) is shown under the currently selected brand's
 * catalogBrandName instead — e.g. with "Midwest Seed Genetics" selected
 * as the Brand View, every "NC+ Hybrids" entry displays (and groups, for
 * brand averages) as "Midwest Seed Genetics" with its hybrid's "NC "
 * prefix swapped to "MW ", and the same happens in every other direction
 * among Midwest/NC+/Crow's. Entries for any other/third-party brand
 * (one NOT in REBADGE_GROUP_BRAND_IDS) are left untouched.
 *
 * Only meant for the Plot Summary screen and its PDF export — Plot
 * Entries editing and the XLSX export intentionally keep entries' real
 * (unrelabeled) brand and hybrid text, since those are the
 * source-of-truth data.
 * @param {import('../core/models.js').PlotEntry[]} entries
 * @param {typeof BRANDS[BrandId]|null} brand - the currently selected Brand View
 * @returns {import('../core/models.js').PlotEntry[]}
 */
export function entriesForBrandView(entries, brand) {
  if (!brand || !REBADGE_GROUP_BRAND_IDS.includes(brand.id)) return entries;
  const otherGroupBrands = REBADGE_GROUP_BRAND_IDS.filter((id) => id !== brand.id).map((id) => BRANDS[id]);
  return entries.map((entry) => {
    const sourceBrand = otherGroupBrands.find((b) => entry.brand.trim() === b.catalogBrandName);
    if (!sourceBrand) return entry;
    return {
      ...entry,
      brand: brand.catalogBrandName,
      hybrid: swapHybridBrandCode(entry.hybrid, sourceBrand, brand),
    };
  });
}

// Email domains whose employees should default straight into a specific
// Brand View at sign-in, rather than being asked — see accountScreen.js.
// Keys are lowercase, no "@". Any domain not listed here falls back to
// sending the user to the manual Brand View picker (brandSelect.js).
const BRAND_ID_BY_EMAIL_DOMAIN = {
  "midwestseedgenetics.com": "midwestSeedGenetics",
  "midwestseed.com": "midwestSeedGenetics",
  "republicseed.com": "midwestSeedGenetics",
  "nc-plus.com": "ncPlus",
  // Best guess from crowsseed.com — confirm/correct with Mike if Crow's
  // staff actually sign in from a different domain.
  "crowsseed.com": "crows",
};

/**
 * @param {string|null|undefined} email
 * @returns {"midwestSeedGenetics"|"ncPlus"|"crows"|null} the Brand View
 *   this email's domain should default to, or null if the domain isn't
 *   recognized (caller should prompt the user instead).
 */
export function brandIdForEmail(email) {
  const at = String(email || "").lastIndexOf("@");
  if (at === -1) return null;
  const domain = String(email).slice(at + 1).trim().toLowerCase();
  return BRAND_ID_BY_EMAIL_DOMAIN[domain] || null;
}

/**
 * Applies a brand's palette as CSS custom properties on :root. Safe to
 * call with null to reset to the default (Midwest) palette used by the
 * BrandSelect screen before any brand is chosen.
 * @param {string|null|undefined} brandId
 */
export function applyBrandTheme(brandId) {
  const brand = getBrand(brandId) || BRANDS.midwestSeedGenetics;
  const root = document.documentElement;
  // Lets CSS target brand-specific one-offs (see .box-plot-box's NC+
  // override in styles.css) without needing a matching JS-set custom
  // property for every such case.
  root.setAttribute("data-brand", brand.id);
  root.style.setProperty("--accent", brand.accent);
  root.style.setProperty("--accent-light", brand.accentLight);
  root.style.setProperty("--accent-pale", brand.accentPale);
  root.style.setProperty("--highlight", brand.highlight);
  root.style.setProperty("--chrome", brand.chrome);
  root.style.setProperty("--danger", brand.danger);
  root.style.setProperty("--bg-light", brand.bgLight);
  root.style.setProperty("--bg-dark", brand.bgDark);
  root.style.setProperty("--card-light", brand.cardLight);
  root.style.setProperty("--card-dark", brand.cardDark);
  root.style.setProperty("--theme-color", brand.chrome);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", brand.chrome);
}
