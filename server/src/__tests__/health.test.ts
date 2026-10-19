import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectServerHealthData } from "../health";

test("health payload prefers deployed release metadata for server and server-web", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "steamharness-server-health-"));

  try {
    const serverRoot = path.join(tempRoot, "server");
    const metadataRoot = path.join(tempRoot, "releases");
    await mkdir(path.join(serverRoot, "web"), { recursive: true });
    await mkdir(path.join(metadataRoot, "server", "stable"), { recursive: true });
    await mkdir(path.join(metadataRoot, "server-web", "stable"), { recursive: true });

    await writeFile(path.join(serverRoot, "package.json"), JSON.stringify({ version: "0.1.0" }), "utf8");
    await writeFile(path.join(serverRoot, "web", "package.json"), JSON.stringify({ version: "0.1.0" }), "utf8");
    await writeFile(
      path.join(metadataRoot, "server", "stable", "release.json"),
      JSON.stringify({
        unit: "server",
        tag: "server/v0.2.0",
        version: "0.2.0",
        publishedAt: "2026-06-29T08:00:00Z",
        commitSha: "abcdef123456",
        components: { core: "0.1.5" },
        releaseNotes: {
          format: "markdown",
          body: "## Added\n\n- 新增 Core 兼容检查。",
          localizations: {
            "zh-CN": { format: "markdown", body: "## Added\n\n- 新增 Core 兼容检查。" },
            en: { format: "markdown", body: "## Added\n\n- Add Core compatibility checks." },
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      path.join(metadataRoot, "server-web", "stable", "release.json"),
      JSON.stringify({
        unit: "server-web",
        tag: "server-web/v0.2.1",
        version: "0.2.1",
        publishedAt: "2026-06-29T08:05:00Z",
        commitSha: "fedcba654321",
      }),
      "utf8",
    );

    const health = await createProjectServerHealthData({
      mode: "production",
      startedAt: "2026-06-29T09:00:00Z",
      serverRoot,
      metadataRoot,
      locale: "zh-CN",
      buildInfo: {
        productVersion: "0.2.0",
        coreVersion: "0.1.5",
        commitSha: "abcdef123456",
        nodeVersion: process.versions.node,
      },
    });

    assert.deepEqual(health, {
      status: "ok",
      runtime: {
        mode: "production",
        startedAt: "2026-06-29T09:00:00Z",
      },
      versions: {
        serverVersion: "0.2.0",
        coreVersion: "0.1.5",
      },
      currentRelease: {
        summary: "新增 Core 兼容检查。",
        body: "## Added\n\n- 新增 Core 兼容检查。",
        docsUrl: "https://docs.steamharness.yuhe.space/guides/releases/server/v0.2.0",
      },
      deployment: {
        server: {
          unit: "server",
          tag: "server/v0.2.0",
          version: "0.2.0",
          versionLabel: "v0.2.0",
          publishedAt: "2026-06-29T08:00:00Z",
          commitSha: "abcdef123456",
          components: { core: "0.1.5" },
          releaseNotes: {
            format: "markdown",
            body: "## Added\n\n- 新增 Core 兼容检查。",
          },
          source: "release-metadata",
        },
        serverWeb: {
          unit: "server-web",
          tag: "server-web/v0.2.1",
          version: "0.2.1",
          versionLabel: "v0.2.1",
          publishedAt: "2026-06-29T08:05:00Z",
          commitSha: "fedcba654321",
          components: {},
          releaseNotes: null,
          source: "release-metadata",
        },
      },
    });

    const englishHealth = await createProjectServerHealthData({
      mode: "production",
      startedAt: "2026-06-29T09:00:00Z",
      serverRoot,
      metadataRoot,
      locale: "en",
      buildInfo: {
        productVersion: "0.2.0",
        coreVersion: "0.1.5",
        commitSha: "abcdef123456",
        nodeVersion: process.versions.node,
      },
    });
    assert.deepEqual(englishHealth.currentRelease, {
      summary: "Add Core compatibility checks.",
      body: "## Added\n\n- Add Core compatibility checks.",
      docsUrl: "https://docs.steamharness.yuhe.space/en/guides/releases/server/v0.2.0",
    });
    assert.equal(
      englishHealth.deployment.server?.releaseNotes?.body,
      "## Added\n\n- Add Core compatibility checks.",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("alpha health reads only alpha release metadata from the shared release root", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "steamharness-server-health-alpha-"));
  try {
    const serverRoot = path.join(tempRoot, "server");
    const metadataRoot = path.join(tempRoot, "releases");
    const alphaVersion = "0.1.5-20260814001";
    await mkdir(path.join(serverRoot, "web"), { recursive: true });
    for (const unit of ["server", "server-web"]) {
      await mkdir(path.join(metadataRoot, unit, "stable"), { recursive: true });
      await mkdir(path.join(metadataRoot, unit, "alpha"), { recursive: true });
      await writeFile(path.join(metadataRoot, unit, "stable", "release.json"), JSON.stringify({
        unit,
        tag: `${unit}/v0.1.4`,
        version: "0.1.4",
      }), "utf8");
      await writeFile(path.join(metadataRoot, unit, "alpha", "release.json"), JSON.stringify({
        unit,
        channel: "alpha",
        tag: `alpha/v${alphaVersion}`,
        version: alphaVersion,
        commitSha: "a".repeat(40),
      }), "utf8");
    }
    await writeFile(path.join(serverRoot, "package.json"), JSON.stringify({ version: alphaVersion }), "utf8");
    await writeFile(path.join(serverRoot, "web", "package.json"), JSON.stringify({ version: alphaVersion }), "utf8");

    const health = await createProjectServerHealthData({
      channel: "alpha",
      serverRoot,
      metadataRoot,
      buildInfo: {
        productVersion: alphaVersion,
        coreVersion: "0.1.4-20260814002",
        commitSha: "a".repeat(40),
        nodeVersion: process.versions.node,
      },
    });

    assert.equal(health.versions.serverVersion, alphaVersion);
    assert.equal(health.deployment.server?.tag, `alpha/v${alphaVersion}`);
    assert.equal(health.deployment.serverWeb?.tag, `alpha/v${alphaVersion}`);
    assert.equal(health.deployment.server?.version, alphaVersion);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("health payload reports the loaded build when stable metadata points at another deployment", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "steamharness-server-health-stale-metadata-"));

  try {
    const serverRoot = path.join(tempRoot, "server");
    const metadataRoot = path.join(tempRoot, "releases");
    await mkdir(path.join(serverRoot, "web"), { recursive: true });
    await mkdir(path.join(metadataRoot, "server", "stable"), { recursive: true });
    await writeFile(path.join(serverRoot, "package.json"), JSON.stringify({ version: "0.1.9" }), "utf8");
    await writeFile(path.join(serverRoot, "web", "package.json"), JSON.stringify({ version: "0.1.0" }), "utf8");
    await writeFile(
      path.join(metadataRoot, "server", "stable", "release.json"),
      JSON.stringify({
        unit: "server",
        tag: "server/v0.2.0",
        version: "0.2.0",
        components: { core: "0.1.5" },
        releaseNotes: { format: "markdown", body: "## Fixed\n\n- Newer deployment notes." },
      }),
      "utf8",
    );

    const health = await createProjectServerHealthData({
      serverRoot,
      metadataRoot,
      locale: "en",
      buildInfo: {
        productVersion: "0.1.9",
        coreVersion: "0.1.4",
        commitSha: "rollback-build",
        nodeVersion: process.versions.node,
      },
    });

    assert.deepEqual(health.versions, { serverVersion: "0.1.9", coreVersion: "0.1.4" });
    assert.equal(health.currentRelease, null);
    assert.equal(health.deployment.server?.version, "0.2.0");
    assert.equal(
      health.deployment.server?.releaseNotes?.body,
      "## Fixed\n\n- Newer deployment notes.",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("health payload falls back to local manifests when release metadata is absent", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "steamharness-server-health-fallback-"));

  try {
    const serverRoot = path.join(tempRoot, "server");
    await mkdir(path.join(serverRoot, "web"), { recursive: true });
    await mkdir(path.join(serverRoot, "node_modules", "steamharness"), { recursive: true });
    await writeFile(path.join(serverRoot, "package.json"), JSON.stringify({ version: "0.3.0" }), "utf8");
    await writeFile(path.join(serverRoot, "web", "package.json"), JSON.stringify({ version: "0.3.1" }), "utf8");
    await writeFile(path.join(serverRoot, "node_modules", "steamharness", "package.json"), JSON.stringify({ version: "0.2.4" }), "utf8");

    const health = await createProjectServerHealthData({
      mode: "development",
      startedAt: "2026-06-29T09:30:00Z",
      serverRoot,
    });

    assert.deepEqual(health.deployment, {
      server: {
        unit: "server",
        tag: "server/v0.3.0",
        version: "0.3.0",
        versionLabel: "v0.3.0",
        publishedAt: null,
        commitSha: null,
        components: {},
        releaseNotes: null,
        source: "package-manifest",
      },
      serverWeb: {
        unit: "server-web",
        tag: "server-web/v0.3.1",
        version: "0.3.1",
        versionLabel: "v0.3.1",
        publishedAt: null,
        commitSha: null,
        components: {},
        releaseNotes: null,
        source: "package-manifest",
      },
    });
    assert.deepEqual(health.versions, { serverVersion: "0.3.0", coreVersion: "0.2.4" });
    assert.equal(health.currentRelease, null);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
