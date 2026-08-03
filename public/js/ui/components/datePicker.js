// src/ui/components/datePicker.js
//
// A tap-to-open calendar date picker, used in place of both the native
// <input type="date"> (which renders as a large, inconsistent pill on
// iOS Safari — see trialDetails.js's dateMaskInput, which replaced it
// with a masked text field) and that masked-text-entry approach itself,
// now that the ask is a real calendar selection tool rather than typing
// digits. Built on the shared showCustomModal() dialog so it looks and
// behaves identically on every platform, same rationale as the date-mask
// fix it replaces.

import { h, clear } from "../dom.js";
import { showCustomModal } from "./modal.js";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isoFromParts(year, month, day) {
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

/** @param {string|null|undefined} iso "YYYY-MM-DD" @returns {{year:number,month:number,day:number}|null} */
function partsFromIso(iso) {
  if (!iso) return null;
  const s = String(iso);
  if (s.length < 10) return null;
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(5, 7));
  const day = Number(s.slice(8, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return { year, month, day };
}

function todayParts() {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

/** @param {string|null|undefined} iso @returns {string} "" if unset */
function formatDisplay(iso) {
  const p = partsFromIso(iso);
  if (!p) return "";
  return `${pad2(p.month)}/${pad2(p.day)}/${p.year}`;
}

/** @param {number} year @param {number} month 1-12 @returns {number} */
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/** @param {number} year @param {number} month 1-12 @returns {number} 0=Sun..6=Sat */
function firstWeekdayOfMonth(year, month) {
  return new Date(year, month - 1, 1).getDay();
}

/**
 * @param {{value: string|null, onChange: (iso: string|null) => void, placeholder?: string}} opts
 * @returns {{el: HTMLElement, setValue: (v: string|null) => void}}
 */
export function createDatePicker({ value, onChange, placeholder = "Select a date" }) {
  let currentValue = value || null;

  const btn = h("button", {
    type: "button",
    className: "text-input date-picker-btn",
    onclick: openPicker,
  });

  function refreshButtonLabel() {
    const display = formatDisplay(currentValue);
    btn.textContent = display || placeholder;
    btn.classList.toggle("date-picker-btn-placeholder", !display);
  }
  refreshButtonLabel();

  function openPicker() {
    const initial = partsFromIso(currentValue) || todayParts();
    let viewYear = initial.year;
    let viewMonth = initial.month;

    const monthLabel = h("span", { className: "date-picker-month-label" }, "");
    const gridEl = h("div", { className: "date-picker-grid" });

    function selectDay(year, month, day) {
      currentValue = isoFromParts(year, month, day);
      refreshButtonLabel();
      onChange(currentValue);
      modalHandle.close();
    }

    function renderGrid() {
      monthLabel.textContent = `${MONTH_NAMES[viewMonth - 1]} ${viewYear}`;
      clear(gridEl);

      for (const wd of WEEKDAY_LABELS) {
        gridEl.appendChild(h("div", { className: "date-picker-weekday" }, wd));
      }

      const leadingBlanks = firstWeekdayOfMonth(viewYear, viewMonth);
      for (let i = 0; i < leadingBlanks; i++) {
        gridEl.appendChild(h("div", { className: "date-picker-day date-picker-day-empty", "aria-hidden": "true" }));
      }

      const today = todayParts();
      const selected = partsFromIso(currentValue);
      const numDays = daysInMonth(viewYear, viewMonth);
      for (let day = 1; day <= numDays; day++) {
        const isToday = today.year === viewYear && today.month === viewMonth && today.day === day;
        const isSelected = Boolean(selected) && selected.year === viewYear && selected.month === viewMonth && selected.day === day;
        gridEl.appendChild(
          h(
            "button",
            {
              type: "button",
              className:
                "date-picker-day" +
                (isToday ? " date-picker-day-today" : "") +
                (isSelected ? " date-picker-day-selected" : ""),
              "aria-pressed": isSelected ? "true" : "false",
              onclick: () => selectDay(viewYear, viewMonth, day),
            },
            String(day)
          )
        );
      }
    }

    const prevBtn = h(
      "button",
      {
        type: "button",
        className: "date-picker-nav-btn",
        "aria-label": "Previous month",
        onclick: () => {
          viewMonth -= 1;
          if (viewMonth < 1) {
            viewMonth = 12;
            viewYear -= 1;
          }
          renderGrid();
        },
      },
      "‹"
    );
    const nextBtn = h(
      "button",
      {
        type: "button",
        className: "date-picker-nav-btn",
        "aria-label": "Next month",
        onclick: () => {
          viewMonth += 1;
          if (viewMonth > 12) {
            viewMonth = 1;
            viewYear += 1;
          }
          renderGrid();
        },
      },
      "›"
    );

    const navRow = h("div", { className: "date-picker-nav-row" }, [prevBtn, monthLabel, nextBtn]);

    const todayBtn = h(
      "button",
      {
        type: "button",
        className: "date-picker-footer-btn",
        onclick: () => {
          const t = todayParts();
          selectDay(t.year, t.month, t.day);
        },
      },
      "Today"
    );
    const clearBtn = h(
      "button",
      {
        type: "button",
        className: "date-picker-footer-btn date-picker-clear-btn",
        onclick: () => {
          currentValue = null;
          refreshButtonLabel();
          onChange(null);
          modalHandle.close();
        },
      },
      "Clear"
    );
    const footerRow = h("div", { className: "date-picker-footer-row" }, [todayBtn, currentValue ? clearBtn : null]);

    renderGrid();

    const body = h("div", { className: "date-picker-modal-body" }, [navRow, gridEl, footerRow]);
    const modalHandle = showCustomModal({ title: "Select Date", bodyNode: body });
  }

  return {
    el: btn,
    /** @param {string|null} v */
    setValue(v) {
      currentValue = v || null;
      refreshButtonLabel();
    },
  };
}
