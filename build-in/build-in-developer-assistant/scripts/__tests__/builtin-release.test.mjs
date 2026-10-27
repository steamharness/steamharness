import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { create as createTar, list as listTar } from "tar";
import {
  assembleRelease,
  channelProjectPath,
  buildReleaseArtifacts,
  normalizeArchivePath,
  normalizeChannel,
  readBuiltinDefinition,
  requiredTargets,
  resolveSpawnInvocation,
  shouldPackEntry,
  verifyBuiltinProject,
  verifyDistribution,
} from "../builtin-release.mjs";
import { resolveVersionReference } from "../release-gate.mjs";
import { prepareRelease } from "../prepare-release.mjs";
import { resolveSiblingWorkspaceRoot } from "../prepare-local-siblings.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const commit = "7316652cf77bcbf766084839971208f3399aecc9";
const ossConfig = {
  accessKeyId: "test-id",
  accessKeySecret: "test-secret",
  bucket: "steamharness",
  region: "oss-cn-beijing",
  prefix: "",
  downloadBaseUrl: "https://wfdownload.example.com",
  updatesBaseUrl: "https://wfupdates.example.com",
  multipartThreshold: 4,
  partSize: 4,
  parallel: 2,
};

;

describe("independent built-in project release", () => {
  it("derives the release identity and required resources from package.json", async () => {
    // The checkout's branch decides the release mode, and this repository is
    // developed from main as well as dev, so the mode under test is explicit.
    const definition = await verifyBuiltinProject({ root, mode: 'dev' });
    expect(definition.tag).toBe(`builtin-${definition.projectId}/v${definition.version}`);
    // 组件版本来自 devDependencies 的精确声明，不写死避免每次 Core/CLI bump 都要改测试。
    // On dev the components come from the sibling checkouts; on a release
    // branch the manifest pins published versions and the siblings are not
    // part of the checkout. Resolve them the way the release definition does
    // instead of assuming either shape — this test runs in the tag pipeline.
    const mode = 'dev';
    const resolved = {};
    for (const [key, packageName] of [["harness", "steamharness"], ["cli", "@steamharness/cli"]]) {
      const reference = await resolveVersionReference(definition.packageJson, packageName, {
        mode, repoRoot: root, workspaceRoot: resolveSiblingWorkspaceRoot(root, definition.packageJson),
      });
      resolved[key] = reference.version;
    }
    expect(definition.components).toEqual(resolved);
    expect(definition.minDesktopVersion).toBe("0.1.24");
    expect(definition.dataStorageMode).toBe("local");
    expect(definition.packageJson.steamHarness.projectInfo).toMatchObject({
      localizedNames: {
        "zh-CN": expect.any(String),
        en: definition.packageJson.name,
      },
      declarations: expect.arrayContaining(["multilingual"]),
      dataStorage: { mode: "local" },
    });
    await expect(Promise.all([
      readFile(path.join(root, "README.md"), "utf8"),
      readFile(path.join(root, "README.en.md"), "utf8"),
    ])).resolves.toEqual([expect.stringMatching(/\S/u), expect.stringMatching(/\S/u)]);
    expect(requiredTargets(definition)).toEqual(
      definition.artifactKind === "universal"
        ? [["all", "all"]]
        : [["darwin", "arm64"], ["darwin", "x64"], ["win32", "x64"]],
    );
  });

  it("starts pnpm through Corepack with Windows-safe path handling", () => {
    expect(resolveSpawnInvocation("corepack", ["pnpm", "install"], {
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      comSpec: "C:\\Windows\\System32\\cmd.exe",
    })).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "call",
        "C:\\Program Files\\nodejs\\corepack.cmd",
        "pnpm",
        "install",
      ],
    });
  });

  it("accepts an archive root entry without allowing path traversal", () => {
    expect(normalizeArchivePath("./")).toBe(".");
    expect(normalizeArchivePath("./payload.txt")).toBe("payload.txt");
    expect(normalizeArchivePath("../escape.txt")).toBeUndefined();
    expect(normalizeArchivePath("/escape.txt")).toBeUndefined();
    expect(normalizeArchivePath("C:\\escape.txt")).toBeUndefined();
  });

