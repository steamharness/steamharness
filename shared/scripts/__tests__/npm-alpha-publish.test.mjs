import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  calculateTarballIntegrity,
  compareNpmAlphaVersions,
  publishNpmAlpha,
} from "../../release-tools/npm-alpha-publish.mjs";

test("npm alpha versions compare by stable base, Shanghai date, and daily sequence", () => {
  assert.equal(compareNpmAlphaVersions("0.1.4-20260814002", "0.1.4-20260814001"), 1);
  assert.equal(compareNpmAlphaVersions("0.1.5-20260813001", "0.1.4-20260814999"), 1);
  assert.equal(compareNpmAlphaVersions("0.1.4-20260814001", "0.1.4-20260814001"), 0);
});

test("npm alpha publishing reuses only an identical immutable tarball", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-npm-alpha-publish-"));
  try {
    const releaseDir = path.join(root, ".release");
    const tarball = path.join(releaseDir, "workflow-code-0.1.4-20260814001.tgz");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(tarball, "immutable-alpha-package");
    const integrity = await calculateTarballIntegrity(tarball);
    const calls = [];
    const result = await publishNpmAlpha({
      root,
      packageName: "workflow-code",
      version: "0.1.4-20260814001",
      runCommand: async (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === "view" && args[1] === "workflow-code@alpha") {
          return JSON.stringify("0.1.4-20260814001");
        }
        return args[0] === "view" ? JSON.stringify(integrity) : "";
      },
    });
    assert.equal(result.reused, true);
    assert.equal(calls.some((call) => call.includes("publish")), false);
    assert.deepEqual(calls.at(-1), ["npm", "dist-tag", "add", "workflow-code@0.1.4-20260814001", "alpha"]);

    // Rebuilds are not byte-reproducible, so a re-run of a pipeline that already
    // uploaded this version packs a different tarball. The registry copy is the
    // version's only artefact and the tag ledger pins the version to the commit,
    // so the re-run keeps it and carries on with the downstream synchronization.
    const warnings = [];
    const reused = await publishNpmAlpha({
      root,
      packageName: "workflow-code",
      version: "0.1.4-20260814001",
      log: (message) => warnings.push(message),
      runCommand: async (_command, args) => {
        if (args[0] === "view" && args[1] === "workflow-code@alpha") {
          return JSON.stringify("0.1.4-20260814001");
        }
        return args[0] === "view" ? JSON.stringify(`sha512-${"x".repeat(20)}`) : "";
      },
    });
    assert.equal(reused.reused, true);
    assert.match(warnings.join("\n"), /already published with a different tarball/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("npm alpha publishing uploads a missing tarball and verifies registry integrity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-npm-alpha-upload-"));
  try {
    const releaseDir = path.join(root, ".release");
    const tarball = path.join(releaseDir, "workflow-code-0.1.4-20260814002.tgz");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(tarball, "new-alpha-package");
    const integrity = await calculateTarballIntegrity(tarball);
    let published = false;
    const result = await publishNpmAlpha({
      root,
      packageName: "workflow-code",
      version: "0.1.4-20260814002",
      retryDelayMs: 0,
      runCommand: async (_command, args) => {
        if (args[0] === "view" && args[1] === "workflow-code@alpha") {
          throw new Error("npm view exited 1: E404 Not Found");
        }
        if (args[0] === "view") {
          if (!published) throw new Error("npm view exited 1: E404 Not Found");
          return JSON.stringify(integrity);
        }
        if (args[0] === "publish") published = true;
        return "";
      },
    });
    assert.equal(result.reused, false);
    assert.equal(published, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("npm alpha publishing waits out npm's asynchronous processing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-npm-alpha-processing-"));
  try {
    const releaseDir = path.join(root, ".release");
    const tarball = path.join(releaseDir, "workflow-code-0.1.4-20260814002.tgz");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(tarball, "processing-alpha-package");
    const integrity = await calculateTarballIntegrity(tarball);
    let published = false;
    let readbacks = 0;
    const result = await publishNpmAlpha({
      root,
      packageName: "workflow-code",
      version: "0.1.4-20260814002",
      retryDelayMs: 0,
      log: () => {},
      runCommand: async (_command, args) => {
        if (args[0] === "view" && args[1] === "workflow-code@alpha") {
          throw new Error("npm view exited 1: E404 Not Found");
        }
        if (args[0] === "view") {
          readbacks += 1;
          // `npm publish` reports success while the registry still refuses to name
          // the version; the readback has to keep asking instead of failing.
          if (!published || readbacks < 4) throw new Error("npm view exited 1: E404 Not Found");
          return JSON.stringify(integrity);
        }
        if (args[0] === "publish") published = true;
        return "";
      },
    });
    assert.equal(result.reused, false);
    assert.ok(readbacks >= 4, `expected the readback to retry, saw ${readbacks}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("npm alpha publishing rejects a tarball it uploaded itself under a different digest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-npm-alpha-digest-"));
  try {
    const releaseDir = path.join(root, ".release");
    const tarball = path.join(releaseDir, "workflow-code-0.1.4-20260814002.tgz");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(tarball, "tampered-alpha-package");
    let published = false;
    await assert.rejects(publishNpmAlpha({
      root,
      packageName: "workflow-code",
      version: "0.1.4-20260814002",
      retryDelayMs: 0,
      log: () => {},
      runCommand: async (_command, args) => {
        if (args[0] === "view" && args[1] === "workflow-code@alpha") {
          throw new Error("npm view exited 1: E404 Not Found");
        }
        if (args[0] === "view") {
          if (!published) throw new Error("npm view exited 1: E404 Not Found");
          return JSON.stringify(`sha512-${"y".repeat(20)}`);
        }
        if (args[0] === "publish") published = true;
        return "";
      },
    }), /was uploaded but read back with different tarball integrity/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("npm channel publishing isolates development packages from the alpha dist-tag", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-npm-dev-publish-"));
  try {
    const releaseDir = path.join(root, ".release");
    const tarball = path.join(releaseDir, "workflow-code-0.2.3-20260901001.tgz");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(tarball, "new-development-package");
    const integrity = await calculateTarballIntegrity(tarball);
    let published = false;
    const calls = [];
    const result = await publishNpmAlpha({
      root,
      packageName: "workflow-code",
      version: "0.2.3-20260901001",
      distTag: "dev",
      retryDelayMs: 0,
      runCommand: async (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === "view" && args[1] === "workflow-code@dev") {
          throw new Error("npm view exited 1: E404 Not Found");
        }
        if (args[0] === "view") {
          if (!published) throw new Error("npm view exited 1: E404 Not Found");
          return JSON.stringify(integrity);
        }
        if (args[0] === "publish") published = true;
        return "";
      },
    });
    assert.equal(result.distTag, "dev");
    assert.equal(calls.some((call) => call.at(-1) === "alpha"), false);
    assert.deepEqual(calls.at(-1), ["npm", "dist-tag", "add", "workflow-code@0.2.3-20260901001", "dev"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("npm alpha publishing refuses to move the alpha dist-tag backwards", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-npm-alpha-order-"));
  try {
    const releaseDir = path.join(root, ".release");
    const tarball = path.join(releaseDir, "workflow-code-0.1.4-20260814002.tgz");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(tarball, "superseded-alpha-package");
    const calls = [];
    await assert.rejects(publishNpmAlpha({
      root,
      packageName: "workflow-code",
      version: "0.1.4-20260814002",
      runCommand: async (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === "view" && args[1] === "workflow-code@alpha") {
          return JSON.stringify("0.1.4-20260814003");
        }
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
    }), /superseded by the npm alpha dist-tag/);
    assert.equal(calls.some((call) => call.includes("publish") || call.includes("dist-tag")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
