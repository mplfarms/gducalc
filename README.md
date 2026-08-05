# GDU Calculator v2.9 (Beta)

A hybrid GDU calculator for corn: set a field location, a planting date, and a
hybrid (133 built in, or type your own numbers — any one of GDUs to silk, GDUs to
black layer, or a relative maturity is enough), and get predicted stage dates for
this season plus last year, a normal year, an abnormally hot year, and an
abnormally cool year — with a frost-risk check on the end.

**The hybrid is optional.** The Hybrid card arrives collapsed when empty — its
show/hide control sits *inside* the header bar rather than beside it, so the bar
keeps the edge-to-edge bleed every other card header has (wrapping the `<h3>` in
a flex row made it a flex item, and the green stopped partway across the card).
Three e2e checks pin the bar's width, its height against the Planting Date card
above it, and the toggle's 44px tap target. A **Clear Hybrid** button empties
every box and folds it shut again — leaving the
field and the planting date untouched, because dropping the hybrid is not
starting over. A ZIP code and a planting date alone produce the
accumulation chart, the percentile band and the frost dates — the heat itself,
with no stage predictions attached. Sections that need a silk or black-layer
rating (Predicted Stage Dates, Growth Stages, Data) are omitted rather than
filled with guesses, and the PDF collapses to match.

The results screen opens with a **masthead** — brand mark, the hybrid, and the
field and planting date beneath it — then a stack of **collapsible cards**. Each
card's header bar is the toggle, with a chevron on the right; the whole 44px bar
is the target, not just the arrow.

Defaults are chosen so arriving on the screen gives you the three things you
came for and nothing else. Everything else is one tap away:

| # | Card | Default |
|---|---|---|
| 1 | **Details** — hybrid ratings and their provenance | collapsed |
| 2 | **Where This Season Stands** — GDU to date, ahead/behind normal, days in | **open** |
| 3 | **GDU Accumulation** — five scenario curves against the hybrid's silk and black-layer thresholds, with a shaded 10th-to-90th percentile band | **open** |
| 4 | **Growth Stages** — the full stage ladder stacked on a GDU axis, each band dated, with a marker for where the crop is right now | **open** |
| 5 | **Predicted Stage Dates** — silk and black layer under every scenario | collapsed |
| 6 | **Data** — every stage against every scenario | collapsed |
| 7 | **Frost Risk** — early/median freeze dates and a verdict | collapsed |
| 8 | **How These Numbers Were Made** — method and provenance | collapsed |

Growth Stages sits **above** Predicted Stage Dates: "where is my corn right now"
is the question a rep gets asked in a field, and the date table is what gets
checked afterwards.

Open/closed state lives in module scope, not localStorage. Changing the scenario
rebuilds every card, and a card someone opened to read should not slam shut
underneath them — but it is per-visit view state, not a setting, so returning to
the screen starts from these defaults again.

**Collapsed cards still print in full.** Folding is a screen convenience; a
printout that silently dropped the frost risk because that card was left shut
would be worse than no printout. A `@media print` rule forces every card body
visible and hides the chevrons, and an e2e check collapses everything before
measuring the print layout.

**The PDF keeps the older order** — Predicted Stage Dates *before* Growth Stages
— and that divergence is deliberate. On screen the cards collapse and you
scroll, so order decides what you see first. On paper everything is visible at
once, so order buys almost nothing, and putting the 416 pt stage block first
leaves a third of sheet one empty and spills onto a third sheet. Measured: to
fit two sheets in the screen's order the stage chart has to come down from
380 pt to 240 pt, which at fifteen bands drops several below the 9 pt floor
where their label stops being drawn at all. Losing stage names on a grower's
printout to buy a section swap nobody can perceive is a bad trade.

A share button sits left of the Settings gear on the results screen. **One tap,
one outcome**: it builds a two-page branded report (`core/pdfBuilder.js`) and
hands it to the OS share sheet as a file where that exists, falling back to a
download. No intermediate menu — a menu whose first item is what everyone wants
is a tax on getting there.

The plain-text summary still gets built; it rides along as the share sheet's
`text`, so a message app gets the headline numbers in the body with the PDF
attached rather than a bare attachment. (An earlier version also offered Print
and Copy Summary from a menu. The print stylesheet is still in `gdu.css` and
still correct — restoring those needs a menu again, not new plumbing.)
Both charts are drawn as **vector**, not screenshotted. The shortcut — serialise
the on-screen SVG and rasterise it — was rejected twice over: the SVGs take every
color from CSS custom properties and the watermark from an external `<image href>`,
so a serialised copy renders unstyled and logo-less unless you walk the tree
inlining computed styles anyway; and a raster chart doesn't survive being printed.

