import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  SUPPORTED_LOCALES,
} from "../types";
import {
  normalizeLocale,
  persistLocale,
  readStoredLocale,
  resolveLocalePreference,
  resolveSystemLocale,
} from "../utils/locale";

const STORAGE_KEY = "steamharness:test:locale";

describe("normalizeLocale", () => {
  it("maps zh variants to zh-CN", () => {
    expect(normalizeLocale("zh")).toBe("zh-CN");
    expect(normalizeLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeLocale("zh-TW")).toBe("zh-CN");
    expect(normalizeLocale("zh_CN")).toBe("zh-CN");
    expect(normalizeLocale("zh-Hans")).toBe("zh-CN");
  });

  it("maps en variants to en", () => {
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("en-GB")).toBe("en");
    expect(normalizeLocale("EN")).toBe("en");
  });

  it("falls back to the default for unsupported locales", () => {
    expect(normalizeLocale("ja")).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale("")).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale(null)).toBe(DEFAULT_LOCALE);
  });
});

describe("resolveSystemLocale", () => {
  it("returns a supported locale", () => {
    const locale = resolveSystemLocale();
    expect(SUPPORTED_LOCALES).toContain(locale);
  });

  it("uses the first supported host language instead of the browser locale", () => {
    expect(resolveSystemLocale(["zh-Hans-CN", "en-CN"])).toBe("zh-CN");
  });

  it("skips unsupported host languages before falling back to a supported one", () => {
    expect(resolveSystemLocale(["ja-JP", "en-US", "zh-Hans-CN"])).toBe("en");
  });

  it("uses the default locale when the host has no supported language", () => {
    expect(resolveSystemLocale(["ja-JP", "fr-FR"])).toBe(DEFAULT_LOCALE);
  });
});

describe("resolveLocalePreference", () => {
  it("returns the explicit locale unchanged", () => {
    expect(resolveLocalePreference("en")).toBe("en");
    expect(resolveLocalePreference("zh-CN")).toBe("zh-CN");
  });

  it("resolves system to a supported locale", () => {
    const locale = resolveLocalePreference("system");
    expect(SUPPORTED_LOCALES).toContain(locale);
  });

  it("passes host language preference through when following the system", () => {
    expect(resolveLocalePreference("system", ["zh-Hans-CN", "en-CN"])).toBe("zh-CN");
  });
});

describe("locale persistence", () => {
  it("round-trips an explicit preference", () => {
    persistLocale(STORAGE_KEY, "en");
    expect(readStoredLocale(STORAGE_KEY)).toBe("en");
    persistLocale(STORAGE_KEY, "zh-CN");
    expect(readStoredLocale(STORAGE_KEY)).toBe("zh-CN");
  });

  it("round-trips system preference", () => {
    persistLocale(STORAGE_KEY, "system");
    expect(readStoredLocale(STORAGE_KEY)).toBe("system");
  });

  it("treats missing or invalid stored values as system", () => {
    window.localStorage.removeItem(STORAGE_KEY);
    expect(readStoredLocale(STORAGE_KEY)).toBe("system");
    window.localStorage.setItem(STORAGE_KEY, "not-a-locale");
    expect(readStoredLocale(STORAGE_KEY)).toBe("system");
  });
});

describe("isSupportedLocale", () => {
  it("accepts only supported locales", () => {
    expect(isSupportedLocale("en")).toBe(true);
    expect(isSupportedLocale("zh-CN")).toBe(true);
    expect(isSupportedLocale("fr")).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
  });
});
