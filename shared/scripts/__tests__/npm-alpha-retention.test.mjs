import assert from "node:assert/strict";
import test from "node:test";
import {
  deprecateSupersededAlphaVersions,
  selectSupersededAlphaVersions,
} from "../../release-tools/npm-alpha-retention.mjs";

test("npm alpha retention keeps only the latest three prereleases", () => {
  assert.deepEqual(selectSupersededAlphaVersions([
    "0.1.3",
    "0.1.4-20260813009",
    "0.1.4-20260814001",
    "0.1.4-20260814003",
    "0.1.4-20260814002",
  ]), ["0.1.4-20260813009"]);
});

test("npm alpha retention skips versions that are already deprecated", async () => {
  const calls = [];
  const versions = [
    "0.1.4-20260813001",
    "0.1.4-20260813002",
    "0.1.4-20260814001",
    "0.1.4-20260814002",
    "0.1.4-20260814003",
  ];
  const result = await deprecateSupersededAlphaVersions({
    packageName: "workflow-code",
    currentVersion: "0.1.4-20260814003",
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args[1] === "workflow-code") return JSON.stringify(versions);
      if (args[0] === "view" && args[1].endsWith("20260813001")) {
        return JSON.stringify("Already superseded.");
      }
      if (args[0] === "view") return "";
      return "";
    },
  });

  assert.deepEqual(result, {
    retained: versions.slice(-3),
    deprecated: versions.slice(0, 2),
    updated: ["0.1.4-20260813002"],
    alreadyDeprecated: ["0.1.4-20260813001"],
  });
  assert.deepEqual(calls.filter((call) => call.args[0] === "deprecate").map((call) => call.args[1]), [
    "workflow-code@0.1.4-20260813002",
  ]);
});

test("npm alpha retention accepts a concurrent idempotent deprecation", async () => {
  let deprecationReads = 0;
  const result = await deprecateSupersededAlphaVersions({
    packageName: "workflow-code",
    currentVersion: "0.1.4-20260814003",
    retain: 1,
    runCommand: async (_command, args) => {
      if (args[1] === "workflow-code") {
        return JSON.stringify(["0.1.4-20260814002", "0.1.4-20260814003"]);
      }
      if (args[0] === "view") {
        deprecationReads += 1;
        return deprecationReads === 1 ? "" : JSON.stringify("Already superseded.");
      }
      throw new Error("npm returned 422");
    },
  });

  assert.deepEqual(result.updated, ["0.1.4-20260814002"]);
  assert.deepEqual(result.alreadyDeprecated, []);
});
