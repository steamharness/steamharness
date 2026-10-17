import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bumpStableManifestVersions,
  formatReleaseDotenv,
  formatAlphaDate,
  hasReleaseChanges,
  nextAlphaVersion,
  parseRemoteAlphaTags,
  parseRemoteBranchHead,
  readAlphaVersionFromTag,
  reserveAlphaVersion,
  writeAlphaManifestVersions,
} from "../../release-tools/alpha-release.mjs";

const BEFORE_SHA = "a".repeat(40);
const CURRENT_SHA = "b".repeat(40);

test("release dotenv output can use an isolated development prefix", () => {
  assert.equal(formatReleaseDotenv({
    version: "0.2.3-20260901001",
    tag: "dev/v0.2.3-20260901001",
  }, "DEV"), "DEV_VERSION=0.2.3-20260901001\nDEV_TAG=dev/v0.2.3-20260901001\n");
  assert.throws(() => formatReleaseDotenv({ version: "0.2.3", tag: "dev/v0.2.3" }, "dev"), /prefix is invalid/);
});

test("alpha versions use the declared alpha branch version and a daily three-digit sequence", () => {
  assert.equal(nextAlphaVersion({
    baseVersion: "0.1.20",
    date: "20260814",
    existingVersions: [
      "0.1.20-20260814001",
      "0.1.20-20260814002",
      "0.1.20-20260813009",
      "0.1.19-20260814099",
    ],
  }), "0.1.20-20260814003");
  assert.equal(formatAlphaDate(new Date("2026-08-13T16:30:00.000Z")), "20260814");
});

test("release change detection ignores version and release bookkeeping", async () => {
  const runCommand = async (_command, args) => {
    if (args[0] === "diff") {
      return [
        "M\tpackage.json",
        "M\tCHANGELOG.md",
        "M\tCHANGELOG.next.md",
        "M\t.gitlab-ci.yml",
        "M\tvendor/shared/.workflow-shared-release.json",
        "M\tvendor/shared/release-tools/alpha-release.mjs",
      ].join("\n");
    }
    if (args[0] === "show") return '{"name":"unit","version":"0.1.1"}\n';
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };
  assert.equal(await hasReleaseChanges({
    root: "/workspace",
    beforeSha: BEFORE_SHA,
    currentSha: CURRENT_SHA,
    runCommand,
  }), false);
});

test("release change detection ignores policy, test, and documentation paths", async () => {
  const ignoredPaths = [
    "AGENTS.md",
    "CLAUDE.md",
    ".agents/skills/workflow-release/SKILL.md",
    ".claude/settings.json",
    ".codex/release-notes.json",
    "src/__tests__/alpha.test.ts",
    "workspace/__tests__/workflow.test.ts",
    "scripts/__tests__/release.test.mjs",
    "docs/guides/release.mdx",
    "documentation/README.md",
    "guides/server/deployment.mdx",
    "README.md",
    "DESIGN.md",
  ];
  assert.equal(await hasReleaseChanges({
    root: "/workspace",
    beforeSha: BEFORE_SHA,
    currentSha: CURRENT_SHA,
    runCommand: async (_command, args) => args[0] === "diff"
      ? ignoredPaths.map((filePath) => `M\t${filePath}`).join("\n")
      : "",
  }), false);
});

test("release change detection still includes product files beside ignored tests", async () => {
  assert.equal(await hasReleaseChanges({
    root: "/workspace",
    beforeSha: BEFORE_SHA,
    currentSha: CURRENT_SHA,
    runCommand: async (_command, args) => args[0] === "diff"
      ? "M\tsrc/index.ts\nM\tsrc/__tests__/index.test.ts\n"
      : "",
  }), true);
});

test("release change detection includes source and dependency changes", async () => {
  const sourceResult = await hasReleaseChanges({
    root: "/workspace",
    beforeSha: BEFORE_SHA,
    currentSha: CURRENT_SHA,
    runCommand: async (_command, args) => args[0] === "diff" ? "M\tsrc/index.ts\n" : "",
  });
  assert.equal(sourceResult, true);

  const dependencyResult = await hasReleaseChanges({
    root: "/workspace",
    beforeSha: BEFORE_SHA,
    currentSha: CURRENT_SHA,
    runCommand: async (_command, args) => {
      if (args[0] === "diff") return "M\tpackage.json\n";
      if (args[0] === "show" && args[1].startsWith(`${BEFORE_SHA}:`)) return '{"name":"unit","version":"0.1.1","dependencies":{"dep":"1.0.0"}}\n';
      if (args[0] === "show") return '{"name":"unit","version":"0.1.1","dependencies":{"dep":"1.1.0"}}\n';
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    },
  });
  assert.equal(dependencyResult, true);
});

test("alpha tag parsing ignores unrelated and peeled refs", () => {
  assert.equal(readAlphaVersionFromTag("refs/tags/alpha/v0.1.4-20260814001"), "0.1.4-20260814001");
  assert.equal(readAlphaVersionFromTag("refs/tags/alpha/v0.1.4-20260814001^{}"), undefined);
  assert.equal(readAlphaVersionFromTag("refs/tags/main/v0.1.4"), undefined);
});

test("alpha branch head parsing requires the exact named branch", () => {
  const sha = "a".repeat(40);
  assert.equal(parseRemoteBranchHead(`${sha}\trefs/heads/alpha\n`, "alpha"), sha);
  assert.throws(() => parseRemoteBranchHead(`${sha}\trefs/heads/dev\n`, "alpha"), /does not resolve/);
});

