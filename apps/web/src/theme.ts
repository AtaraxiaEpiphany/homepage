import type { ITheme } from "@xterm/xterm";

// Page + terminal palettes. Light is the jyy-style default; dark is opt-in
// via the `theme` shell command (OSC 7770) or the command palette.
export type ThemeName = "light" | "dark";

export const TERMINAL_THEMES: Record<ThemeName, ITheme> = {
  light: {
    background: "#fafafa",
    foreground: "#2e3338",
    cursor: "#4a5158",
    selectionBackground: "#d0d7de",
  },
  dark: {
    background: "#16181d",
    foreground: "#d5dae1",
    cursor: "#e6e6e6",
    selectionBackground: "#3a4150",
  },
};

const STORAGE_KEY = "homepage:theme";

export function loadTheme(): ThemeName {
  try {
    return localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function saveTheme(theme: ThemeName): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* private mode etc. — the theme just won't persist */
  }
}

/** Stamp <html data-theme> so the CSS custom properties follow. */
export function applyPageTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
}

// Applied at import time so a saved dark theme is live before first paint.
applyPageTheme(loadTheme());
