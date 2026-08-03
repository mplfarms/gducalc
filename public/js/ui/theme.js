// src/ui/theme.js
//
// Applies the user's chosen theme mode ("light" | "dark" | "system") as a
// `data-theme` attribute on <html>. Mirrors brand.js's applyBrandTheme
// pattern. styles.css already has [data-theme="light"|"dark"] attribute
// selectors that win over the `prefers-color-scheme` media query (higher
// specificity), and a bare `:root:not([data-theme])` block that falls
// back to system preference — so "system" just means "no override",
// i.e. remove the attribute entirely.

/**
 * @param {"light"|"dark"|"system"|null|undefined} mode
 */
export function applyThemeMode(mode) {
  const root = document.documentElement;
  if (mode === "light" || mode === "dark") {
    root.dataset.theme = mode;
    root.style.colorScheme = mode;
  } else {
    delete root.dataset.theme;
    root.style.colorScheme = "light dark";
  }
}
