import { describe, expect, it } from "vitest";
import { compareStrings, formatDate, formatDateTime, formatNumber } from "../utils/format";

describe("fixed date formatting", () => {
  const localDate = new Date(2024, 5, 15, 10, 30, 45);

  it("uses the same fixed numeric output for every supported locale", () => {
    expect(formatDateTime(localDate, {}, "en")).toBe("2024-06-15 10:30:45");
    expect(formatDateTime(localDate, {}, "zh-CN")).toBe("2024-06-15 10:30:45");
    expect(formatDate(localDate, {}, "en")).toBe("2024-06-15");
    expect(formatDate(localDate, {}, "zh-CN")).toBe("2024-06-15");
  });

  it("accepts strings and timestamps without dropping seconds", () => {
    expect(formatDateTime("2024-06-15T10:30:45")).toBe("2024-06-15 10:30:45");
    expect(formatDateTime(localDate.getTime())).toBe("2024-06-15 10:30:45");
    expect(formatDate("2024-06-15")).toBe("2024-06-15");
  });

  it("formats the requested timezone deterministically", () => {
    const date = new Date("2024-06-15T10:30:45.000Z");
    expect(formatDateTime(date, { timeZone: "UTC" })).toBe("2024-06-15 10:30:45");
    expect(formatDateTime(date, { timeZone: "Asia/Shanghai" })).toBe("2024-06-15 18:30:45");
    expect(formatDate(date, { timeZone: "Asia/Shanghai" })).toBe("2024-06-15");
  });

  it("keeps four-digit years and rejects invalid values", () => {
    expect(formatDateTime("0001-01-15T00:00:00.000Z", { timeZone: "UTC" })).toBe("0001-01-15 00:00:00");
    expect(formatDate("0001-01-15")).toBe("0001-01-15");
    expect(() => formatDateTime("not-a-date")).toThrow(RangeError);
    expect(() => formatDate("2026-02-29")).toThrow(RangeError);
  });
});

describe("formatNumber", () => {
  it("formats with the requested locale", () => {
    expect(formatNumber(1234.5, { maximumFractionDigits: 1 }, "en")).toBe(
      new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(1234.5),
    );
    expect(formatNumber(1234.5, { maximumFractionDigits: 1 }, "zh-CN")).toBe(
      new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(1234.5),
    );
  });
});

describe("compareStrings", () => {
  it("compares locale-aware", () => {
    expect(compareStrings("a", "b", "en")).toBeLessThan(0);
    expect(compareStrings("b", "a", "en")).toBeGreaterThan(0);
    expect(compareStrings("a", "a", "en")).toBe(0);
  });
});
