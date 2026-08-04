# GDU Calculator v1.4 (Beta)

A hybrid GDU calculator for corn: set a field location, a planting date, and a
hybrid (72 built in, or type your own numbers — any one of GDUs to silk, GDUs to
black layer, or a relative maturity is enough), and get predicted stage dates for
this season plus last year, a normal year, an abnormally hot year, and an
abnormally cool year — with a frost-risk check on the end.

The results screen is one scrollable report — nothing behind a tab, so a single
screenshot carries the whole answer:

1. **Where this season stands** — GDU to date, ahead/behind normal, days in
2. **GDU Accumulation** — five scenario curves against the hybrid's silk and
   black-layer thresholds, with a shaded 10th-to-90th percentile band
3. **Predicted Stage Dates** — silk and black layer under every scenario
4. **Growth Stages** — the full stage ladder stacked on a GDU axis, each band
   dated, with a marker for where the crop is right now
5. **Data** — every stage against every scenario
6. **Frost Risk** — early/median freeze dates and a verdict
7. **How these numbers were made** — method and provenance

The accumulation chart and the stage chart answer different questions from the
same numbers ("how does this year compare to normal" vs. "where is my corn and
what's next"), so both are always on the page rather than trading one for the
other. The scenario selector on the Growth Stages card re-dates the stage chart
and the data table together; it never touches the accumulation chart above them.

Built on the Corn Plot Harvest design system. `public/css/styles.css`,
`public/js/ui/dom.js`, `theme.js`, `brand.js`, `components/toast.js`,
`components/modal.js` and `components/datePicker.js` are **copied verbatim** from
corn-plot-harvest v26.152, and `public/css/gdu.css` only adds new `.gdu-*` rules.
Nothing shared is modified, so those files can be re-synced from that app later
without a merge.

## Running it

It's a static site. Serve `public/` from any web root:

```
npx serve public          # or netlify deploy --dir=public
```

It will **not** work opened as a `file://` URL — it uses ES modules, which
browsers refuse to load cross-origin from the filesystem.

## Tests

```
npm install               # playwright, for the browser test only
npm test                  # unit + end-to-end
npm run shots             # e2e plus screenshots into test/shots/
```

* `test/unit_gdu.mjs` — 62 checks on the GDU math, the shipped hybrid catalog, the
  stage ladder and the rating estimator, all hand-worked from the formulas rather
  than snapshotted from a previous run.
* `test/e2e_smoke.mjs` — 46 checks driving the real UI in headless Chromium with
  every weather/geocode call intercepted and served deterministic synthetic data.

## How it works

**The formula.** Modified base-50/86 °F growing degree days — the method US seed
companies rate hybrids on, so a published "GDUs to black layer" is directly
comparable:

```
GDU = ( min(daily high, 86) + max(daily low, 50) ) / 2 − 50
```

Both ends clamp to 50–86 °F. A day that never reaches 50 °F scores 0, never a
negative. A 100 °F day scores no more than an 86 °F day. Accumulation starts
**on** the planting date (matching Iowa State / IEM convention); a tool that
starts the day after will read ~15–25 GDU lower.

**Normal / hot / cool.** 30 complete past years are pulled for the exact
coordinate and each is accumulated from your planting date. At every day of the
season the app takes the 50th, 90th and 10th percentile across those years. These
are pointwise envelopes, not replays of any single year. "Last year" is separate
and is a real, actual season.

**This season's projection.** Observed data to the last day on the books, then the
16-day forecast, then a projection. The projection asks the same 30 years a
narrower question — from the calendar date the forecast runs out, how much more
heat did each year deliver? — and adds the 50th/90th/10th percentile of *that* to
your actual accumulated total. This is why there are three "this season" rows.

It is deliberately **not** built by summing "normal daily rates": percentiles
don't add, and stacking 90th-percentile days would produce a season hotter than
any 90th-percentile season on record.

**Frost.** For each of the 30 years the app finds the first day at or below 28 °F
(and 32 °F) after Aug 1. It reports the median, the 10th percentile ("1 year in
10 froze by this date"), and the earliest on record. The verdict is scored against
the **10th percentile**, not the median — a hybrid that black-layers exactly on
the median freeze date gets caught one year in two, which is not a pass.

## The hybrid list

72 hybrids ship in `public/data/hybrids.json`, built from the grower-supplied
sheet and **reproduced exactly as supplied**. Nothing derives, smooths or
sanity-corrects a GDU rating from relative maturity.

The picker searches by variety or maturity and groups by RM. Picking a hybrid
fills both GDU boxes and tags them "From hybrid list"; editing either value
re-tags them "Edited", shows what the list said, and offers a one-tap reset — an
edited number never keeps wearing the list's authority.

One rating in the sheet is unusual for its maturity: **89-58 SSPRORIB** (RM 89)
is rated 1,329 silk / 2,592 black layer, roughly 350 GDU above its RM neighbours
and in line with a 103–105 day hybrid. Per explicit instruction it is loaded
as-is; the app flags it on selection so whoever picks it looks twice. The check
is generic (`rmOutlierNote` in `core/hybridCatalog.js`) and fires for anything
more than 250 GDU off the median of hybrids within ±2 RM days.

Variety names display verbatim, with no Brand View prefix applied.

## Partial inputs and the rating estimator

Any **one** of GDUs to silk, GDUs to black layer, or relative maturity is enough
to calculate. Whatever is missing is filled in by ordinary least squares fitted on
all 72 hybrids in the built-in list, exactly as supplied — nothing trimmed to
flatter the fit, 89-58 included.

Errors below are **leave-one-out**: each hybrid was predicted by a model fitted on
the other 71 and never on itself. In-sample error reads about 10% lower and would
be measuring the fit's memory rather than its accuracy.

| Estimate | median err | p90 | worst |
|---|---|---|---|
| silk from black layer | 19 GDU | 53 | 102 |
| black layer from silk | 40 GDU | 140 | 276 |
| silk from RM | 24 GDU | 67 | 248 |
| black layer from RM | 45 GDU | 150 | 472 |

**A real GDU number always outranks RM as the basis**, and the table is why: a
paired GDU rating is specific to that hybrid, while RM only locates it in a
maturity band holding a 200-plus GDU spread. So a missing black layer is derived
from a known silk before the app will fall back to maturity. `resolve()` in
`core/hybridEstimate.js` enforces the precedence and a unit test pins it.

**RM is the weakest input.** R² is 0.83 for black layer and the worst hybrid in
the list — 42W96 TRERIB, rated 2,849 where the RM-96 trend says 2,378 — is 471 GDU
off, roughly three weeks of grain fill. It's a reasonable default when the tech
sheet isn't at hand; it is not a substitute for it.

A quadratic in RM was tested and rejected: it moved black-layer RMSE from 88.4 to
87.7 GDU, which is noise, and it bends badly outside the fitted range. The fit
covers RM 77–118 (the list's own span); outside that the app still calculates but
says on screen that it is extrapolating.

Estimated values are **never written into the input boxes** — a guess sitting in a
field looks identical to something read off a tech sheet, and that difference is
the whole point. They appear in a "Will calculate with" panel below the inputs,
carry an amber `est.` tag with their provenance, and are re-labeled on the results
header and in the method card. Out-of-range entries (silk outside 400–2,200, black
layer outside 900–4,000, RM outside 60–135) are rejected as typos rather than
quietly estimated from.

## The growth-stage ladder

The Stages and Data views use Iowa State's PMR 1009 ladder for a 2,700-GDU
reference hybrid (also reproduced in University of Kentucky AGR-202). Six values
are quoted directly from that published table — V2 200, V6 475, V12 870, VT 1135,
R1 1400, R6 2700. The rest (VE, V4, V8, V10, V14 and the R2/R3/R4 kernel stages)
are interpolated onto the cadence those points establish, are marked
`interpolated: true` in `core/stages.js`, and are labeled "est." in the app.

The ladder is then **rescaled onto each hybrid's own two numbers**: vegetative
stages scale by (hybrid silk ÷ 1400), reproductive stages are placed
proportionally across the span from silking to black layer. Planting, Silks and
Maturity therefore land exactly on 0, the hybrid's GDU-to-silk and its
GDU-to-black-layer — those three are shown in bold and flagged as anchored.
Everything between them is a proportional estimate.

Being plain about it: real hybrids don't stretch perfectly proportionally, and a
long-season hybrid puts relatively more of its extra heat into grain fill than
into leaves. But a fixed ladder would put "Silks" at 1,400 GDU for a 77-day
hybrid the sheet says silks at 970 — contradicting the better information. Anchor
on what's known, estimate between, and say which is which.

## Data sources

| What | Source | Notes |
|---|---|---|
| History + current season | Open-Meteo `archive-api` (ERA5 reanalysis) | 1940→today, ~9–25 km grid, free, no key |
| 16-day outlook | Open-Meteo `forecast` | free, no key |
| ZIP → lat/lon | Zippopotam.us | free, no key |
| GPS → "City, ST" label | BigDataCloud reverse-geocode-client | cosmetic only; failure leaves the coordinate intact |

One 30-year pull is ~250 KB and ~2.5 s, cached per location in `localStorage`
until the end of the calendar day it was fetched. The service worker caches the
app shell but **never** a weather response — see the note at the top of `sw.js`.

## Accuracy — measured, not assumed

Checked against real thermometer records for 1996–2025 near Missouri Valley, Iowa
(41.5644, −95.8913), via the Iowa Environmental Mesonet:

| Source | Median GDU, May 1 → Aug 3 | Median GDU, May 1 → Sep 30 | Median first 32 °F | Median first 28 °F |
|---|---|---|---|---|
| **This app (ERA5 at the point)** | **1,938** | **3,142** | **Oct 26** | **Nov 5** |
| Council Bluffs, IA (ASOS, 25 mi S) | 1,944 | 3,181 | Oct 19 | Nov 5 |
| Omaha Eppley, NE (ASOS, 30 mi SW) | 2,031 | 3,283 | Oct 19 | Oct 31 |
| Atlantic, IA (ASOS, 45 mi SE) | 1,872 | 3,014 | Oct 7 | Oct 21 |
| Sioux City, IA (ASOS, 70 mi N) | 1,833 | 2,932 | Oct 7 | Oct 15 |

**GDU accumulation is accurate** — within about 1% of the nearest station, and
correctly positioned between the stations north and south of it.

**Frost dates run late** — roughly 1 to 2 weeks late against the rural stations.
A 9–25 km grid cell averages away the radiative cooling that makes a low spot in a
field frost first, so the model's nighttime minima are too warm. This bias is
specific to frost because a frost date hinges on one night's minimum rather than a
season of averages. The app says so on the frost card, reports a 10th-percentile
early-freeze date alongside the median, and scores its verdict against that
earlier date. Treat every frost date as the **late** end of the range.

If a later version needs field-accurate frost, the fix is to read the nearest COOP
or ASOS station directly (IEM's API covers the whole US) rather than the grid.

## What it deliberately does not do

* **No derived GDU ratings.** The built-in list is reproduced verbatim; nothing
  is inferred from relative maturity. Anything not on the list is typed by hand
  and the app remembers it.
* **No crop modeling.** GDU is a heat model. It knows nothing about drought,
  saturated soils, replant, hail, disease or nitrogen — any of which can move real
  silk and black layer dates well off these projections. Use it to compare hybrids
  and plantings against each other and against a normal year.
* **No sign-in.** Everything is derived from public weather data and numbers you
  type; there is nothing to protect.

## Brand View

Midwest Seed Genetics / NC+ / Crow's, same palettes and logos as Corn Plot
Harvest, stored under `gdu.*` localStorage keys so the two apps don't collide on a
shared origin. Brand View sets colors, logo and the default Brand field on a new
hybrid — **it does not change any calculation.**

The chart's series palette is intentionally fixed across all three brands. Two of
the three are red-accented, and a red "this season" line beside a red "abnormally
hot" line would destroy the one distinction the chart exists to make. Both the
light and dark steps were run through a colorblind/contrast validator against every
surface they can land on.

## File layout

```
public/
  index.html  manifest.webmanifest  sw.js
  css/    styles.css (from Corn Plot Harvest, verbatim)  gdu.css (new)
  js/
    core/   dates.js  gdu.js  season.js  weather.js  location.js   <- pure, testable
    ui/     router.js  chart.js  brand.js  dom.js  theme.js
            components/  screens/  stores/
test/
  unit_gdu.mjs  e2e_smoke.mjs  shots/
```

`js/core/` has no DOM and no `fetch` except in `weather.js`/`location.js`, which
is what makes the whole engine unit-testable.
