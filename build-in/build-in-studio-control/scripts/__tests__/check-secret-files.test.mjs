import { describe, expect, it } from "vitest";
import {
  findUnsafeEnvironmentPaths,
  findUnsafeExampleAssignments,
  findUnsafeHistoricalExampleAssignments,
} from "../check-secret-files.mjs";

describe("secret file audit", () => {
  it("rejects env files from the index or history", () => {
    expect(findUnsafeEnvironmentPaths({
      tracked: [".env.example"],
      historical: [".env"],
    })).toEqual([".env"]);
  });

  it("accepts empty placeholders and rejects live-looking keys", () => {
    expect(findUnsafeExampleAssignments("LLM_API_KEY=\n")).toEqual([]);
    expect(findUnsafeExampleAssignments("LLM_API_KEY=sk-live-value\n")).toEqual([
      { line: 1, name: "LLM_API_KEY" },
    ]);
  });

  it("scans deleted examples in reachable history", async () => {
    await expect(findUnsafeHistoricalExampleAssignments([
      { objectId: "unsafe", filePath: ".env.example" },
    ], async () => "LLM_API_KEY=sk-live-value\n")).resolves.toEqual([
      { filePath: ".env.example", line: 1, name: "LLM_API_KEY" },
    ]);
  });
});
