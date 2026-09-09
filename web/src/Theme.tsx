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
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      aria-pressed={theme === "dark"}
    >
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}
