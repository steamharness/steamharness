import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const generator = path.join(
  root,
  "skills",
  "workflow-generator",
  "scripts",
  "create_workflow.py",
);

/**
 * The version the generator would stamp for a declared dependency: an exact
 * version is used as-is, a `link:../harness` reference resolves to the sibling's
 * own version.
 */
async function siblingVersion(manifest, packageName) {
  const declared = manifest.devDependencies[packageName];
  const local = /^(?:file|link):(\.\.?\/.*)$/u.exec(declared);
  if (local === null) return declared;
  const sibling = JSON.parse(await readFile(path.join(root, local[1], "package.json"), "utf8"));
  expect(sibling.name).toBe(packageName);
  return sibling.version;
}

describe("packaged workflow generator", () => {
  it("generates the current project storage and release contract", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-generator-"));
    const target = path.join(temporaryRoot, "generated");
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

    try {
      await execFileAsync("python3", [generator, "storage-contract", "--dir", target]);
      const generated = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
      const outputTypes = await readFile(path.join(target, "interface.ts"), "utf8");
      expect(outputTypes).toContain('display?: WorkflowOutputDisplay;');
      expect(outputTypes).toContain('placement?: "inline" | "composer-right";');
      expect(outputTypes).toContain('export interface WorkflowRingContent');

      expect(generated.steamHarness.projectInfo).toEqual({
        dataStorage: { mode: "both" },
        relatedProjects: [],
      });
      // Desktop 发布校验要求 steamHarness.release 存在且与 projectInfo 的 alias 集合一致。
      expect(generated.steamHarness.release).toEqual({
        dependencies: {},
      });
      expect(generated.steamHarness.projectCard).toEqual({
        icon: "workflow",
        iconBackgroundColor: "#2563eb",
      });
      // 生成器写出的永远是精确版本。dev 上仓库自己用 `link:../harness` 引用同级仓库，
      // 此时版本由生成器从同级 package.json 解析，所以这里读同一份来源而不是清单
      // 里的字面值；不写死则避免每次 bump 都要改测试。
      expect(generated.devDependencies).toEqual({
        "@steamharness/cli": await siblingVersion(manifest, "@steamharness/cli"),
        "steamharness": await siblingVersion(manifest, "steamharness"),
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