Layout matches Corn Plot Harvest's PDF — US Letter at 612×792 pt, 36 pt margin,
Helvetica — with section headers in white on a filled brand-accent bar, the same
treatment as the app's own cards.

**Two pages is a hard target**, not an aspiration — one sheet double-sided is
what gets handed to a grower. Every block is sized against a budget of 694 pt of
usable height per page (792 less two 36 pt margins and the 26 pt footer), and the
two charts are the flexible part: they shrink before any caveat gets cut, and
grow to fill the sheet when there's room. Two tests fail if it runs to three —
one on a fully-specified hybrid, one on an RM-estimated one, which carries an
extra callout and an extra method bullet and is the variant most likely to spill.

Two more things worth knowing if you edit it:

* **jsPDF is loaded on demand**, not on page load — a 356 KB library has no
  business being fetched by someone checking a silk date in a pickup. The pinned
  CDN URL is the single cross-origin exception in `sw.js`'s otherwise
  network-only rule, so the second export works with no signal.
* **jsPDF's Helvetica is WinAnsi-encoded** and characters outside that set print
  as something else without erroring. U+2212 MINUS came out as a double quote, so
  "−203 GDU" read as `"203 GDU`. `pdfSafe()` maps the handful of offenders to
  ASCII, and `doc.text` is wrapped once so no call site can miss it.

The shared text deliberately carries **no link to the specific result**. Inputs
live in the device's own local storage, so a URL would open the recipient's app
showing *their* last calculation — worse than no link, because it looks like it
worked. The text carries the numbers; the PDF carries the charts.

The GDU accumulation chart carries the active Brand View's logo as a faint
watermark, bottom-right inside the plot. That corner is the one reliably empty
region of that chart — every curve rises left to right — and the mark is
`pointer-events: none` and `aria-hidden` so it never eats a crosshair drag or
gets announced. Box sizing is driven by height with a 2.5:1 minimum width, so
Midwest's 2.38:1 wordmark, NC+'s square diamond and Crow's 1.29:1 mark all render
at the same visual size instead of one being a third the size of another.

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

* `test/unit_gdu.mjs` — 89 checks on the GDU math, the shipped hybrid catalog, the
  stage ladder and the rating estimator, all hand-worked from the formulas rather
  than snapshotted from a previous run.
* `test/e2e_smoke.mjs` — 115 checks driving the real UI in headless Chromium with
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
your actual accumulated total, producing a normal, a hot and a cool finish.

Those three share every observed and forecast day, so they can only diverge
after the last known day. The results table therefore shows **one** "this
season" row per stage carrying (a) the date, (b) whether it is `reached`
(observed — it already happened), `in forecast` (inside the 16-day outlook) or
`projected`, and (c) a hot-to-cool range, but only where one genuinely exists.
They used to be three separate rows, which printed the same date three times
whenever a stage fell inside the known window and read as a fault in the app
rather than as the arithmetic truth that history does not have scenarios.

It is deliberately **not** built by summing "normal daily rates": percentiles
don't add, and stacking 90th-percentile days would produce a season hotter than
any 90th-percentile season on record.

### Why there is exactly one weather source

Open-Meteo is the only service the app calls, and that is a decision rather than
an oversight. NDAWN, the South Dakota and Nebraska mesonets, Wisconet, UW
AgWeather and the NOAA station networks were all evaluated as additions. The
findings:

* **NDAWN, SD Mesonet, Nebraska Mesonet and UW AgWeather send no CORS header**,
  so a static site cannot call them at all without standing up a proxy — which
  is a server to run, monitor and pay for.
* **SD Mesonet and Nebraska Mesonet explicitly prohibit** automated collection,
  redistribution and commercial use in their terms. That is disqualifying on its
  own, regardless of the technical path.
* **Weather Underground** is largely uncalibrated personal weather stations with
  no siting standard, and its API is behind a paid tier. Wrong input for a
  number growers make decisions on.
