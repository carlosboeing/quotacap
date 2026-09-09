import React, { useCallback, useState } from "react";

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "quotacap-theme";

/** Stored choice wins; otherwise follow the OS preference. */
export function resolveTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}

export function storedTheme(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function systemPrefersDark(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false;
  } catch {
    return false;
  }
}

/** Apply the theme to the document and persist the choice. */
export function applyTheme(theme: Theme): Theme {
  try {
    document.documentElement.dataset.theme = theme;
  } catch {
    // Non-DOM environment (unit tests): nothing to paint.
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private mode or non-DOM: the choice simply does not persist.
  }
  return theme;
}

export function currentTheme(): Theme {
  return resolveTheme(storedTheme(), systemPrefersDark());
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const toggle = useCallback(() => {
    setTheme((prev) => applyTheme(prev === "dark" ? "light" : "dark"));
  }, []);
  return (
    <button
      data-testid="theme-toggle"
      className="iconbtn"
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      aria-pressed={theme === "dark"}
      title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
    >
      {theme === "dark" ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
