import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeReleaseFixture } from "../../../docs/scripts/__tests__/release-fixture.mjs";
import {
  assertStableTagTargets,
  createStableDeploymentId,
  createStableReleaseDefinition,
  deployStableRelease,
  parseRemoteTagTargets,
  resolveStableDeploymentPaths,
} from "../deploy-stable.mjs";

const commitSha = "a".repeat(40);

test("stable deployment identity includes both units and the release commit", () => {
  assert.equal(createStableDeploymentId({
    serverVersion: "0.1.5",
    serverWebVersion: "0.1.5",
    commitSha,
  }), "server-0.1.5__web-0.1.5__aaaaaaaaaaaa");
  assert.equal(
    resolveStableDeploymentPaths("/srv/steamharness-release").currentLink,
    "/srv/steamharness-release/deployments/server/stable/current",
  );
});

test("stable deployment requires both formal tags on the candidate commit", () => {
  const targets = parseRemoteTagTargets([
    `${"b".repeat(40)}\trefs/tags/server/v0.1.5`,
    `${commitSha}\trefs/tags/server/v0.1.5^{}`,
    `${commitSha}\trefs/tags/server-web/v0.1.5`,
  ].join("\n"));
  assert.doesNotThrow(() => assertStableTagTargets({
    targets,
    serverVersion: "0.1.5",
    serverWebVersion: "0.1.5",
    commitSha,
  }));
  targets.set("refs/tags/server-web/v0.1.5", "c".repeat(40));
  assert.throws(() => assertStableTagTargets({
    targets,
    serverVersion: "0.1.5",
    serverWebVersion: "0.1.5",
    commitSha,
  }), /must point to/u);
});

test("stable definition records versioned links and stable dependencies without note bodies", async () => {
  const root = await createFixture();
  try {
    const definition = await createStableReleaseDefinition({
      repoRoot: root,
      docsRoot: path.join(root, "docs"),
      version: "0.1.5",
      commitSha,
      publishedAt: "2026-08-24T12:00:00.000Z",
    });
    assert.equal(definition.releases.server.components.core, "0.1.4");
    assert.equal(definition.releases.server.components.cli, "0.1.4");
    assert.equal(definition.releases.server.docsPaths.en, "/en/guides/releases/server/v0.1.5/");
    assert.equal(definition.releases["server-web"].docsPaths["zh-CN"], "/guides/releases/server-web/v0.1.5/");
    assert.equal(definition.releases.server.releaseNotes, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stable deployment packages, activates, writes metadata, and verifies health", async () => {
  const repoRoot = await createFixture();
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "steamharness-stable-root-"));
  const calls = [];
  try {
    const result = await deployStableRelease({
      repoRoot,
      docsRoot: path.join(repoRoot, "docs"),
      verifyDocs: async (_origin, paths) => { calls.push({ command: "docs", args: Object.values(paths) }); },
      releaseRoot,
      version: "0.1.5",
      commitSha,
      publishedAt: "2026-08-24T12:00:00.000Z",
      publicUrl: "https://api.steamharness.example.com",
      verifyTags: false,
      healthTimeoutMs: 10,
      runCommand: async (command, args) => {
        calls.push({ command, args });
        if (command === "corepack") await createPackagedRelease(args.at(-1));
      },
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            data: {
              versions: { serverVersion: "0.1.5" },
              deployment: {
                server: { version: "0.1.5", commitSha },
                serverWeb: { version: "0.1.5", commitSha },
              },
            },
          };
        },
      }),
    });
    const paths = resolveStableDeploymentPaths(releaseRoot);
    assert.equal(path.resolve(path.dirname(paths.currentLink), await readlink(paths.currentLink)), result.releaseDir);
    const serverMetadata = JSON.parse(await readFile(path.join(paths.metadataRoot, "server", "stable", "release.json"), "utf8"));
    const webMetadata = JSON.parse(await readFile(path.join(paths.metadataRoot, "server-web", "stable", "release.json"), "utf8"));
    assert.equal(serverMetadata.deploymentId, result.deploymentId);
    assert.equal(webMetadata.tag, "server-web/v0.1.5");
    assert.equal(serverMetadata.releaseNotes, undefined);
    assert.deepEqual(calls.slice(0, 2).map(call => call.command), ["docs", "docs"]);
    assert.equal(calls.filter(({ args }) => args.at(-1) === "start").length, 1);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "steamharness-stable-fixture-"));
  await mkdir(path.join(root, "web"), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, "package.json"), `${JSON.stringify({
      version: "0.1.5",
      dependencies: { "steamharness": "0.1.4" },
      devDependencies: { "@steamharness/cli": "0.1.4" },
    })}\n`, "utf8"),
    writeFile(path.join(root, "web", "package.json"), '{"version":"0.1.5"}\n', "utf8"),
    writeReleaseFixture(path.join(root, "docs"), "server", "0.1.5"),
    writeReleaseFixture(path.join(root, "docs"), "server-web", "0.1.5"),
  ]);
  return root;
}

async function createPackagedRelease(root) {
  for (const directory of ["dist", "public", "scripts", "web"]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await Promise.all([
    writeFile(path.join(root, "dist", "index.js"), "", "utf8"),
    writeFile(path.join(root, "public", "index.html"), "", "utf8"),
    writeFile(path.join(root, "scripts", "deploy.mjs"), "", "utf8"),
    writeFile(path.join(root, "package.json"), "{}\n", "utf8"),
    writeFile(path.join(root, "web", "package.json"), "{}\n", "utf8"),
  ]);
}
