import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const generator = path.join(
  root,
  "skills",
  "steamharness-generator",
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
  it.each(['workflow', 'conversation'])('generates valid %s TypeScript for numeric names and multiline prompts', async projectType => {
    const target = await mkdtemp(path.join(os.tmpdir(), 'steamharness-generator-input-'));
    try {
      await execFileAsync('python3', [generator, '123-start', '--project-type', projectType, '--dir', target,
        '--prompt', 'First line\nSecond "quoted" line with \\path']);
      for (const filename of ['index.ts', 'interface.ts']) {
        const source = await readFile(path.join(target, filename), 'utf8');
        const result = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
        expect(result.diagnostics.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)).toEqual([]);
      }
      expect(JSON.parse(await readFile(path.join(target, 'steamharness.json'), 'utf8')).name).toBe('123-start');
    } finally { await rm(target, { recursive: true, force: true }); }
  });

  it.each(['workflow', 'conversation', 'kanban'].flatMap(projectType => ['configuration.json', '.steamharnessignore'].map(filename => [projectType, filename])))('rejects conflicting %s %s before creating any project files', async (projectType, filename) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'steamharness-generator-conflict-'));
    try {
      const target = path.join(directory, 'existing'); await mkdir(target);
      await writeFile(path.join(target, filename), '{"keep":"user configuration"}\n');
      await expect(execFileAsync('python3', [generator, 'existing', '--dir', target, '--project-type', projectType])).rejects.toThrow();
      expect(await readdir(target)).toEqual([filename]);
      expect(await readFile(path.join(target, filename), 'utf8')).toBe('{"keep":"user configuration"}\n');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === 'win32')('rejects dangling symlinks before creating project files', async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), 'steamharness-generator-symlink-'));
    try {
      await symlink(path.join(target, 'missing'), path.join(target, 'configuration.json'));
      await expect(execFileAsync('python3', [generator, 'existing', '--dir', target])).rejects.toThrow();
      expect(await readdir(target)).toEqual(['configuration.json']);
    } finally { await rm(target, { recursive: true, force: true }); }
  });

  it("generates the current project storage and release contract", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "steamharness-generator-"));
    const target = path.join(temporaryRoot, "generated");
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

    try {
      await execFileAsync("python3", [generator, "storage-contract", "--dir", target]);
      const generated = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
      const outputTypes = await readFile(path.join(target, "interface.ts"), "utf8");
      expect(outputTypes).toContain('display?: OutputDisplay;');
      expect(outputTypes).toContain('placement?: "inline" | "composer-right";');
      expect(outputTypes).toContain('export interface RingContent');

      const project=JSON.parse(await readFile(path.join(target,"steamharness.json"),"utf8"));
      expect(project.defaultEntry).toBe("main");
      expect(project.entries).toEqual([{ entryId: "main", type: "workflow", name: "storage-contract", root: ".", entry: "index.ts", configuration: "configuration.json", databases: [] }]);
      expect(generated).not.toHaveProperty("projectType");
      expect(generated).not.toHaveProperty("release");
      expect(project.projectCard).toEqual({
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
