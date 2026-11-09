import { expect, it } from "vitest";
import { parseProjectReleaseConfiguration, parseProjectReleaseManifest, releasePath, isForbiddenReleasePath } from "../release";

it("validates entry selection and release overrides without widening the registered project", () => {
  expect(parseProjectReleaseConfiguration({ entries: ["agent"], entryOverrides: { agent: { entry: "release/index.ts", profiles: ["ask"] } } }, ["agent", "board"])).toMatchObject({ entries: ["agent"] });
  expect(() => parseProjectReleaseConfiguration({ entries: ["missing"] }, ["agent"])).toThrow(/registered/);
  expect(() => parseProjectReleaseConfiguration({ entries: ["agent"], defaultEntry: "board" }, ["agent", "board"])).toThrow(/defaultEntry/);
  expect(() => parseProjectReleaseConfiguration({ entryOverrides: { agent: { entry: "../private.ts" } } }, ["agent"])).toThrow(/path/);
  expect(() => parseProjectReleaseConfiguration({ build: [] }, ["agent"])).toThrow(/command/);
});
it.each(["/absolute", "../outside", "a/../secret", "a\\secret", "file:", "a//file", "trailing."])("rejects unsafe release path %s", filename => {
  expect(() => releasePath(filename)).toThrow();
});
it.each(["index.ts", "index.js.map", "tests/run.js", ".env", "entries/main/.env.local", "._index.js", "node_modules/private/index.js", "dist/steamharness/cache/private.json", "dist/steamharness/reports/run.json", "dist/steamharness/release/project/package.json", "dist/steamharness/tmp/token.json"])("never inventories private or source path %s", filename => {
  expect(isForbiddenReleasePath(filename)).toBe(true);
});
it("fails closed on unknown distribution format versions", () => {
  expect(() => parseProjectReleaseManifest({ kind: "steamharness.project.release", version: 2 })).toThrow(/Upgrade/);
});
