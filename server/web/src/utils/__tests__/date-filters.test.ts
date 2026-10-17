import { describe, expect, it } from "vitest";
import { normalizeDateTimeFilter } from "../date-filters";

describe("date filter normalization", () => {
  it("expands date-only filters to inclusive UTC day boundaries", () => {
    expect(normalizeDateTimeFilter("2026-06-30")).toBe("2026-06-30T00:00:00.000Z");
    expect(normalizeDateTimeFilter("2026-06-30", "end")).toBe("2026-06-30T23:59:59.999Z");
  });

  it("keeps explicit datetimes precise and ignores malformed values", () => {
    expect(normalizeDateTimeFilter("2026-06-30T12:34:56.000Z", "end")).toBe("2026-06-30T12:34:56.000Z");
    expect(normalizeDateTimeFilter("not-a-date", "end")).toBeUndefined();
  });
});
