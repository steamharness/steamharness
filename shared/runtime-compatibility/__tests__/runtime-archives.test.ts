import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { create } from "tar";
import { afterEach, expect, it } from "vitest";
import { BUNDLED_PROJECT_RUNTIME_FILES } from "../index";
import { readBundledProjectRuntime } from "../node";

const [core, cli] = BUNDLED_PROJECT_RUNTIME_FILES;
const manifest = { devDependencies: { steamharness: `file:./${core}`, "@steamharness/cli": `file:./${cli}` } };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-archives-"));
  roots.push(root);
  const project = path.join(root, "project");
  await mkdir(path.join(project, path.dirname(core)), { recursive: true });
  await mkdir(path.join(root, "package"));
  const pack = async (file: string, pkg: unknown) => {
    await writeFile(path.join(root, "package/package.json"), JSON.stringify(pkg));
    await create({ cwd: root, file: path.join(project, file), gzip: true }, ["package"]);
  };
  await pack(core, { name: "steamharness", version: "0.2.6" });
  await pack(cli, { name: "@steamharness/cli", version: "0.2.6", steamharnessProjectRuntime: "archive-manifest" });
  return { project, pack };
}

it("reads the exact pair before installation and ignores a stale legacy declaration", async () => {
  const { project, pack } = await fixture();
  const result = { version: "0.2.6", cliReadsArchiveManifest: true };
  await expect(readBundledProjectRuntime(project, manifest)).resolves.toEqual(result);
  await expect(readBundledProjectRuntime(project, { ...manifest, steamharnessRuntime: { version: "0.1.0" } })).resolves.toEqual(result);
  await pack(cli, { name: "@steamharness/cli", version: "0.2.6" });
  await expect(readBundledProjectRuntime(project, manifest)).resolves.toEqual({ ...result, cliReadsArchiveManifest: false });
});

it("rejects mismatched, misnamed and missing archives even with legacy metadata present", async () => {
  const { project, pack } = await fixture();
  const legacy = { ...manifest, steamharnessRuntime: { version: "0.2.6" } };
  await pack(cli, { name: "@steamharness/cli", version: "0.2.5" });
  await expect(readBundledProjectRuntime(project, legacy)).rejects.toThrow(/versions do not match/);
  await pack(cli, { name: "other", version: "0.2.6" });
  await expect(readBundledProjectRuntime(project, legacy)).rejects.toThrow(/steamharness-cli\.tgz/);
  await rm(path.join(project, cli));
  await expect(readBundledProjectRuntime(project, legacy)).rejects.toThrow(/steamharness-cli\.tgz/);
});

it("rejects symlinked archive directories instead of reading packages outside the project", async () => {
  const { project } = await fixture();
  const directory = path.join(project, path.dirname(core)), external = path.join(path.dirname(project), "external");
  await rename(directory, external);
  await symlink(external, directory, process.platform === "win32" ? "junction" : "dir");
  await expect(readBundledProjectRuntime(project, manifest)).rejects.toThrow(/runtime package version/);
});
