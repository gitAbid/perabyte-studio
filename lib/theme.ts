/**
 * Dark-mode plumbing. The preference is a single boolean persisted in
 * localStorage; unset falls back to the OS preference. `themeInitScript`
 * runs inline before first paint so the correct theme is on screen from
 * the first frame (no flash), and the React toggle just flips the class.
 */
export type ThemePreference = "light" | "dark";

export const THEME_STORAGE_KEY = "perabyte.theme";

export function resolveInitialTheme(
  stored: string | null | undefined,
  prefersDark: boolean,
): ThemePreference {
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}

export function themeInitScript(storageKey = THEME_STORAGE_KEY): string {
  return `(function(){function pick(stored,prefersDark){if(stored==="light"||stored==="dark")return stored;return prefersDark?"dark":"light"}try{var stored=null;try{stored=window.localStorage.getItem(${JSON.stringify(storageKey)})}catch(e){}var prefersDark=!!(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(pick(stored,prefersDark)==="dark")document.documentElement.classList.add("dark")}catch(e){}})();`;
}