test("alpha reservation reuses the tag already assigned to the same commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-alpha-reservation-"));
  const commitSha = "a".repeat(40);
  try {
    await writeFile(path.join(root, "package.json"), '{"name":"core","version":"0.1.5"}\n');
    const remoteOutput = [
      `${"b".repeat(40)}\trefs/tags/alpha/v0.1.5-20260814001`,
      `${commitSha}\trefs/tags/alpha/v0.1.5-20260814002`,
    ].join("\n");
    assert.deepEqual(parseRemoteAlphaTags(remoteOutput), [
      { tag: "alpha/v0.1.5-20260814001", version: "0.1.5-20260814001", commitSha: "b".repeat(40) },
      { tag: "alpha/v0.1.5-20260814002", version: "0.1.5-20260814002", commitSha },
    ]);
    const calls = [];
    const result = await reserveAlphaVersion({
      root,
      manifestPaths: ["package.json"],
      commitSha,
      branch: "alpha",
      runCommand: async (_command, args) => {
        calls.push(args);
        if (args.includes("--heads")) return `${commitSha}\trefs/heads/alpha\n`;
        return remoteOutput;
      },
    });
    assert.deepEqual(result, {
      version: "0.1.5-20260814002",
      tag: "alpha/v0.1.5-20260814002",
      reused: true,
    });
    assert.equal(calls.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("alpha reservation can skip a bookkeeping-only commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-alpha-no-change-"));
  try {
    await writeFile(path.join(root, "package.json"), '{"name":"core","version":"0.1.5"}\n');
    const calls = [];
    const result = await reserveAlphaVersion({
      root,
      manifestPaths: ["package.json"],
      commitSha: CURRENT_SHA,
      branch: "alpha",
      ifChanged: true,
      beforeSha: BEFORE_SHA,
      runCommand: async (_command, args) => {
        calls.push(args);
        if (args.includes("--heads")) return `${CURRENT_SHA}\trefs/heads/alpha\n`;
        if (args[0] === "diff") return "M\tpackage.json\nM\tCHANGELOG.md\n";
        if (args[0] === "show") return '{"name":"core","version":"0.1.5"}\n';
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      },
    });
    assert.deepEqual(result, { changed: false, commitSha: CURRENT_SHA });
    assert.equal(calls.some((args) => args[0] === "tag"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("alpha reservation refuses a pipeline superseded by the remote branch head", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-alpha-stale-"));
  const commitSha = "a".repeat(40);
  const remoteHead = "b".repeat(40);
  try {
    await writeFile(path.join(root, "package.json"), '{"name":"core","version":"0.1.5"}\n');
    await assert.rejects(reserveAlphaVersion({
      root,
      manifestPaths: ["package.json"],
      commitSha,
      branch: "alpha",
      runCommand: async (_command, args) => args.includes("--heads")
        ? `${remoteHead}\trefs/heads/alpha\n`
        : "",
    }), /superseded by origin\/alpha/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("alpha reservation skips dated versions already used by the sibling channel", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-alpha-sibling-channel-"));
  const commitSha = "a".repeat(40);
  try {
    await writeFile(path.join(root, "package.json"), '{"name":"core","version":"0.2.3"}\n');
    const result = await reserveAlphaVersion({
      root,
      manifestPaths: ["package.json"],
      commitSha,
      branch: "alpha",
      date: "20260901",
      dryRun: true,
      runCommand: async (_command, args) => {
        if (args.includes("--heads")) return `${commitSha}\trefs/heads/alpha\n`;
        if (args.includes("refs/tags/dev/v*")) {
          return `${"b".repeat(40)}\trefs/tags/dev/v0.2.3-20260901001\n`;
        }
        return "";
      },
    });
    assert.deepEqual(result, {
      version: "0.2.3-20260901002",
      tag: "alpha/v0.2.3-20260901002",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("alpha manifest writes keep every unit on the declared alpha branch base", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-alpha-version-"));
  try {
    await Promise.all([
      writeFile(path.join(root, "package.json"), '{"name":"server","version":"0.1.5"}\n'),
      writeFile(path.join(root, "web.json"), '{"name":"server-web","version":"0.1.5"}\n'),
    ]);
    await writeAlphaManifestVersions({
      root,
      manifestPaths: ["package.json", "web.json"],
      version: "0.1.5-20260814001",
    });
    assert.equal(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version, "0.1.5-20260814001");
    assert.equal(JSON.parse(await readFile(path.join(root, "web.json"), "utf8")).version, "0.1.5-20260814001");
    await writeAlphaManifestVersions({
      root,
      manifestPaths: ["package.json", "web.json"],
      version: "0.1.5-20260814001",
    });
    await assert.rejects(
      writeAlphaManifestVersions({ root, manifestPaths: ["package.json"], version: "0.1.6-20260814001" }),
      /already uses alpha version/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stable base bumps require an explicit increment flag and keep manifests aligned", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-stable-bump-"));
  try {
    await Promise.all([
      writeFile(path.join(root, "package.json"), '{"name":"server","version":"0.1.5"}\n'),
      writeFile(path.join(root, "web.json"), '{"name":"server-web","version":"0.1.5"}\n'),
    ]);
    await assert.rejects(
      bumpStableManifestVersions({ root, manifestPaths: ["package.json", "web.json"] }),
      /explicit --increment-patch/,
    );
    const result = await bumpStableManifestVersions({
      root,
      manifestPaths: ["package.json", "web.json"],
      incrementPatch: true,
    });
    assert.equal(result.version, "0.1.6");
    assert.equal(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version, "0.1.6");
    assert.equal(JSON.parse(await readFile(path.join(root, "web.json"), "utf8")).version, "0.1.6");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