* **Iowa Environmental Mesonet and RCC-ACIS are genuinely usable** — CORS-open,
  no key, deep history, and IEM permits commercial use in writing. They are the
  right answer *if* a second source is ever added. IEM asks not to be called
  from high-traffic sites, so it would need aggressive caching.

Every added source is another way for the app to fail in front of a customer,
and GDU accumulation — the thing this app exists to compute — already validates
to within about 1% of the nearest thermometer (see Accuracy below). The
measured weakness is frost, and it is disclosed on screen rather than papered
over.

**Frost.** For each of the 30 years the app finds the first day at or below 28 °F
(and 32 °F) after Aug 1. It reports the median, the 10th percentile ("1 year in
10 froze by this date"), and the earliest on record. The verdict is scored against
the **10th percentile**, not the median — a hybrid that black-layers exactly on
the median freeze date gets caught one year in two, which is not a pass.

## The stage ramp

The stage bands run **two ramps split at R1**: green climbing through the
vegetative stages, then harvest gold restarting pale at silking and deepening
to black layer.

The reset is the point. It puts a visible line at the moment the plant stops
building leaves and starts filling grain — the single most important transition
on the chart, which previously had nothing marking it but a date.

**This is no longer per Brand View.** It used to be green for Midwest and gold
for NC+ and Crow's, on the grounds that green read as a third unrelated brand
colour against those two. Both hues now appear everywhere, because the split
encodes the crop's biology and that does not change depending on whose label is
on the bag.

One consequence: dark mode needs a neutral compositing base for **every** brand
now, not just the cool-carded ones. Gold alpha-blended over Midwest's dark green
card desaturates exactly the way it did over NC+'s blue. Measured at the top of
each ramp against `#1e1d1b`, gold lands at 0.59 saturation and green at 0.43 —
both unmistakably themselves. A warm brown base (the old NC+/Crow's fix) would
have rescued the gold and muddied the green.

## Heat-cap and cold-floor days

The accumulation chart marks the days that ran into one of the formula's two
limits, drawn on this season's line:

* **Red** — the day's high reached the **86 °F cap**. Every degree past it added
  nothing to development, so the curve is flatter than the thermometer suggests
  and the plant spent that heat on stress instead. This is the visual answer to
  "it was blistering all week, why didn't we gain more GDUs".
* **Blue** — the low fell to **50 °F or below**, so that half of the day counted
  zero. The day still earns whatever its daytime half was worth.

Drawn as **thin full-height vertical rules**, 1 px and 40% opacity, underneath
the percentile band and every curve. Two notes on that:

* Translucency is doing real work. A hot July puts 40-50 rules on the plot, and
  at full strength they read as a fence in front of the data rather than
  shading behind it.
* Two earlier renderings were tried and rejected — recolouring the season line
  (a red "This season" reads as the orange "Abnormally Hot" curve, the exact
  failure the fixed palette exists to prevent) and a halo behind it (same
  problem, softened). Vertical rules were chosen deliberately over both.

**Not a strict "maxed out."** The literal reading of red is a full 36 GDU,
which needs the *low* at 86 °F too — that essentially never happens in Iowa and
the marker would never appear at all. The trigger is the high hitting the cap,
which fires 40-60 days in a western-Iowa season.

Observed days only — marking a forecast day red asserts a measurement nobody has
taken. The legend lists a marker only when it is actually on the chart, with its
day count and a vertical-tick swatch that matches the mark. The PDF carries the
same rules and a written key.

## Stage-band temperatures

Each growth-stage band carries the **hottest daytime high and the warmest
nighttime low** anywhere in that stage — `99°/75°` — with the day count beside
it in the Data table.

Three deliberate choices:

* **Peaks, not averages.** These are the two numbers that explain a yield
  result. Peak daytime heat is what sterilizes pollen at silking; the warmest
  nights are what drive respiration to burn sugars off during grain fill, which
  costs test weight even when the days look ordinary. An average buries both —
  one 98 °F day in an otherwise mild fortnight barely moves a mean, and that is
  the day that did the damage. `bandTempStats()` computes the means too and
  they're available, they're just not what gets shown.
* **The warmest night is the max of the lows**, not the low that happened to
  come with the hottest day. Those are different nights more often than not,
  and a unit test pins the distinction.
* **Observed days only, never partial.** `bandTempStats()` returns null unless
  *every* day in the span is observed — one forecast day in the window and the
  whole band goes blank. A stage the crop is still living through does not yet
  have a hottest day, and reporting the hottest-day-so-far under a label
  claiming to describe the whole stage would be a number that silently changes
  tomorrow. Raw temperatures, not the 50/86 clamped ones: this reports the
  weather, not development.

The stage chart also keeps the **"N GDU through <date>" progress rule clear of
band labels**. That rule cuts through whichever band the crop is currently in,
and the band's centered label used to be drawn straight on top of it — an
unreadable smear on the one band a rep is actually looking at. The label now
goes in whichever half of the split band has more room, or is dropped if
neither half clears the rule. An e2e check measures the two bounding boxes for
intersection, and asserts the rule really does land inside a band so the check
can't pass vacuously.

## Brand Views and hybrid naming

Midwest Seed Genetics, NC+ and Crow's are the same genetics under three
regional labels. Two consequences, both visible in the app:

* **Only the active Brand View's house brand is offered** in the Brand
  dropdown, alongside "Other / competitor". Listing all three inside one view
  let a rep build a report headed "Crow's" while sitting in the NC+ view.
  Switching views *migrates* a stored house brand rather than leaving a value
  the dropdown no longer offers; "Other" is left alone, since a competitor
  hybrid doesn't become ours because the view changed.
* **Hybrids are named with the view's own 2-letter code** — `NC 09-90 PCE`
  under NC+, `MW 09-90 PCE` under Midwest — everywhere: the input box, the
  picker, the results header, the PDF and its filename. `brandedHybridName()`
  *replaces* any existing code rather than stacking it, so three view swaps
  can never produce `CR NC MW 09-90 PCE`. The shipped list stays brand-neutral
  (`09-90 PCE`) because it is one set of genetics; `bareVariety()` strips the
  code on the way back so catalog matching and search still work. Competitor
  names (`DKC62-08`, `P1185Q`) are never touched.

## The hybrid list

133 hybrids ship in `public/data/hybrids.json`, built from the grower-supplied
GDU worksheet (`data-src-gdu-worksheet.xlsx`, also flattened to
`data-src-hybrids.csv`) and **reproduced exactly as supplied**. Nothing derives,
smooths or sanity-corrects a GDU rating from relative maturity.

This list replaced an earlier 72-hybrid one wholesale — no merge, no leftovers.
Two later cleanups took it to 132: the two bare-`TRE` entries were dropped (each
was an exact duplicate of its `TRERIB` counterpart — same RM, same silk, same
black layer — so they added nothing to pick between while double-weighting two
hybrids in the fit), and `13-22 Conv` was normalised to `CONV` so every trait
suffix is upper case. A unit test now asserts both rules, plus the sort order.
`14-36 PCE` (114 day, 1,350 silk / 2,850 black layer) was then added, taking the
list to 133.

**The estimator is refit on every one of these changes**, because it is fitted
*on* this data: silk-from-RM's slope moved from 7.55 to 8.18 across the big
refresh, about 26 GDU at the long end of the range. Shipping old coefficients
against a new list would be quietly wrong. `FITTED_N` in
`core/hybridEstimate.js` is the single source for the "fitted on N hybrids"
claim printed on four screens and in the PDF — it was quoted as a literal in
five places and three of them were still saying 72 two refreshes later. A unit
test pins `FITTED_N` to the catalog's real length.

The picker searches by variety or maturity and is sorted shortest maturity
first, with RM on each row's meta line rather than in section headings — most
variety numbers already encode maturity (09-90 is a 109 day), so headings mostly
repeated the row beneath them. RM stays on the row anyway, since the list gets
refreshed and a future one may carry names that don't encode it. Picking a hybrid
fills both GDU boxes and tags them "From hybrid list"; editing either value
re-tags them "Edited", shows what the list said, and offers a one-tap reset — an
edited number never keeps wearing the list's authority.

One rating is still unusual for its maturity, and it survived the refresh:
**89-58 SSPRORIB** (RM 89) is rated 1,329 silk / 2,592 black layer, 352 GDU above
the median of its RM neighbours and in line with a 103–105 day hybrid. Per
explicit instruction it is loaded as-is; the app flags it on selection so whoever
picks it looks twice. The check is generic (`rmOutlierNote` in
`core/hybridCatalog.js`) and fires for anything more than 250 GDU off the median
of hybrids within ±2 RM days — re-run against the new list, it is the only hit.

Variety names display verbatim, with no Brand View prefix applied.

## Location is ZIP only

Device GPS was built and then removed, per explicit request, and the reasoning
holds up: a seed rep is usually **not** standing in the field being calculated —
they're at the shop or driving to the next customer, so "here" is the wrong answer
more often than the right one. And the weather behind all of this is a 6-to-15
mile grid, on which a GPS fix and the ZIP centroid for the same township return
byte-identical numbers. It cost a permission prompt and an HTTPS-only code path
to be no more accurate than typing five digits.

## The stage ramp's color

The Growth Stages bands are a **sequential** ramp — one hue stepped light to dark
by season progress, not a categorical palette. Fifteen hues would imply fifteen
unrelated categories.

The hue is per Brand View: **green for Midwest**, whose own identity is green, and
**harvest gold for NC+ and Crow's**, where green reads as a third unrelated brand
color. Two measured decisions sit behind that:

**Light mode uses `#DA9100`, not the brands' own highlight yellows.** A ramp has
to run light to dark, and a bright yellow has nowhere to go before it hits white.
Across the same alpha schedule, NC+'s `#FFDC32` spans a relative luminance range
of 0.13 against green's 0.43 — the progression all but vanishes. `#DA9100` spans
0.32 and still reads unmistakably as harvest gold, with band-label contrast at
8.6:1 or better on every step.

**Dark mode needs a warm backdrop, because gold over blue isn't gold.** The ramp
alpha-composites over whatever is behind it, and a warm hue over NC+'s cool blue
card desaturates to khaki — measured at 0.24 saturation at the top of the ramp
versus 0.62 over a warm base, and khaki is exactly what it looked like. A
`#241f14` backdrop rect sized to the band stack gives the ramp its own base to
composite against, restoring the hue and lifting worst-case label contrast from
3.9:1 to 4.6:1. Light mode and Midwest need none of it.

`--gdu-stage-base` names that effective background, and the backdrop, the rules
between bands and the halos behind labels all read from it. Before it existed the
dividers stayed card-blue and striped the gold chart with blue lines.

One related fix: the "GDU through <date>" marker label is now ink rather than
danger-red. Red sits at ~4:1 on white and ~3.4:1 on the dark warm backdrop, under
the floor for 11px bold in both. The dashed rule it annotates stays red — that's
the alert; the number just has to be legible.

## Partial inputs and the rating estimator

Any **one** of GDUs to silk, GDUs to black layer, or relative maturity is enough
to calculate. Whatever is missing is filled in by ordinary least squares fitted on
all 133 hybrids in the built-in list, exactly as supplied — nothing trimmed to
flatter the fit, 89-58 included.

Errors below are **leave-one-out**: each hybrid was predicted by a model fitted on
the other 132 and never on itself. In-sample error reads about 10% lower and would
be measuring the fit's memory rather than its accuracy.

| Estimate | median err | p90 | worst | R² |
|---|---|---|---|---|
| silk from black layer | 25 GDU | 58 | 116 | 0.852 |
| black layer from silk | 46 GDU | 169 | 264 | 0.852 |
| silk from RM | 29 GDU | 58 | 187 | 0.811 |
| black layer from RM | 47 GDU | 146 | 389 | 0.869 |

**A real GDU number is preferred over RM**, though the refit on the bigger list
narrowed the case for it and that's worth saying plainly. Silk from a known black
layer (25 GDU) still clearly beats silk from RM (29). For black layer the two are
close — 46 from a known silk against 47 from RM — where on the old 72-hybrid
list silk was the clear winner. The preference stands on the grounds that a
paired GDU rating is specific to *that* hybrid while RM only locates it in a
maturity band holding a 200-plus GDU spread, not on a meaningful accuracy gap.
`resolve()` in `core/hybridEstimate.js` enforces the precedence and a unit test
pins it.

**RM is the weakest input.** R² is 0.869 for black layer and the worst hybrid in
the list — 89-58 SSPRORIB, rated 2,592 where the RM-89 trend says 2,210 — is 382
GDU off, roughly two and a half weeks of grain fill. It's a reasonable default
when the tech sheet isn't at hand; it is not a substitute for it.

A quadratic in RM was tested and rejected on the original list: it moved
black-layer RMSE from 88.4 to 87.7 GDU, which is noise, and it bends badly
outside the fitted range. The fit covers RM 77–118 (the list's own span, unchanged
by the refresh); outside that the app still calculates but says on screen that it
is extrapolating.

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
