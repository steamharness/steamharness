import { describe, expect, it } from "vitest";
import { formatDate, formatDateGroup, formatDateOnly, formatTime } from "../format";

describe("Server Web date formatting", () => {
  it("uses second precision for event timestamps", () => {
    expect(formatDate("2026-08-10T15:53:11")).toBe("2026-08-10 15:53:11");
    expect(formatTime("2026-08-10T15:53:11")).toBe("2026-08-10 15:53:11");
  });

  it("uses date-only output for calendar groups", () => {
    expect(formatDateOnly("2026-08-10T15:53:11")).toBe("2026-08-10");
    expect(formatDateOnly("2026-08-10")).toBe("2026-08-10");
    expect(formatDateGroup("2026-08-10T15:53:11")).toBe("2026-08-10");
    expect(formatDateGroup("2026-08-10")).toBe("2026-08-10");
  });

  it("preserves invalid input fallbacks", () => {
    expect(formatDate("not-a-date")).toBe("not-a-date");
    expect(formatTime("not-a-date")).toBe("not-a-date");
  });
});
