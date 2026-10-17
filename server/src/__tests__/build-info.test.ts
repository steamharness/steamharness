import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readServerBuildInfo } from "../build-info";

test("Server build info validates product and embedded Core versions", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "server-build-info-"));
  const serverRoot = repoRoot;
  try {
    await Promise.all([
      writeJson(path.join(serverRoot, "package.json"), { version: "0.3.0" }),
      writeJson(path.join(repoRoot, "node_modules/steamharness/package.json"), { version: "0.2.0" }),
      writeJson(path.join(serverRoot, "dist/build-info.json"), {
        productVersion: "0.3.0",
        coreVersion: "0.2.0",
        commitSha: "abcdef",
        nodeVersion: "24.15.0",
      }),
    ]);
    assert.deepEqual(await readServerBuildInfo({ repoRoot, serverRoot, strict: true }), {
      productVersion: "0.3.0",
      coreVersion: "0.2.0",
      commitSha: "abcdef",
      nodeVersion: "24.15.0",
    });
    await writeJson(path.join(serverRoot, "dist/build-info.json"), {
      productVersion: "0.3.0",
      coreVersion: "0.2.1",
      commitSha: "abcdef",
      nodeVersion: "24.15.0",
    });
    await assert.rejects(readServerBuildInfo({ repoRoot, serverRoot, strict: true }), /do not match manifests/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("Server development build info ignores stale build output", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "server-build-info-dev-"));
  const serverRoot = repoRoot;
  try {
    await Promise.all([
      writeJson(path.join(serverRoot, "package.json"), { version: "0.3.0" }),
      writeJson(path.join(repoRoot, "node_modules/steamharness/package.json"), { version: "0.2.0" }),
      writeJson(path.join(serverRoot, "dist/build-info.json"), {
        productVersion: "0.2.9",
        coreVersion: "0.1.9",
        commitSha: "stale-build",
        nodeVersion: "22.0.0",
      }),
    ]);

    assert.deepEqual(await readServerBuildInfo({ repoRoot, serverRoot }), {
      productVersion: "0.3.0",
      coreVersion: "0.2.0",
      commitSha: "unknown",
      nodeVersion: process.versions.node,
    });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}
