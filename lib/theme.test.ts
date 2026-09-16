import { describe, expect, it } from "vitest";
import {
  THEME_STORAGE_KEY,
  resolveInitialTheme,
  themeInitScript,
} from "./theme";

describe("resolveInitialTheme", () => {
  it("prefers an explicit stored choice", () => {
    expect(resolveInitialTheme("light", true)).toBe("light");
    expect(resolveInitialTheme("dark", false)).toBe("dark");
  });

  it("ignores junk stored values", () => {
    expect(resolveInitialTheme("banana", false)).toBe("light");
    expect(resolveInitialTheme("banana", true)).toBe("dark");
  });

  it("falls back to the OS preference when nothing is stored", () => {
    expect(resolveInitialTheme(null, false)).toBe("light");
    expect(resolveInitialTheme(null, true)).toBe("dark");
    expect(resolveInitialTheme(undefined, true)).toBe("dark");
  });
});

describe("themeInitScript", () => {
  it("embeds the storage key and adds the dark class without flash", () => {
    const script = themeInitScript();
    expect(script).toContain(THEME_STORAGE_KEY);
    expect(script).toContain('classList.add("dark")');
    expect(script).toContain("prefers-color-scheme: dark");
  });

  it("keeps the pick logic consistent with resolveInitialTheme", () => {
    // The inline script must resolve the same way the hook does, or the
    // first paint would disagree with the first React render.
    expect(themeInitScript()).toContain(
      'stored==="light"||stored==="dark")return stored',
    );
  });
});