;

  it("assembles a schema v2 Desktop-compatible index with immutable resource hashes", async () => {
    const definition = await readBuiltinDefinition(root, { mode: 'dev' });
    const temporary = await mkdtemp(path.join(os.tmpdir(), `builtin-${definition.projectId}-release-`));
    const mac = path.join(temporary, "mac");
    const windows = path.join(temporary, "windows");
    await createRunnerArtifacts(definition, mac, "mac");
    if (definition.artifactKind === "native") await createRunnerArtifacts(definition, windows, "windows");
    const outputDir = path.join(temporary, "distribution");
    await assembleRelease({
      root,
      mode: 'dev',
      tag: definition.tag,
      commit,
      publishedAt: "2026-08-12T00:00:00.000Z",
      macArtifactsDir: mac,
      windowsArtifactsDir: definition.artifactKind === "native" ? windows : undefined,
      outputDir,
    });
    const verified = await verifyDistribution({ root, resourcesRoot: outputDir, mode: 'dev' });
    expect(verified.index).toMatchObject({
      schemaVersion: 2,
      id: definition.projectId,
      releases: [{
        version: definition.version,
        tag: definition.tag,
        commitSha: commit,
        minDesktopVersion: definition.minDesktopVersion,
        components: definition.components,
        dependencies: definition.dependencies,
      }],
    });
    expect(verified.release.resources).toHaveLength(requiredTargets(definition).length);
    for (const resource of verified.release.resources) {
      expect(resource.url).toBe(`v${definition.version}/${archiveName(definition, resource.platform, resource.arch)}?sha256=${resource.sha256}`);
      expect(resource.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const indexPath = path.join(outputDir, definition.projectId, "index.json");
    const legacyIndex = JSON.parse(await readFile(indexPath, "utf8"));
    delete legacyIndex.releases[0].components;
    await writeFile(indexPath, `${JSON.stringify(legacyIndex, null, 2)}\n`, "utf8");
    await expect(verifyDistribution({ root, resourcesRoot: outputDir, mode: 'dev' })).resolves.toBeDefined();
    legacyIndex.releases[0].minAppVersion = definition.minDesktopVersion;
    await writeFile(indexPath, `${JSON.stringify(legacyIndex, null, 2)}\n`, "utf8");
    await expect(verifyDistribution({ root, resourcesRoot: outputDir, mode: 'dev' }))
      .rejects.toThrow(/minAppVersion is not supported/);
  });

  it("rejects the removed minAppVersion release field", async () => {
    const definition = await readBuiltinDefinition(root, { mode: 'dev' });
    const fixture = await mkdtemp(path.join(os.tmpdir(), `builtin-${definition.projectId}-legacy-desktop-field-`));
    const manifest = releaseManifest(definition);
    manifest.steamHarness.builtinRelease.minAppVersion = definition.minDesktopVersion;
    await writeFile(path.join(fixture, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await expect(readBuiltinDefinition(fixture)).rejects.toThrow(/minAppVersion is not supported/);
  });

  it("rejects ranged Core or CLI component dependencies", async () => {
    const definition = await readBuiltinDefinition(root, { mode: 'dev' });
    const fixture = await mkdtemp(path.join(os.tmpdir(), `builtin-${definition.projectId}-runtime-components-`));
    const manifest = releaseManifest(definition);
    manifest.devDependencies["steamharness"] = "^0.1.0";
    await writeFile(path.join(fixture, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await expect(readBuiltinDefinition(fixture)).rejects.toThrow(
      /devDependencies\.steamharness "\^0\.1\.0" must be an exact SemVer version/,
    );

    manifest.devDependencies["steamharness"] = definition.components.harness;
    manifest.devDependencies["@steamharness/cli"] = "workspace:*";
    await writeFile(path.join(fixture, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await expect(readBuiltinDefinition(fixture)).rejects.toThrow(
      /devDependencies\.@steamharness\/cli "workspace:\*" must be an exact SemVer version/,
    );
  });

  it("resolves harness and CLI components from the nested monorepo layout", async () => {
    const definition = await readBuiltinDefinition(root, { mode: 'dev' });
    const workspace = await mkdtemp(path.join(os.tmpdir(), "builtin-nested-components-"));
    try {
      const fixture = path.join(workspace, "build-in", "build-in-project");
      await mkdir(fixture, { recursive: true });
      for (const [name, version] of Object.entries(definition.components)) {
        await mkdir(path.join(workspace, name));
        await writeFile(path.join(workspace, name, "package.json"), JSON.stringify({
          name: name === "harness" ? "steamharness" : "@steamharness/cli", version,
        }));
      }
      const manifest = structuredClone(definition.packageJson);
      manifest.devDependencies["steamharness"] = "link:../../harness";
      manifest.devDependencies["@steamharness/cli"] = "link:../../cli";
      await writeFile(path.join(fixture, "package.json"), JSON.stringify(manifest));
      expect((await readBuiltinDefinition(fixture, { mode: "dev" })).components).toEqual(definition.components);
      await expect(readBuiltinDefinition(fixture, { mode: "main" })).rejects.toThrow(/must declare an exact published version/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("refuses a sibling reference once the repository is on a release channel", async () => {
    const definition = await readBuiltinDefinition(root, { mode: 'dev' });
    const fixture = await mkdtemp(path.join(os.tmpdir(), `builtin-${definition.projectId}-release-reference-`));
    const manifest = structuredClone(definition.packageJson);
    manifest.devDependencies["steamharness"] = "link:../../harness";
    await writeFile(path.join(fixture, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await expect(readBuiltinDefinition(fixture, { mode: "main" })).rejects.toThrow(
      /must declare an exact published version on main and alpha/,
    );
  });

  it("requires an explicit storage declaration and the 0.2 Desktop floor", async () => {
    const definition = await readBuiltinDefinition(root, { mode: 'dev' });
    const fixture = await mkdtemp(path.join(os.tmpdir(), `builtin-${definition.projectId}-storage-contract-`));
    const manifest = releaseManifest(definition);
    delete manifest.steamHarness.projectInfo.dataStorage;
    await writeFile(path.join(fixture, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await expect(readBuiltinDefinition(fixture)).rejects.toThrow(/dataStorage\.mode/);

    manifest.steamHarness.projectInfo.dataStorage = { mode: "both" };
    manifest.steamHarness.builtinRelease.minDesktopVersion = "0.1.21";
    // Desktop 地板只对 0.2.x 的 harness 生效，所以显式声明一个 0.2 版本的依赖。
    manifest.devDependencies["steamharness"] = "0.2.0";
    await writeFile(path.join(fixture, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await expect(readBuiltinDefinition(fixture)).rejects.toThrow(/require minDesktopVersion 0\.1\.22/);

    // 0.1.x 的 harness 不受该地板约束，同样的 minDesktopVersion 会被放行。
    manifest.devDependencies["steamharness"] = "0.1.0";
    await writeFile(path.join(fixture, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await expect(readBuiltinDefinition(fixture)).resolves.toMatchObject({ minDesktopVersion: "0.1.21" });
  });

  it("keeps the two channels' paths and tags apart", async () => {
    const stable = await readBuiltinDefinition(root, { mode: 'dev' });
    const alpha = await readBuiltinDefinition(root, { channel: "alpha", mode: "dev" });

    expect(stable.tag).toBe(`builtin-${stable.projectId}/v${stable.version}`);
    expect(alpha.tag).toBe(`builtin-${alpha.projectId}/alpha/v${alpha.version}`);
    expect(channelProjectPath(stable)).toBe(stable.projectId);
    expect(channelProjectPath(alpha)).toBe(`${alpha.projectId}/alpha`);
    expect(normalizeChannel(undefined)).toBe("stable");
    expect(() => normalizeChannel("beta")).toThrow(/must be stable or alpha/);
  });

  it("assembles the Alpha channel under its own segment, leaving the stable path empty", async () => {
    const alpha = await readBuiltinDefinition(root, { channel: "alpha", mode: "dev" });
    const temporary = await mkdtemp(path.join(os.tmpdir(), `builtin-${alpha.projectId}-alpha-release-`));
    const mac = path.join(temporary, "mac");
    const windows = path.join(temporary, "windows");
    await createRunnerArtifacts(alpha, mac, "mac");
    if (alpha.artifactKind === "native") await createRunnerArtifacts(alpha, windows, "windows");
    const outputDir = path.join(temporary, "distribution");
    await assembleRelease({
      root,
      mode: 'dev',
      channel: "alpha",
      tag: alpha.tag,
      commit,
      publishedAt: "2026-08-12T00:00:00.000Z",
      macArtifactsDir: mac,
      windowsArtifactsDir: alpha.artifactKind === "native" ? windows : undefined,
      outputDir,
    });

    const verified = await verifyDistribution({ root, channel: "alpha", resourcesRoot: outputDir, mode: 'dev' });
    expect(verified.release.tag).toBe(`builtin-${alpha.projectId}/alpha/v${alpha.version}`);
    // Everything, index and archives alike, sits under the channel segment: the
    // index's relative resource URLs resolve there and the two channels cannot
    // collide on a version number.
    const channelRoot = path.join(outputDir, alpha.projectId, "alpha");
    expect(await exists(path.join(channelRoot, "index.json"))).toBe(true);
    expect(await exists(path.join(outputDir, alpha.projectId, "index.json"))).toBe(false);
    for (const resource of verified.release.resources) {
      expect(resource.url).toBe(`v${alpha.version}/${archiveName(alpha, resource.platform, resource.arch)}?sha256=${resource.sha256}`);
      expect(await exists(path.join(channelRoot, resource.url.split("?", 1)[0]))).toBe(true);
    }
    // The stable reader must not be able to resolve a distribution built for
    // the Alpha channel.
    await expect(verifyDistribution({ root, resourcesRoot: outputDir, mode: 'dev' })).rejects.toThrow();
  });

  it("prepares a higher version transactionally in an isolated fixture", async () => {
    const definition = await readBuiltinDefinition(root, { mode: 'dev' });
    const fixture = await mkdtemp(path.join(os.tmpdir(), `builtin-${definition.projectId}-prepare-`));
    const manifest = releaseManifest(definition);
    await Promise.all([
      writeFile(path.join(fixture, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
      writeFile(path.join(fixture, "CHANGELOG.md"), `# Changelog\n\n## ${definition.version} - 2026-08-01\n\n### 修复\n\n- 修复 现有版本。\n`, "utf8"),
      writeFile(path.join(fixture, "CHANGELOG.en.md"), `# Changelog\n\n## ${definition.version} - 2026-08-01\n\n### Fixed\n\n- Fixed Existing release.\n`, "utf8"),
      writeFile(path.join(fixture, "CHANGELOG.next.md"), "# Unreleased\n\n### 新增\n\n- 新增 独立发布。\n", "utf8"),
      writeFile(path.join(fixture, "CHANGELOG.next.en.md"), "# Unreleased\n\n### Added\n\n- Added Independent release.\n", "utf8"),
    ]);
    const nextVersion = incrementPatch(definition.version);
    await expect(prepareRelease({ root: fixture, version: nextVersion, date: "2026-08-12" }))
      .resolves.toEqual({
        projectId: definition.projectId,
        version: nextVersion,
        channel: "stable",
        tag: `builtin-${definition.projectId}/v${nextVersion}`,
      });
    expect(JSON.parse(await readFile(path.join(fixture, "package.json"), "utf8")).version).toBe(nextVersion);
    expect(await readFile(path.join(fixture, "CHANGELOG.next.md"), "utf8")).toBe("# Unreleased\n");
  });
  it("names the Alpha channel's tag when asked for it", async () => {
    const definition = await readBuiltinDefinition(root, { mode: 'dev' });
    const fixture = await mkdtemp(path.join(os.tmpdir(), `builtin-${definition.projectId}-prepare-alpha-`));
    const manifest = releaseManifest(definition);
    await Promise.all([
      writeFile(path.join(fixture, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
      writeFile(path.join(fixture, "CHANGELOG.md"), `# Changelog\n\n## ${definition.version} - 2026-08-01\n\n### 修复\n\n- 修复 现有版本。\n`, "utf8"),
      writeFile(path.join(fixture, "CHANGELOG.en.md"), `# Changelog\n\n## ${definition.version} - 2026-08-01\n\n### Fixed\n\n- Fixed Existing release.\n`, "utf8"),
      writeFile(path.join(fixture, "CHANGELOG.next.md"), "# Unreleased\n\n### 新增\n\n- 新增 Alpha 通道发布。\n", "utf8"),
      writeFile(path.join(fixture, "CHANGELOG.next.en.md"), "# Unreleased\n\n### Added\n\n- Added Alpha channel release.\n", "utf8"),
    ]);
    const nextVersion = incrementPatch(definition.version);
    const prepared = await prepareRelease({
      root: fixture,
      version: nextVersion,
      channel: "alpha",
      date: "2026-08-12",
    });
    // The same project version publishes from both channels, so the Alpha tag
    // needs its own namespace; a git tag name cannot be reused.
    expect(prepared).toMatchObject({
      version: nextVersion,
      channel: "alpha",
      tag: `builtin-${definition.projectId}/alpha/v${nextVersion}`,
    });
    await expect(prepareRelease({ root: fixture, version: nextVersion, channel: "beta" }))
      .rejects.toThrow(/must be stable or alpha/);
  });

  it("keeps the runtime skill payload while dropping repository infrastructure", async () => {
    const definition = await readBuiltinDefinition(root, { mode: 'dev' });
    const skillRoot = "skills/workflow-generator";

    // 规则层：仓库根的 scripts/__tests__ 必须排除，skill 自己的 scripts/ 必须保留。
    expect(shouldPackEntry(root, path.join(root, "scripts"))).toBe(false);
    expect(shouldPackEntry(root, path.join(root, "package.json"))).toBe(true);
    expect(shouldPackEntry(root, path.join(root, "__tests__"))).toBe(false);
    expect(shouldPackEntry(root, path.join(root, skillRoot, "scripts", "create_workflow.py"))).toBe(true);
    expect(shouldPackEntry(root, path.join(root, skillRoot, "__tests__"))).toBe(false);
    expect(shouldPackEntry(root, path.join(root, skillRoot, "assets", "kanban", "default", "tests", "board-state.test.mjs"))).toBe(true);

    // 端到端：真正打包一次，确认制品里带着运行时需要的 skill 文件。
    const outputDir = await mkdtemp(path.join(os.tmpdir(), `builtin-${definition.projectId}-pack-`));
    try {
      const { runnerManifest } = await buildReleaseArtifacts({
        root,
        mode: 'dev',
        tag: definition.tag,
        commit,
        targetGroup: "mac",
        outputDir,
      });
      const archiveNames = new Set();
      for (const resource of runnerManifest.resources) {
        await listTar({
          file: path.join(outputDir, definition.projectId, `v${definition.version}`, resource.filename),
          onReadEntry: (entry) => archiveNames.add(normalizeArchivePath(entry.path)),
        });
      }
      for (const required of [
        `${skillRoot}/SKILL.md`,
        `${skillRoot}/references/steamharness-api.md`,
        `${skillRoot}/references/project-repair.md`,
        `${skillRoot}/scripts/create_workflow.py`,
        `${skillRoot}/agents/openai.yaml`,
      ]) {
        expect(archiveNames.has(required)).toBe(true);
      }
      expect([...archiveNames].some((name) => name.startsWith("scripts/"))).toBe(false);
      expect([...archiveNames].some((name) => name.startsWith("__tests__/"))).toBe(false);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

async function exists(filePath) {
  return Boolean(await stat(filePath).catch(() => undefined));
}

/**
 * Fixtures simulate a release checkout. The repository itself declares the
 * sibling checkouts through `link:../harness` on dev, and a release manifest never
 * carries a relative reference, so pin the resolved component versions.
 */
function releaseManifest(definition) {
  const manifest = structuredClone(definition.packageJson);
  const versions = {
    "steamharness": definition.components.harness,
    "@steamharness/cli": definition.components.cli,
  };
  for (const [name, version] of Object.entries(versions)) {
    if (/^(?:file|link):/.test(String(manifest.devDependencies?.[name] ?? ""))) {
      manifest.devDependencies[name] = version;
    }
  }
  return manifest;
}

async function createRunnerArtifacts(definition, directory, targetGroup) {
  const targets = requiredTargets(definition).filter(([platform]) => (
    definition.artifactKind === "universal" || (targetGroup === "mac" ? platform === "darwin" : platform === "win32")
  ));
  const resources = [];
  for (const [platform, arch] of targets) {
    const source = path.join(directory, `.source-${platform}-${arch}`);
    const filename = archiveName(definition, platform, arch);
    const archive = path.join(directory, definition.projectId, `v${definition.version}`, filename);
    await mkdir(path.dirname(archive), { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "payload.txt"), `${platform}-${arch}\n`, "utf8");
    await createTar({ cwd: source, file: archive, gzip: true, portable: true }, ["."]);
    const data = await readFile(archive);
    resources.push({
      platform,
      arch,
      filename,
      size: (await stat(archive)).size,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
  await writeFile(path.join(directory, "runner-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    unit: definition.unit,
    projectId: definition.projectId,
    targetGroup,
    version: definition.version,
    commit,
    resources,
  }, null, 2)}\n`, "utf8");
}

function archiveName(definition, platform, arch) {
  return definition.artifactKind === "universal"
    ? `${definition.projectId}-universal.tgz`
    : `${definition.projectId}-${platform}-${arch}.tgz`;
}

function incrementPatch(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

class FakeOssClient {
  objects = new Map();
  putOrder = [];

  async put(key, input, options = {}) {
    const body = Buffer.isBuffer(input) ? input : await readFile(input);
    this.objects.set(key, {
      body: Buffer.from(body),
      headers: lowerCaseHeaders(options.headers ?? {}),
      meta: { ...(options.meta ?? {}) },
    });
    this.putOrder.push(key);
    return { res: { headers: {} } };
  }

  async multipartUpload(key, input, options = {}) {
    await options.progress?.(0.5);
    return this.put(key, input, options);
  }

  async head(key) {
    const object = this.objects.get(key);
    if (!object) throw notFound();
    return {
      meta: object.meta,
      res: { headers: { ...object.headers, "content-length": String(object.body.length) } },
    };
  }

  async get(key) {
    const object = this.objects.get(key);
    if (!object) throw notFound();
    return { content: Buffer.from(object.body), res: { headers: object.headers } };
  }

  async listV2(query) {
    return {
      objects: [...this.objects.entries()]
        .filter(([key]) => key.startsWith(query.prefix))
        .map(([name, object]) => ({ name, size: object.body.length })),
      isTruncated: false,
    };
  }

  async deleteMulti(keys) {
    for (const key of keys) this.objects.delete(key);
    return { deleted: keys };
  }
}

function lowerCaseHeaders(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.toLowerCase(), String(item)]));
}

function notFound() {
  return Object.assign(new Error("not found"), { status: 404, code: "NoSuchKey" });
}
