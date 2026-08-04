// src/ui/screens/help.js
//
// The method, written out. This exists because the app's output is a
// set of confident-looking dates, and anyone using them to make a
// replant or hybrid-placement call deserves to know exactly what is and
// isn't behind them — including the parts that are genuinely weak.

import { h, mount } from "../dom.js";
import { createTopBar } from "../components/topBar.js";
import { navigate, rememberedOriginFor } from "../router.js";
import { BASELINE_YEARS } from "../../core/season.js";

function section(title, paragraphs) {
  return h("section", { className: "card help-section" }, [
    h("h3", { className: "section-header" }, title),
    ...paragraphs.map((p) => (typeof p === "string" ? h("p", { className: "help-p" }, p) : p)),
  ]);
}

export function render(container) {
  mount(
    container,
    h("div", { className: "screen" }, [
      createTopBar({
        title: "How This Works",
        onBack: () => navigate(rememberedOriginFor("help") || "calculator", { _skipOriginTracking: true }),
        backLabel: "Back",
      }),
      h("main", { className: "screen-body" }, [
        section("The GDU formula", [
          "Growing degree units use the modified base-50/86 °F method — the same one US seed companies rate hybrids on, so a published “GDUs to black layer” is directly comparable to what this app accumulates.",
          h("p", { className: "help-p gdu-formula" }, "GDU = ( min(high, 86) + max(low, 50) ) ÷ 2 − 50"),
          "Both ends are clamped to the 50–86 °F range. A day that never gets above 50 °F contributes exactly zero, not a negative — corn does not un-develop on a cold day. And a 100 °F day contributes no more than an 86 °F day: development rate plateaus, and heat past 86 °F stresses the plant instead of speeding it up. That's why a blistering July often adds fewer GDUs than people expect.",
          "Accumulation starts on the planting date itself. If you cross-check against a tool that starts the day after, expect this app to read about 15–25 GDU higher — under a day of development, but enough to notice.",
        ]),
        section("Normal, hot and cool", [
          `For the location you set, the app pulls ${BASELINE_YEARS} complete past years of daily highs and lows and accumulates each one from your planting date. At every day of the season it then takes the 50th, 90th and 10th percentile across those years.`,
          "So the “abnormally hot” line is not a replay of one specific hot year — it's the level that 90% of the last 30 years came in below, computed day by day. The same for the cool line at 10%. A year has to be genuinely unusual to fall outside that band.",
          "“Last year” is different: that one is a real, actual season, accumulated from the same calendar planting date.",
        ]),
        section("The current season and its projection", [
          "This season's line is observed data up to the last day on the books, then the 16-day forecast, then a projection.",
          "The projection is built by asking the same 30 years a narrower question: starting from the calendar date where the forecast runs out, how much more heat did each year deliver? The 50th, 90th and 10th percentiles of THAT are added onto your actual accumulated total. That's why there are three “this season” rows — they share identical real data and differ only in how the rest of the year is assumed to go.",
          "This matters more than it sounds. Summing “normal daily rates” instead would be wrong, because percentiles don't add: stacking 90th-percentile days on top of each other produces a season hotter than any 90th-percentile season on record.",
        ]),
        section("Frost", [
          "The app finds the first day at or below 28 °F after August 1 in each of the past 30 years and reports three dates: the median (half of years froze before it), the 10th percentile (1 year in 10 froze by then), and the earliest in the record. 32 °F is shown alongside as a first light frost.",
          "Corn stops accumulating GDUs at a killing freeze whether or not it has reached black layer. A projected black layer date that lands after the freeze is therefore a warning that the hybrid is too long for that location and planting date, not a prediction that it will finish.",
          "The verdict is scored against the 10th-percentile date, not the median. A hybrid that black-layers exactly on the median freeze date gets caught one year in two, which is not a pass.",
          "One measured caveat: checked against real thermometer records near Missouri Valley, Iowa for 1996–2025, this gridded dataset runs 1 to 2 weeks LATE on frost — it put the median first 32 °F at Oct 26 where nearby stations measured Oct 19 and Oct 7. GDU accumulation itself checked out within about 1% of the nearest station; it's frost specifically that runs late, because a frost date hinges on a single night's minimum rather than a season of averages. Read every frost date here as the late end of the range.",
        ]),
        section("Where the numbers come from — and what they can't tell you", [
          "Temperatures are ERA5 reanalysis and 16-day forecasts from Open-Meteo, a free public weather service. ERA5 is a gridded model product, roughly 6 to 15 miles per cell — it is not a weather station in your field. Two fields in the same township will usually return identical numbers.",
          "Frost is where that gridding hurts most. Real frost is intensely local; a low spot can run several degrees colder than the grid-cell average on a clear, calm night. Treat the frost dates as regional medians.",
          "GDU is a heat model and nothing more. It has no idea about drought, saturated soils, replant, hail, disease, or nitrogen — any of which can move real silk and black layer dates well off these projections. Use this to compare hybrids and plantings against each other and against a normal year, not as a guarantee of a date.",
          "The hybrid GDU ratings come from the built-in hybrid list (loaded exactly as supplied on the grower's own sheet, never derived from relative maturity) or from whatever you typed. If a rating on the list looks unusual for its maturity the app says so when you pick it — but it never changes the number, because a hybrid that breaks the usual RM-to-GDU pattern is a real thing and quietly 'fixing' one would be worse than showing it.",
        ]),
        section("Estimating a missing rating", [
          "Any one of the three inputs is enough to calculate: GDUs to silk, GDUs to black layer, or a relative maturity. Whatever is missing gets estimated from a least-squares fit on all 72 hybrids in the built-in list, and every estimated value is labeled “est.” on every screen it appears on.",
          "A real GDU number always beats relative maturity as the basis. Measured by holding each hybrid out of the fit and predicting it — real out-of-sample error, not the fit describing itself — black layer estimated from a known silk rating lands within 40 GDU half the time, versus 45 from RM; silk from a known black layer lands within 19, versus 24 from RM. A paired GDU rating is specific to that hybrid, while RM only places it in a maturity band that holds a 200-plus GDU spread. So the app reaches for RM only when neither GDU number is available.",
          "Relative maturity is the weakest of the three. It explains 83% of the variation in black layer across the list, and one hybrid — 42W96 TRERIB, rated 2,849 where the RM-96 trend says 2,378 — sits 471 GDU off, which is roughly three weeks of grain fill. An RM-only estimate is a sensible default when you don't have the sheet in front of you. It is not a substitute for the sheet.",
          "The fit covers 77 to 118 day hybrids, because that is the range the list spans. Enter an RM outside that and the app will still calculate, but it says on screen that it is extrapolating past its data.",
        ]),
      ]),
    ])
  );
}
