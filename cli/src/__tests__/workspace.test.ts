import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "@steamharness/i18n";
import { ensureWorkflowProjectCreated, decodeWorkflowFileContent, findLocalWorkflowDependencies, formatForbiddenMessage, materializeProjectGroupDownload, normalizeWorkflowFilePath, packWorkflow, packProjectGroup, readProjectGroupContexts, getPreparation, main, parseArgs, readWorkflowPackageContext, resolveRepoRoot, stageWorkflowWithLocalDependencies, waitForDeviceToken, waitForProjectGroupPreparation, waitForPreparation } from "../workspace";

const VALID_STEAMHARNESS_SOURCE = [
  "export const mainWorkflow = workflow.defineWorkflow({",
  "  name: \"main\",",
  "  async run(input) { return input; },",
  "});",
  "export const executor = workflow.defineExecutor({",
  "  projectType: \"workflow\",",
  "  defaultEntrypoint: \"main\",",
  "  entrypoints: [workflow.defineEntrypoint({",
  "    id: \"main\", title: \"Main\", workflow: mainWorkflow,",
  "    createInput() { return { errCode: 0, errMessage: \"\" }; },",
  "  })],",
  "});",
  "export { mainWorkflow as workflow };",
  "export default mainWorkflow;",
  "",
].join("\n");

describe("server workspace CLI helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initI18n({ preference: "en" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    // Reset the shared i18n singleton so other tests are unaffected by the
    // forbidden-message locale assertions.
    initI18n({ preference: "zh-CN" });
  });

  it("parses source download options without an execution target", () => {
    expect(parseArgs([
      "download",
      "hello",
      "--server",
      "http://localhost:7125",
      "--token",
      "secret",
      "--target",
      "draft",
      "--path",
      "./download",
    ])).toMatchObject({
      command: "download",
      positional: ["hello"],
      options: {
        server: "http://localhost:7125",
        token: "secret",
        target: "draft",
        path: "./download",
      },
    });
  });

  it("rejects removed remote execution and release options", () => {
    for (const option of ["--entrypoint", "--execution-target", "--source-mode", "--platform", "--retain-source"]) {
      expect(() => parseArgs(["upload", "hello", option, "value"]))
        .toThrow(`Unknown workspace option: ${option}`);
    }
  });

  it("writes exact package versions into project-group manifests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-group-version-"));
    const rootDir = path.join(root, "root");
    const dependencyDir = path.join(root, "dependency");
    const rootId = "8bd4fef2-e083-4201-a89f-6f7d0676df71";
    const dependencyId = "9bd4fef2-e083-4201-a89f-6f7d0676df72";
    await mkdir(path.join(rootDir, "dist", "pages"), { recursive: true });
    await mkdir(dependencyDir, { recursive: true });
    await writeFile(path.join(rootDir, "package.json"), JSON.stringify({
      id: rootId,
      name: "Board",
      version: "0.1.2",
      steamHarness: {
        projectType: "kanban",
        projectInfo: {
          relatedProjects: [{ alias: "worker", projectId: dependencyId }],
        },
        kanban: { artifactDir: "dist", entry: "pages/index.htm" },
      },
    }));
    await writeFile(path.join(rootDir, "index.ts"), "export default {};");
    await writeFile(path.join(rootDir, "dist", "pages", "index.htm"), "<!doctype html><title>Board</title>");
    await writeFile(path.join(dependencyDir, "package.json"), JSON.stringify({
      id: dependencyId,
      name: "Worker",
      version: "0.3.0",
      steamHarness: { projectType: "workflow" },
    }));
    await writeFile(path.join(dependencyDir, "index.ts"), VALID_STEAMHARNESS_SOURCE);

    const packed = await packProjectGroup({
      workflowArg: "root",
      sourcePath: rootDir,
      dependencyOptions: [`worker=${dependencyDir}`],
      contexts: {
        root: await readWorkflowPackageContext("root", rootDir),
        dependencies: [{
          alias: "worker",
          packageContext: await readWorkflowPackageContext("worker", dependencyDir),
        }],
        locks: [{ alias: "worker", projectId: dependencyId, delivery: "included" }],
      },
    });
    expect(packed.manifest.projects.map((project) => project.version)).toEqual(["0.1.2", "0.3.0"]);
    await rm(root, { recursive: true, force: true });
  });

  it("rejects project-group and asynchronous flags when their command cannot honor them", () => {
    expect(() => parseArgs(["download", "hello", "--project-group"]))
      .toThrow("--project-group is only supported by pack, upload, and publish");
    expect(() => parseArgs(["publish", "hello", "--no-wait"]))
      .toThrow("--no-wait is only supported by upload");
    expect(() => parseArgs(["upload", "hello", "--project-group", "--no-wait"]))
      .toThrow("--no-wait is not supported by project-group upload");
    expect(() => parseArgs(["upload", "hello", "--grant-data-access", "stocks"]))
      .toThrow("Unknown workspace option: --grant-data-access");
  });

  it("localizes project-group option errors in both supported languages", () => {
    initI18n({ preference: "zh-CN" });
    expect(() => parseArgs(["download", "hello", "--project-group"]))
      .toThrow("--project-group 仅支持 pack、upload 和 publish 命令");
    expect(() => parseArgs(["upload", "hello", "--project-group", "--no-wait"]))
      .toThrow("项目组上传不支持 --no-wait");

    initI18n({ preference: "en" });
    expect(() => parseArgs(["download", "hello", "--project-group"]))
      .toThrow("--project-group is only supported by pack, upload, and publish");
  });

  it("accepts project-group source paths on publish and rejects deployment option mixing", () => {
    expect(parseArgs([
      "publish",
      "board",
      "--project-group",
      "--path",
      "./board",
      "--dependency",
      "stocks=./stocks",
      "--release-log",
      "publish exact group",
    ])).toMatchObject({
      command: "publish",
      positional: ["board"],
      options: {
        projectGroup: true,
        path: "./board",
        dependencies: ["stocks=./stocks"],
        releaseLog: "publish exact group",
      },
    });

    expect(() => parseArgs([
      "publish",
      "--deployment",
      "00000000-0000-4000-8000-000000000010",
      "--dependency",
      "stocks=./stocks",
    ])).toThrow("--deployment cannot be combined");
    expect(() => parseArgs([
      "publish",
      "--deployment",
      "00000000-0000-4000-8000-000000000010",
      "--release-log",
      "ignored",
    ])).toThrow("--deployment cannot be combined");
  });

  it("builds an included dependency lock from one confirmed related project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-project-group-aliases-"));
    const kanbanDir = path.join(root, "board");
    const workflowDir = path.join(root, "stocks");
    const dependencyProjectId = "8bd4fef2-e083-4201-a89f-6f7d0676df53";
    await mkdir(kanbanDir, { recursive: true });
    await mkdir(workflowDir, { recursive: true });
    await writeFile(path.join(kanbanDir, "package.json"), JSON.stringify({
      id: "7bd4fef2-e083-4201-a89f-6f7d0676df53",
      name: "Stock Board",
      version: "1.0.0",
      steamHarness: {
        projectType: "kanban",
        projectInfo: createProjectInfo("stocks", dependencyProjectId),
        kanban: {},
      },
    }));
    await writeFile(path.join(kanbanDir, "index.html"), "<!doctype html><title>Board</title>\n");
    await writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
      id: dependencyProjectId,
      name: "Stock Database",
      version: "1.0.0",
      steamHarness: {
        projectType: "workflow",
        projectInfo: createProjectInfo("board", "7bd4fef2-e083-4201-a89f-6f7d0676df53"),
      },
    }));
    await writeFile(path.join(workflowDir, "index.ts"), VALID_STEAMHARNESS_SOURCE);
    await writeFile(path.join(workflowDir, "README.md"), "# Stock Database\n");

    try {
      const contexts = await readProjectGroupContexts({
        workflowArg: "board",
        sourcePath: kanbanDir,
        dependencyOptions: [`stocks=${workflowDir}`],
      });
      expect(contexts.dependencies).toHaveLength(1);
      expect(contexts.locks.map((lock) => [lock.alias, lock.delivery])).toEqual([
        ["stocks", "included"],
      ]);
      await writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
        id: dependencyProjectId,
        name: "Stock Database",
        version: "1.0.0",
        steamHarness: {
          projectType: "workflow",
          projectInfo: createProjectInfo(),
        },
      }));
      await expect(readProjectGroupContexts({
        workflowArg: "board",
        sourcePath: kanbanDir,
        dependencyOptions: [`stocks=${workflowDir}`],
      })).rejects.toThrow("not confirmed by both project manifests");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a Kanban project group that references its own project UUID", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-project-group-self-reference-"));
    const projectId = "7bd4fef2-e083-4201-a89f-6f7d0676df53";
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      id: projectId,
      name: "Invalid Board",
      version: "1.0.0",
      steamHarness: {
        projectType: "kanban",
        projectInfo: createProjectInfo("self", projectId),
        kanban: {},
      },
    }));
    await writeFile(path.join(root, "index.html"), "<!doctype html><title>Invalid Board</title>\n");

    try {
      await expect(readProjectGroupContexts({
        workflowArg: "board",
        sourcePath: root,
        dependencyOptions: [],
      })).rejects.toThrow("cannot reference the current project");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("excludes host data while staging a project-group source package", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-project-group-host-data-"));
    const sourceDir = path.join(root, "source", "workflow");
    const stagingRoot = path.join(root, "stage");
    await mkdir(path.join(sourceDir, ".workflow-kv"), { recursive: true });
    await mkdir(path.join(sourceDir, ".workflow-persistent-values"), { recursive: true });
    await mkdir(path.join(sourceDir, ".workflow-schedules"), { recursive: true });
    await writeFile(path.join(sourceDir, "package.json"), JSON.stringify({
      id: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
      name: "Workflow",
      version: "1.0.0",
    }));
    await writeFile(path.join(sourceDir, "index.ts"), VALID_STEAMHARNESS_SOURCE);
    await writeFile(path.join(sourceDir, ".env"), "SECRET=value\n");
    await writeFile(path.join(sourceDir, ".envrc"), "export SECRET=value\n");
    await writeFile(path.join(sourceDir, ".env.example"), "SECRET=\n");
    await writeFile(path.join(sourceDir, "steamharness.sqlite-wal"), "local sqlite state\n");
    await writeFile(path.join(sourceDir, ".workflow-kv", "value.json"), "{}\n");
    await writeFile(path.join(sourceDir, ".workflow-persistent-values", "value.json"), "{}\n");
    await writeFile(path.join(sourceDir, ".workflow-schedules", "schedules.json"), "[]\n");
    await writeFile(path.join(sourceDir, "workflow-auth.json"), "{\"apiKey\":\"secret\"}\n");

    try {
      await stageWorkflowWithLocalDependencies({
        workspaceRoot: path.dirname(sourceDir),
        workflowDir: sourceDir,
        workflowName: "workflow",
        stagingRoot,
        projectGroupSafe: true,
      });
      const staged = path.join(stagingRoot, "workflow");
      expect(existsSync(path.join(staged, "package.json"))).toBe(true);
      expect(existsSync(path.join(staged, ".env.example"))).toBe(true);
      expect(existsSync(path.join(staged, ".env"))).toBe(false);
      expect(existsSync(path.join(staged, ".envrc"))).toBe(false);
      expect(existsSync(path.join(staged, "steamharness.sqlite-wal"))).toBe(false);
      expect(existsSync(path.join(staged, ".workflow-kv"))).toBe(false);
      expect(existsSync(path.join(staged, ".workflow-persistent-values"))).toBe(false);
      expect(existsSync(path.join(staged, ".workflow-schedules"))).toBe(false);
      expect(existsSync(path.join(staged, "workflow-auth.json"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["workflow", "conversation", "kanban"])("downloads published %s projects without executing their source", async (projectType) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-download-type-"));
    const projectId = "7bd4fef2-e083-4201-a89f-6f7d0676df53";
    const targetDir = path.join(root, "project");
    const source = "throw new Error('Downloaded source must not execute');\n";
    try {
      const materialized = await materializeProjectGroupDownload(finalizeProjectGroupDownloadFixture({
        rootProjectId: projectId,
        rootVersion: "1.2.3",
        dependencies: [],
        complete: true,
        copyAllowed: true,
        skippedDependencies: [],
        projects: [{
          projectId,
          projectName: "Project",
          version: "1.2.3",
          sourceHash: "",
          role: "root",
          files: [{
            path: "package.json",
            content: JSON.stringify({ id: projectId, name: "Project", version: "1.2.3", steamHarness: { projectType } }),
          }, { path: "index.ts", content: source }],
        }],
      }), targetDir);
      expect(materialized).toEqual([expect.objectContaining({ projectId, role: "root", path: targetDir, alreadyAvailable: false })]);
      expect(readFileSync(path.join(targetDir, "index.ts"), "utf8")).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["workflow", "conversation", "kanban"])("downloads %s source with unconfirmed related-project declarations", async (projectType) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-download-pending-"));
    const projectId = "7bd4fef2-e083-4201-a89f-6f7d0676df53";
    const pendingProjectId = "8bd4fef2-e083-4201-a89f-6f7d0676df53";
    const targetDir = path.join(root, "project");
    const packageJson = { ...createKanbanPackage(projectId, "Project"), version: "1.0.0",
      steamHarness: { projectType, projectInfo: createProjectInfo("pending", pendingProjectId) } };
    const download = finalizeProjectGroupDownloadFixture({
      rootProjectId: projectId, rootVersion: "1.0.0", dependencies: [], complete: true, copyAllowed: true,
      skippedDependencies: [], projects: [{ projectId, projectName: "Project", version: "1.0.0", sourceHash: "", role: "root",
        files: [{ path: "package.json", content: JSON.stringify(packageJson) }] }],
    });
    try {
      const materialized = await materializeProjectGroupDownload(download, targetDir);
      expect(materialized).toHaveLength(1);
      expect(JSON.parse(readFileSync(path.join(targetDir, "package.json"), "utf8"))).toEqual(packageJson);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects dependency locks that are not declared by the root project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-download-undeclared-"));
    const projectId = "7bd4fef2-e083-4201-a89f-6f7d0676df53";
    const dependencyId = "8bd4fef2-e083-4201-a89f-6f7d0676df53";
    const targetDir = path.join(root, "project");
    const download = finalizeProjectGroupDownloadFixture({
      rootProjectId: projectId, rootVersion: "1.0.0",
      dependencies: [{ alias: "undeclared", projectId: dependencyId, delivery: "external" }], complete: true, copyAllowed: true,
      skippedDependencies: [], projects: [{ projectId, projectName: "Project", version: "1.0.0", sourceHash: "", role: "root",
        files: [{ path: "package.json", content: JSON.stringify(createKanbanPackage(projectId, "Project")) }] }],
    });
    try {
      await expect(materializeProjectGroupDownload(download, targetDir)).rejects.toThrow("dependency lock does not match");
      expect(existsSync(targetDir)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps an existing sibling project unchanged when completing a group download", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-project-group-download-"));
    const rootTargetDir = path.join(root, "Stock Board");
    const projectId = "7bd4fef2-e083-4201-a89f-6f7d0676df53";
    const download = finalizeProjectGroupDownloadFixture({
      rootProjectId: projectId,
      rootVersion: "1.0.0",
      dependencies: [],
      complete: true,
      copyAllowed: true,
      skippedDependencies: [],
      projects: [{
        projectId,
        projectName: "Stock Board",
        version: "1.0.0",
        sourceHash: "a".repeat(64),
        role: "root" as const,
        files: [
          { path: "package.json", content: JSON.stringify(createKanbanPackage(projectId, "Stock Board")) },
          { path: "index.html", content: "first" },
        ],
      }],
    });

    try {
      const first = await materializeProjectGroupDownload(download, rootTargetDir);
      expect(first[0]?.alreadyAvailable).toBe(false);
      await writeFile(path.join(rootTargetDir, "index.html"), "local edit");
      const second = await materializeProjectGroupDownload(finalizeProjectGroupDownloadFixture({
        ...download,
        projects: download.projects.map((project) => ({
          ...project,
          files: project.files.map((file) => file.path === "index.html" ? { ...file, content: "server edit" } : file),
        })),
      }), rootTargetDir);
      expect(second[0]?.alreadyAvailable).toBe(true);
      expect(readFileSync(path.join(rootTargetDir, "index.html"), "utf8")).toBe("local edit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reuse a sibling root with the same UUID and a different version", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-download-version-"));
    const projectId = "7bd4fef2-e083-4201-a89f-6f7d0676df53";
    const existingDir = path.join(root, "Project-1.0.0"), targetDir = path.join(root, "Project-2.0.0");
    await mkdir(existingDir);
    await writeFile(path.join(existingDir, "package.json"), JSON.stringify(createKanbanPackage(projectId, "Project")));
    await writeFile(path.join(existingDir, "local.txt"), "keep");
    const download = finalizeProjectGroupDownloadFixture({
      rootProjectId: projectId, rootVersion: "2.0.0", dependencies: [], complete: true, copyAllowed: true,
      skippedDependencies: [], projects: [{ projectId, projectName: "Project", version: "2.0.0", sourceHash: "", role: "root",
        files: [{ path: "package.json", content: JSON.stringify({ ...createKanbanPackage(projectId, "Project"), version: "2.0.0" }) }] }],
    });
    try {
      const materialized = await materializeProjectGroupDownload(download, targetDir);
      expect(materialized).toEqual([expect.objectContaining({ path: targetDir, alreadyAvailable: false })]);
      expect(readFileSync(path.join(existingDir, "local.txt"), "utf8")).toBe("keep");
      const matching = await materializeProjectGroupDownload(download, path.join(root, "another-target"));
      expect(matching).toEqual([expect.objectContaining({ path: targetDir, alreadyAvailable: true })]);
      await expect(materializeProjectGroupDownload(finalizeProjectGroupDownloadFixture({
        ...download, rootVersion: "3.0.0", projects: [{ ...download.projects[0]!, version: "3.0.0",
          files: [{ path: "package.json", content: JSON.stringify({ ...createKanbanPackage(projectId, "Project"), version: "3.0.0" }) }] }],
      }), existingDir)).rejects.toThrow("multiple projects resolve to directory");
      expect(readFileSync(path.join(existingDir, "local.txt"), "utf8")).toBe("keep");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not treat an unavailable pinned dependency as complete using a different local version", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-download-dependency-version-"));
    const projectId = "7bd4fef2-e083-4201-a89f-6f7d0676df53";
    const dependencyId = "8bd4fef2-e083-4201-a89f-6f7d0676df53";
    const existingDir = path.join(root, "Database"), targetDir = path.join(root, "Board");
    await mkdir(existingDir);
    await writeFile(path.join(existingDir, "package.json"), JSON.stringify({
      ...createKanbanPackage(dependencyId, "Database", projectId, "board"), version: "0.4.0",
    }));
    const dependency = createPublishedDependencyLock(dependencyId);
    const download = finalizeProjectGroupDownloadFixture({
      rootProjectId: projectId, rootVersion: "1.0.0", dependencies: [dependency], complete: false, copyAllowed: false,
      skippedDependencies: [{ dependency, reason: "permission_required" as const }],
      projects: [{ projectId, projectName: "Board", version: "1.0.0", sourceHash: "", role: "root",
        files: [{ path: "package.json", content: JSON.stringify(createKanbanPackage(projectId, "Board", dependencyId)) }] }],
    });
    try {
      const materialized = await materializeProjectGroupDownload(download, targetDir);
      expect(materialized.map(project => project.projectId)).toEqual([projectId]);
      expect(JSON.parse(readFileSync(path.join(existingDir, "package.json"), "utf8")).version).toBe("0.4.0");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects project-group files that do not match the server source hash", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-project-group-hash-"));
    const rootTargetDir = path.join(root, "Stock Board");
    const projectId = "7bd4fef2-e083-4201-a89f-6f7d0676df53";
    const download = finalizeProjectGroupDownloadFixture({
      rootProjectId: projectId,
      rootVersion: "1.0.0",
      dependencies: [],
      complete: true,
      copyAllowed: true,
      skippedDependencies: [],
      projects: [{
        projectId,
        projectName: "Stock Board",
        version: "1.0.0",
        sourceHash: "a".repeat(64),
        role: "root" as const,
        files: [
          { path: "package.json", content: JSON.stringify(createKanbanPackage(projectId, "Stock Board")) },
          { path: "index.html", content: "original" },
        ],
      }],
    });

    try {
      await expect(materializeProjectGroupDownload({
        ...download,
        rootVersion: "1.0.1",
      }, rootTargetDir)).rejects.toThrow("root version does not match its download plan");
      download.projects[0]!.files[1]!.content = "tampered";
      await expect(materializeProjectGroupDownload(download, rootTargetDir))
        .rejects.toThrow("source hash does not match its files");
      expect(existsSync(rootTargetDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats an omitted included dependency with the same local UUID as satisfied", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-existing-group-dependency-"));
    const rootTargetDir = path.join(root, "Stock Board");
    const dependencyDir = path.join(root, "Stock Database");
    const rootProjectId = "7bd4fef2-e083-4201-a89f-6f7d0676df58";
    const dependencyProjectId = "8bd4fef2-e083-4201-a89f-6f7d0676df58";
    await mkdir(dependencyDir, { recursive: true });
    await writeFile(path.join(dependencyDir, "package.json"), JSON.stringify({
      id: dependencyProjectId,
      name: "Stock Database",
      version: "0.5.0",
      steamHarness: {
        projectType: "workflow",
        projectInfo: createProjectInfo("board", rootProjectId),
      },
    }));
    await writeFile(path.join(dependencyDir, "index.ts"), VALID_STEAMHARNESS_SOURCE);

    try {
      const materialized = await materializeProjectGroupDownload(finalizeProjectGroupDownloadFixture({
        rootProjectId,
        rootVersion: "1.0.0",
        dependencies: [createPublishedDependencyLock(dependencyProjectId)],
        complete: false,
        copyAllowed: false,
        skippedDependencies: [{
          dependency: createPublishedDependencyLock(dependencyProjectId),
          reason: "permission_required",
          requestUrl: "https://workflow.example/access-requests/token",
        }],
        projects: [{
          projectId: rootProjectId,
          projectName: "Stock Board",
          version: "1.0.0",
          sourceHash: "a".repeat(64),
          role: "root",
          files: [{
            path: "package.json",
            content: JSON.stringify(createKanbanPackage(rootProjectId, "Stock Board", dependencyProjectId)),
          }, {
            path: "index.html",
            content: "<!doctype html><title>Stock Board</title>",
          }],
        }],
      }), rootTargetDir);

      expect(materialized).toEqual(expect.arrayContaining([
        expect.objectContaining({ projectId: rootProjectId, alreadyAvailable: false }),
        expect.objectContaining({
          projectId: dependencyProjectId,
          path: dependencyDir,
          role: "dependency",
          alreadyAvailable: true,
        }),
      ]));
      expect(readFileSync(path.join(dependencyDir, "index.ts"), "utf8")).toBe(VALID_STEAMHARNESS_SOURCE);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts general related project types and rejects portable path collisions before moving files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-invalid-group-role-"));
    const rootTargetDir = path.join(root, "Stock Board");
    const rootProjectId = "7bd4fef2-e083-4201-a89f-6f7d0676df59";
    const dependencyProjectId = "8bd4fef2-e083-4201-a89f-6f7d0676df59";
    const dependencyLock = createPublishedDependencyLock(dependencyProjectId);
    const baseDownload = finalizeProjectGroupDownloadFixture({
      rootProjectId,
      rootVersion: "1.0.0",
      dependencies: [dependencyLock],
      complete: true,
      copyAllowed: true,
      skippedDependencies: [],
      projects: [{
        projectId: rootProjectId,
        projectName: "Stock Board",
        version: "1.0.0",
        sourceHash: "a".repeat(64),
        role: "root" as const,
        files: [{
          path: "package.json",
          content: JSON.stringify(createKanbanPackage(rootProjectId, "Stock Board", dependencyProjectId)),
        }, {
          path: "index.html",
          content: "<!doctype html><title>Stock Board</title>",
        }],
      }, {
        alias: "stocks",
        projectId: dependencyProjectId,
        projectName: "Dependency Kanban",
        version: "0.5.0",
        sourceHash: "b".repeat(64),
        role: "dependency" as const,
        files: [{
          path: "package.json",
          content: JSON.stringify({
            ...createKanbanPackage(dependencyProjectId, "Dependency Kanban", rootProjectId, "board"),
            version: "0.5.0",
          }),
        }, {
          path: "index.html",
          content: "<!doctype html><title>Dependency Kanban</title>",
        }],
      }],
    });

    try {
      const duplicatePathDownload = structuredClone(baseDownload);
      duplicatePathDownload.projects[0]!.files.push({
        path: "INDEX.HTML",
        content: "portable collision",
      });
      await expect(materializeProjectGroupDownload(duplicatePathDownload, rootTargetDir))
        .rejects.toThrow("duplicate file");
      expect(existsSync(rootTargetDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a conflicting target directory without overwriting local files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-project-group-conflict-"));
    const rootTargetDir = path.join(root, "Stock Board");
    const projectId = "7bd4fef2-e083-4201-a89f-6f7d0676df54";
    await mkdir(rootTargetDir, { recursive: true });
    await writeFile(path.join(rootTargetDir, "package.json"), JSON.stringify({
      id: "7bd4fef2-e083-4201-a89f-6f7d0676df55",
      name: "Different Project",
      version: "1.0.0",
    }));
    await writeFile(path.join(rootTargetDir, "local.txt"), "keep me");

    try {
      await expect(materializeProjectGroupDownload(finalizeProjectGroupDownloadFixture({
        rootProjectId: projectId,
        rootVersion: "1.0.0",
        dependencies: [],
        complete: true,
        copyAllowed: true,
        skippedDependencies: [],
        projects: [{
          projectId,
          projectName: "Stock Board",
          version: "1.0.0",
          sourceHash: "a".repeat(64),
          role: "root",
          files: [{
            path: "package.json",
              content: JSON.stringify(createKanbanPackage(projectId, "Stock Board")),
          }],
        }],
      }), rootTargetDir)).rejects.toThrow(/already exists with a different project id/);
      expect(readFileSync(path.join(rootTargetDir, "local.txt"), "utf8")).toBe("keep me");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not materialize any project when one staged package fails identity validation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-project-group-atomic-"));
    const rootTargetDir = path.join(root, "Stock Board");
    const dependencyTargetDir = path.join(root, "Stock Database");
    const rootProjectId = "7bd4fef2-e083-4201-a89f-6f7d0676df56";
    const dependencyProjectId = "8bd4fef2-e083-4201-a89f-6f7d0676df56";

    try {
      await expect(materializeProjectGroupDownload(finalizeProjectGroupDownloadFixture({
        rootProjectId,
        rootVersion: "1.0.0",
        dependencies: [createPublishedDependencyLock(dependencyProjectId)],
        complete: true,
        copyAllowed: true,
        skippedDependencies: [],
        projects: [
          {
            projectId: rootProjectId,
            projectName: "Stock Board",
            version: "1.0.0",
            sourceHash: "a".repeat(64),
            role: "root",
            files: [{
              path: "package.json",
              content: JSON.stringify(createKanbanPackage(
                rootProjectId,
                "Stock Board",
                dependencyProjectId,
              )),
            }, {
              path: "index.html",
              content: "<!doctype html><title>Stock Board</title>",
            }],
          },
          {
            alias: "stocks",
            projectId: dependencyProjectId,
            projectName: "Stock Database",
            version: "0.5.0",
            sourceHash: "b".repeat(64),
            role: "dependency",
            files: [{
              path: "package.json",
              content: JSON.stringify({ id: rootProjectId, name: "Wrong Project", version: "0.5.0" }),
            }],
          },
        ],
      }), rootTargetDir)).rejects.toThrow(/package id does not match/);
      expect(existsSync(rootTargetDir)).toBe(false);
      expect(existsSync(dependencyTargetDir)).toBe(false);
      expect((await readdir(root)).some((name) => name.startsWith(".workflow-download-group-"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects host data returned by a project-group download before writing files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-project-group-host-download-"));
    const rootTargetDir = path.join(root, "Stock Board");
    const projectId = "7bd4fef2-e083-4201-a89f-6f7d0676df57";

    try {
      for (const forbiddenPath of [
        ".env",
        ".workflow-kv/value.json",
        ".workflow-persistent-values/value.json",
        ".workflow-schedules/schedules.json",
        ".workflow-runs/history.json",
        "steamharness.sqlite",
        "workflow-auth.json",
      ]) {
        await expect(materializeProjectGroupDownload(finalizeProjectGroupDownloadFixture({
          rootProjectId: projectId,
          rootVersion: "1.0.0",
          dependencies: [],
          complete: true,
          copyAllowed: true,
          skippedDependencies: [],
          projects: [{
            projectId,
            projectName: "Stock Board",
            version: "1.0.0",
            sourceHash: "a".repeat(64),
            role: "root",
            files: [
              {
                path: "package.json",
                content: JSON.stringify(createKanbanPackage(projectId, "Stock Board")),
              },
              { path: forbiddenPath, content: "host data" },
            ],
          }],
        }), rootTargetDir)).rejects.toThrow(/forbidden host data/);
        expect(existsSync(rootTargetDir)).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("polls preparation jobs until the server returns the upload result", async () => {
    const jobId = "a0000000-0000-4000-8000-000000000030";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createJsonResponse({
        errCode: 0,
        errMessage: "",
        data: {
          jobId,
          workflowId: "demo",
          archiveName: "demo.tgz",
          createOnly: false,
          status: "preparing",
          stage: "bundling",
          createdAt: "2026-07-16T00:00:00.000Z",
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        errCode: 0,
        errMessage: "",
        data: {
          jobId,
          workflowId: "demo",
          archiveName: "demo.tgz",
          createOnly: false,
          status: "success",
          stage: "committing",
          createdAt: "2026-07-16T00:00:00.000Z",
          result: { workflowId: "demo", sourceHash: "hash" },
        },
      }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await waitForPreparation({
      workflowId: "demo",
      jobId,
      server: "http://localhost:7125",
      token: "token",
      pollIntervalMs: 0,
    });

    expect(result).toEqual({
      errCode: 0,
      errMessage: "",
      data: { workflowId: "demo", sourceHash: "hash" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("polls project-group deployments until preparation completes", async () => {
    const deploymentId = "a0000000-0000-4000-8000-000000000032";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createJsonResponse({
        errCode: 0,
        errMessage: "",
        data: {
          id: deploymentId,
          rootProjectId: "demo",
          status: "preparing",
          manifest: { version: 1, rootProjectId: "demo", projects: [], dependencies: [] },
          items: [{ projectId: "demo", status: "preparing", stage: "bundling" }],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        errCode: 0,
        errMessage: "",
        data: {
          id: deploymentId,
          rootProjectId: "demo",
          status: "prepared",
          manifest: { version: 1, rootProjectId: "demo", projects: [], dependencies: [] },
          items: [{ projectId: "demo", status: "prepared", stage: "prepared" }],
        },
      }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await waitForProjectGroupPreparation({
      deploymentId,
      server: "http://localhost:7125",
      token: "token",
      pollIntervalMs: 0,
    });

    expect(result.errCode).toBe(0);
    expect(result.data?.status).toBe("prepared");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("queries a persisted preparation job after upload --no-wait", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse({
      errCode: 0,
      errMessage: "",
      data: {
        jobId: "a0000000-0000-4000-8000-000000000031",
        workflowId: "demo",
        archiveName: "demo.tgz",
        createOnly: false,
        status: "preparing",
        stage: "installing",
        createdAt: "2026-07-16T00:00:00.000Z",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPreparation({
      workflowId: "demo",
      jobId: "a0000000-0000-4000-8000-000000000031",
      server: "http://localhost:7125",
      token: "token",
    })).resolves.toMatchObject({ errCode: 0, data: { status: "preparing" } });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/workflows/demo/preparations/a0000000-0000-4000-8000-000000000031");
  });

  it("packages executable project source without requiring a README", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-optional-readme-"));
    const sourceWorkflowDir = path.join(root, "source");
    const archivePath = path.join(root, "workflow.tgz");
    await mkdir(sourceWorkflowDir, { recursive: true });
    await writeFile(path.join(sourceWorkflowDir, "package.json"), JSON.stringify({
      id: "a7e15f8a-e179-4986-8b0d-1e69a0e65b51",
      name: "@steamharness/optional-readme",
      version: "0.1.0",
    }));
    await writeFile(path.join(sourceWorkflowDir, "index.ts"), "export default {};\n");
    await expect(packWorkflow("optional-readme", archivePath, sourceWorkflowDir))
      .resolves.toBe(archivePath);
    await rm(root, { recursive: true, force: true });
  });

  it("packs a configured Kanban artifact using only .workflowignore", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-kanban-pack-"));
    const sourceDir = path.join(root, "kanban");
    const archivePath = path.join(root, "kanban.tgz");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "package.json"), JSON.stringify({
      id: "a7e15f8a-e179-4986-8b0d-1e69a0e65b51",
      name: "Kanban",
      version: "0.1.0",
      steamHarness: {
        projectType: "kanban",
        kanban: { artifactDir: "dist", entry: "pages/board.htm" },
      },
    }));
    await mkdir(path.join(sourceDir, "dist", "pages"), { recursive: true });
    await mkdir(path.join(sourceDir, "src"), { recursive: true });
    await writeFile(path.join(sourceDir, ".gitignore"), "dist/\n");
    await writeFile(path.join(sourceDir, ".workflowignore"), "src/\ndist/**/*.map\n");
    await writeFile(path.join(sourceDir, "dist", "pages", "board.htm"), "<!doctype html><title>Kanban</title>\n");
    await writeFile(path.join(sourceDir, "dist", "board.png"), Buffer.from([0, 1, 2, 255]));
    await writeFile(path.join(sourceDir, "dist", "app.js.map"), "{}");
    await writeFile(path.join(sourceDir, "src", "main.ts"), "source");

    await expect(packWorkflow("kanban", archivePath, sourceDir)).resolves.toBe(archivePath);
    const contents = await runTarList(archivePath);
    expect(contents).toContain("workspace/workflow/kanban/.gitignore");
    expect(contents).toContain("workspace/workflow/kanban/.workflowignore");
    expect(contents).toContain("workspace/workflow/kanban/dist/pages/board.htm");
    expect(contents).toContain("workspace/workflow/kanban/dist/board.png");
    expect(contents).not.toContain("workspace/workflow/kanban/dist/app.js.map");
    expect(contents).not.toContain("workspace/workflow/kanban/src/main.ts");
    await rm(root, { recursive: true, force: true });
  });

  it("decodes base64 download files without changing legacy text files", () => {
    expect(decodeWorkflowFileContent({ path: "index.html", content: "<main />" }))
      .toBe("<main />");
    expect(decodeWorkflowFileContent({
      path: "board.png",
      content: Buffer.from([0, 1, 2, 255]).toString("base64"),
      encoding: "base64",
    })).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(() => decodeWorkflowFileContent({
      path: "broken.png",
      content: "not base64!",
      encoding: "base64",
    })).toThrow("Invalid base64 content");
  });

  it("reads saved CLI auth config when no explicit token override is provided", async () => {
    const authDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-cli-auth-"));
    await writeFile(
      path.join(authDir, "workflow-auth.json"),
      JSON.stringify({
        serverUrl: "http://localhost:7125",
        apiKey: "saved-api-key",
        expiresAt: "2026-07-01T00:00:00.000Z",
        user: {
          userId: "user-1",
          email: "user@example.com",
          displayName: "Normal User",
        },
        source: "device_flow",
      }),
      "utf8",
    );

    const previousAuthDir = process.env.STEAMHARNESS_CLI_AUTH_DIR;
    const previousServer = process.env.STEAMHARNESS_SERVER_URL;
    const previousAdminKey = process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
    process.env.STEAMHARNESS_CLI_AUTH_DIR = authDir;
    delete process.env.STEAMHARNESS_SERVER_URL;
    delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;

    try {
      expect(parseArgs([
        "run",
        "hello",
        "--target",
        "latest",
      ])).toMatchObject({
        command: "run",
        positional: ["hello"],
        options: {
          server: "http://localhost:7125",
          token: "saved-api-key",
          target: "latest",
        },
      });
    } finally {
      if (previousAuthDir === undefined) {
        delete process.env.STEAMHARNESS_CLI_AUTH_DIR;
      } else {
        process.env.STEAMHARNESS_CLI_AUTH_DIR = previousAuthDir;
      }
      if (previousServer === undefined) {
        delete process.env.STEAMHARNESS_SERVER_URL;
      } else {
        process.env.STEAMHARNESS_SERVER_URL = previousServer;
      }
      if (previousAdminKey === undefined) {
        delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
      } else {
        process.env.STEAMHARNESS_SERVER_ADMIN_KEY = previousAdminKey;
      }
    }
  });

  it("reports the effective server and where it came from", async () => {
    const authDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-cli-auth-"));
    await writeFile(
      path.join(authDir, "workflow-auth.json"),
      JSON.stringify({
        serverUrl: "http://localhost:7126",
        apiKey: "saved-api-key",
        source: "device_flow",
      }),
      "utf8",
    );

    const previousAuthDir = process.env.STEAMHARNESS_CLI_AUTH_DIR;
    const previousServer = process.env.STEAMHARNESS_SERVER_URL;
    const previousAdminKey = process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
    process.env.STEAMHARNESS_CLI_AUTH_DIR = authDir;
    delete process.env.STEAMHARNESS_SERVER_URL;
    delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;

    try {
      // A host that spawns this CLI passes its own session through the
      // environment; status has to say so instead of echoing the login file.
      process.env.STEAMHARNESS_SERVER_URL = "https://wfalpha.yuhe.space";
      process.env.STEAMHARNESS_SERVER_ADMIN_KEY = "desktop-session-key";
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        await main(["status"]);
        const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
          data: { serverUrl: string; effective: unknown };
        };
        expect(payload.data.serverUrl).toBe("http://localhost:7126");
        expect(payload.data.effective).toEqual({
          serverUrl: "https://wfalpha.yuhe.space",
          serverSource: "env",
          tokenSource: "env",
        });
      } finally {
        log.mockRestore();
      }

      // Without a host session the saved login is what a command would use.
      delete process.env.STEAMHARNESS_SERVER_URL;
      delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
      expect(parseArgs(["status"]).effective).toEqual({
        serverUrl: "http://localhost:7126",
        serverSource: "file",
        tokenSource: "file",
      });

      // Explicit flags win over both.
      expect(parseArgs([
        "status",
        "--server",
        "https://example.test",
        "--token",
        "flag-token",
      ]).effective).toEqual({
        serverUrl: "https://example.test",
        serverSource: "flag",
        tokenSource: "flag",
      });

      // And over the environment, not the other way round.
      process.env.STEAMHARNESS_SERVER_URL = "https://from-env.test";
      process.env.STEAMHARNESS_SERVER_ADMIN_KEY = "env-token";
      expect(parseArgs([
        "status",
        "--server",
        "https://from-flag.test",
        "--token",
        "flag-token",
      ]).effective).toEqual({
        serverUrl: "https://from-flag.test",
        serverSource: "flag",
        tokenSource: "flag",
      });
    } finally {
      if (previousAuthDir === undefined) {
        delete process.env.STEAMHARNESS_CLI_AUTH_DIR;
      } else {
        process.env.STEAMHARNESS_CLI_AUTH_DIR = previousAuthDir;
      }
      if (previousServer === undefined) {
        delete process.env.STEAMHARNESS_SERVER_URL;
      } else {
        process.env.STEAMHARNESS_SERVER_URL = previousServer;
      }
      if (previousAdminKey === undefined) {
        delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
      } else {
        process.env.STEAMHARNESS_SERVER_ADMIN_KEY = previousAdminKey;
      }
      await rm(authDir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe download paths without hiding valid server snapshot files", () => {
    expect(normalizeWorkflowFilePath("./src/index.ts")).toBe("src/index.ts");
    expect(normalizeWorkflowFilePath("node_modules/pkg/index.js")).toBe("node_modules/pkg/index.js");
    expect(normalizeWorkflowFilePath(".env.local")).toBe(".env.local");
    expect(() => normalizeWorkflowFilePath("../secret.env")).toThrow(/Invalid workflow file path/);
  });

  it("resolves the standalone Core repository root from its workspace", async () => {
    const previousRepoRoot = process.env.STEAMHARNESS_REPO_ROOT;
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-core-root-"));
    const workflowDir = path.join(root, "workspace", "workflow", "hello");
    delete process.env.STEAMHARNESS_REPO_ROOT;

    try {
      await mkdir(workflowDir, { recursive: true });
      await Promise.all([
        writeFile(path.join(root, "pnpm-workspace.yaml"), 'packages:\n  - "."\n', "utf8"),
        writeFile(path.join(root, "package.json"), '{"name":"steamharness"}\n', "utf8"),
        writeFile(path.join(root, "workspace", "package.json"), '{"name":"@steamharness/workspace"}\n', "utf8"),
      ]);

      // keeps default pack paths rooted in the Core repository.
      expect(resolveRepoRoot(workflowDir)).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
      if (previousRepoRoot === undefined) {
        delete process.env.STEAMHARNESS_REPO_ROOT;
      } else {
        process.env.STEAMHARNESS_REPO_ROOT = previousRepoRoot;
      }
    }
  });

  it("executes the packaged dist CLI help without server access", async () => {
    const cliPath = path.resolve("dist", "index.js");
    if (!existsSync(cliPath)) {
      return;
    }

    const result = await runNode(cliPath, ["workspace", "--help"]);

    // covers the built server workspace CLI shape while keeping the
    // default test suite offline and independent of Workflow Server.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/(?:Usage|用法).*steamharness/);
    expect(result.stdout).toContain("pnpm exec steamharness workspace <command> [args]");
    expect(result.stdout).toContain("versions <workflow>");
    expect(result.stderr.trim()).toBe("");
  });

  it("ships the unified steamharness bin as a node executable", () => {
    const packageJson = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };
    const tsupConfig = readFileSync(path.resolve("tsup.config.ts"), "utf8");

    expect(packageJson.bin?.["steamharness"]).toBe("./dist/index.js");
    expect(tsupConfig).toContain('js: "#!/usr/bin/env node"');
  });

  it("stores the published workspace help text in the CLI resources", () => {
    const source = readFileSync(path.resolve(".shared", "i18n", "resources", "en", "cli.ts"), "utf8");

    expect(source).toContain("Usage: steamharness [--locale <zh-CN|en>] workspace <command> [args]");
    expect(source).toContain("http://localhost:7125");
  });

  it("backs off device polling when the server returns slow_down", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createJsonResponse({
        errCode: 429,
        errMessage: "slow_down",
        data: { retryAfterSeconds: 7 },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        errCode: 0,
        errMessage: "",
        data: {
          accessToken: "wf_api_test",
          apiKey: {
            prefix: "wf_api",
            expiresAt: "2026-07-01T00:00:00.000Z",
          },
          user: {
            userId: "user-1",
            email: "user@example.com",
            displayName: "Workflow User",
          },
          expiresAt: "2026-07-01T00:00:00.000Z",
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = waitForDeviceToken({
      server: "http://127.0.0.1:7125",
      deviceCode: "device-code-1",
      intervalSeconds: 5,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });

    await vi.runOnlyPendingTimersAsync();
    const result = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:7125/api/auth/device/token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ deviceCode: "device-code-1" }),
      }),
    );
    expect(result).toMatchObject({
      errCode: 0,
      data: {
        accessToken: "wf_api_test",
      },
    });
  });

  it("reads bound workflow UUIDs from the local package metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-package-"));
    const workflowDir = path.join(root, "workspace", "workflow", "hello");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
      id: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
      name: "Hello Workflow",
      version: "0.0.1",
      steamHarness: { projectType: "workflow" },
    }, null, 2));
    await writeFile(path.join(workflowDir, "index.ts"), VALID_STEAMHARNESS_SOURCE);

    const previousRepoRoot = process.env.STEAMHARNESS_REPO_ROOT;
    process.env.STEAMHARNESS_REPO_ROOT = root;
    try {
      const context = await readWorkflowPackageContext("hello", undefined);
      expect(context.workflowId).toBe("8bd4fef2-e083-4201-a89f-6f7d0676df53");
      expect(context.workflowName).toBe("Hello Workflow");
      expect(context.workflowDir).toBe(workflowDir);
    } finally {
      if (previousRepoRoot === undefined) {
        delete process.env.STEAMHARNESS_REPO_ROOT;
      } else {
        process.env.STEAMHARNESS_REPO_ROOT = previousRepoRoot;
      }
    }
  });

  it("rejects project creation when package.json has no UUID", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-create-"));
    const workflowDir = path.join(root, "workspace", "workflow", "hello");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
      id: "hello",
      name: "Hello Workflow",
      version: "0.0.1",
      steamHarness: { projectType: "workflow", projectInfo: createProjectInfo() },
    }, null, 2));
    await writeFile(path.join(workflowDir, "index.ts"), VALID_STEAMHARNESS_SOURCE);

    const previousRepoRoot = process.env.STEAMHARNESS_REPO_ROOT;
    process.env.STEAMHARNESS_REPO_ROOT = root;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      const packageContext = await readWorkflowPackageContext("hello", undefined);
      await expect(ensureWorkflowProjectCreated({
        packageContext,
        server: "http://127.0.0.1:7125",
        token: "api-key",
      })).rejects.toThrow(/UUID/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (previousRepoRoot === undefined) {
        delete process.env.STEAMHARNESS_REPO_ROOT;
      } else {
        process.env.STEAMHARNESS_REPO_ROOT = previousRepoRoot;
      }
    }
  });

  it("ensures an existing package UUID is created on the server when requested", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-create-bound-"));
    const workflowDir = path.join(root, "workspace", "workflow", "hello");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
      id: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
      name: "Hello Workflow",
      version: "0.0.1",
      steamHarness: { projectType: "workflow", projectInfo: createProjectInfo() },
    }, null, 2));
    await writeFile(path.join(workflowDir, "index.ts"), VALID_STEAMHARNESS_SOURCE);

    const previousRepoRoot = process.env.STEAMHARNESS_REPO_ROOT;
    process.env.STEAMHARNESS_REPO_ROOT = root;
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse({
      errCode: 0,
      errMessage: "",
      data: {
        workflowId: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
        workflowName: "Hello Workflow",
        visibility: "private",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const packageContext = await readWorkflowPackageContext("hello", undefined);
      const created = await ensureWorkflowProjectCreated({
        packageContext,
        server: "http://127.0.0.1:7125",
        token: "api-key",
      });

      expect(created.workflowId).toBe("8bd4fef2-e083-4201-a89f-6f7d0676df53");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:7125/api/workflows",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            name: "Hello Workflow",
            projectType: "workflow",
            workflowId: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
            projectInfo: {
              localizedNames: {},
              declarations: [],
              platformSupport: { mode: "agnostic" },
              dataStorage: { mode: "both" },
              relatedProjects: [],
            },
          }),
        }),
      );
      expect(JSON.parse(readFileSync(path.join(workflowDir, "package.json"), "utf8"))).toMatchObject({
        id: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
        name: "Hello Workflow",
      });
    } finally {
      if (previousRepoRoot === undefined) {
        delete process.env.STEAMHARNESS_REPO_ROOT;
      } else {
        process.env.STEAMHARNESS_REPO_ROOT = previousRepoRoot;
      }
    }
  });

  it("rejects project creation when data storage is undeclared", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-create-storage-"));
    const workflowDir = path.join(root, "workspace", "workflow", "hello");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
      id: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
      name: "Hello Workflow",
      version: "0.0.1",
      steamHarness: { projectType: "workflow" },
    }, null, 2));
    await writeFile(path.join(workflowDir, "index.ts"), VALID_STEAMHARNESS_SOURCE);

    const previousRepoRoot = process.env.STEAMHARNESS_REPO_ROOT;
    process.env.STEAMHARNESS_REPO_ROOT = root;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      const packageContext = await readWorkflowPackageContext("hello", undefined);
      await expect(ensureWorkflowProjectCreated({
        packageContext,
        server: "http://127.0.0.1:7125",
        token: "api-key",
      })).rejects.toThrow(/dataStorage\.mode/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (previousRepoRoot === undefined) {
        delete process.env.STEAMHARNESS_REPO_ROOT;
      } else {
        process.env.STEAMHARNESS_REPO_ROOT = previousRepoRoot;
      }
    }
  });

  it("finds sibling workflow source dependencies from relative imports", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-local-deps-"));
    const workflowDir = path.join(root, "workspace", "workflow", "deltaforce-openai-agent");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      path.join(workflowDir, "index.ts"),
      [
        'import { openaiAgentsWorkflow } from "../openai-agents/index";',
        'import type { ParsedAgentInput } from "../deltafore-agent/interface";',
        '/// <reference path="../deltafore-agent/globals.d.ts" />',
        "",
      ].join("\n"),
      "utf8",
    );

    expect(await findLocalWorkflowDependencies(workflowDir)).toEqual([
      "deltafore-agent",
      "openai-agents",
    ]);
  });

  it("stages a workflow with sibling workflow source dependencies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-stage-"));
    const workspaceRoot = path.join(root, "workspace", "workflow");
    const sourceWorkflowDir = path.join(workspaceRoot, "deltaforce-openai-agent");
    const siblingOpenaiDir = path.join(workspaceRoot, "openai-agents");
    const siblingDeltaforeDir = path.join(workspaceRoot, "deltafore-agent");
    const stagingRoot = path.join(root, "stage", "workspace", "workflow");

    await mkdir(sourceWorkflowDir, { recursive: true });
    await mkdir(siblingOpenaiDir, { recursive: true });
    await mkdir(siblingDeltaforeDir, { recursive: true });
    await writeFile(
      path.join(sourceWorkflowDir, "package.json"),
      JSON.stringify({
        id: "3c0292f9-9731-4862-9019-19544eeca705",
        name: "@steamharness/deltaforce-openai-agent-workflow",
        version: "0.1.0",
      }),
      "utf8",
    );
    await writeFile(
      path.join(sourceWorkflowDir, "index.ts"),
      [
        'import { openaiAgentsWorkflow } from "../openai-agents/index";',
        'import { createFinalAnswerInput } from "../deltafore-agent/agent/decision";',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(sourceWorkflowDir, "interface.ts"), "export type Foo = string;\n", "utf8");
    await writeFile(path.join(sourceWorkflowDir, "README.md"), "# Deltaforce\n", "utf8");
    await writeFile(path.join(siblingOpenaiDir, "package.json"), '{"name":"openai-agents"}\n', "utf8");
    await writeFile(path.join(siblingOpenaiDir, "index.ts"), "export const openaiAgentsWorkflow = {};\n", "utf8");
    await writeFile(path.join(siblingOpenaiDir, "README.md"), "# OpenAI agents\n", "utf8");
    await writeFile(path.join(siblingDeltaforeDir, "package.json"), '{"name":"deltafore-agent"}\n', "utf8");
    await writeFile(path.join(siblingDeltaforeDir, "index.ts"), "export default {};\n", "utf8");
    await writeFile(path.join(siblingDeltaforeDir, "README.md"), "# Deltafore agent\n", "utf8");
    await mkdir(path.join(siblingDeltaforeDir, "agent"), { recursive: true });
    await writeFile(
      path.join(siblingDeltaforeDir, "agent", "decision.ts"),
      "export const createFinalAnswerInput = () => ({});\n",
      "utf8",
    );

    await stageWorkflowWithLocalDependencies({
      workspaceRoot,
      workflowDir: sourceWorkflowDir,
      workflowName: "deltaforce-openai-agent",
      stagingRoot,
    });

    expect(existsSync(path.join(stagingRoot, "deltaforce-openai-agent", "index.ts"))).toBe(true);
    expect(existsSync(path.join(stagingRoot, "openai-agents", "index.ts"))).toBe(true);
    expect(existsSync(path.join(stagingRoot, "deltafore-agent", "agent", "decision.ts"))).toBe(true);
  });

  it("packs a workflow archive with sibling workflow source dependencies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-pack-"));
    const workspaceRoot = path.join(root, "workspace", "workflow");
    const sourceWorkflowDir = path.join(workspaceRoot, "deltaforce-openai-agent");
    const siblingOpenaiDir = path.join(workspaceRoot, "openai-agents");
    const siblingDeltaforeDir = path.join(workspaceRoot, "deltafore-agent");
    const archivePath = path.join(root, "deltaforce-openai-agent.tgz");

    await mkdir(sourceWorkflowDir, { recursive: true });
    await mkdir(siblingOpenaiDir, { recursive: true });
    await mkdir(siblingDeltaforeDir, { recursive: true });
    await writeFile(
      path.join(sourceWorkflowDir, "package.json"),
      JSON.stringify({
        id: "3c0292f9-9731-4862-9019-19544eeca705",
        name: "@steamharness/deltaforce-openai-agent-workflow",
        version: "0.1.0",
      }),
      "utf8",
    );
    await writeFile(
      path.join(sourceWorkflowDir, "index.ts"),
      [
        'import { openaiAgentsWorkflow } from "../openai-agents/index";',
        'import { createFinalAnswerInput } from "../deltafore-agent/agent/decision";',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(sourceWorkflowDir, "interface.ts"), "export type Foo = string;\n", "utf8");
    await writeFile(path.join(sourceWorkflowDir, "README.md"), "# Deltaforce\n", "utf8");
    await writeFile(path.join(siblingOpenaiDir, "package.json"), '{"name":"openai-agents"}\n', "utf8");
    await writeFile(path.join(siblingOpenaiDir, "index.ts"), "export const openaiAgentsWorkflow = {};\n", "utf8");
    await writeFile(path.join(siblingOpenaiDir, "README.md"), "# OpenAI agents\n", "utf8");
    await writeFile(path.join(siblingDeltaforeDir, "package.json"), '{"name":"deltafore-agent"}\n', "utf8");
    await writeFile(path.join(siblingDeltaforeDir, "index.ts"), "export default {};\n", "utf8");
    await writeFile(path.join(siblingDeltaforeDir, "README.md"), "# Deltafore agent\n", "utf8");
    await mkdir(path.join(siblingDeltaforeDir, "agent"), { recursive: true });
    await writeFile(
      path.join(siblingDeltaforeDir, "agent", "decision.ts"),
      "export const createFinalAnswerInput = () => ({});\n",
      "utf8",
    );

    const previousRepoRoot = process.env.STEAMHARNESS_REPO_ROOT;
    process.env.STEAMHARNESS_REPO_ROOT = root;
    try {
      const packedPath = await packWorkflow("deltaforce-openai-agent", archivePath, sourceWorkflowDir);
      expect(packedPath).toBe(archivePath);

      const result = await runTarList(archivePath);
      expect(result).toContain("workspace/workflow/deltaforce-openai-agent/index.ts");
      expect(result).toContain("workspace/workflow/openai-agents/index.ts");
      expect(result).toContain("workspace/workflow/deltafore-agent/agent/decision.ts");
    } finally {
      if (previousRepoRoot === undefined) {
        delete process.env.STEAMHARNESS_REPO_ROOT;
      } else {
        process.env.STEAMHARNESS_REPO_ROOT = previousRepoRoot;
      }
    }
  });

  it("packs dependency-bearing source without installing packages or requiring a lockfile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-pack-uninstalled-"));
    const sourceWorkflowDir = path.join(root, "manual-dependencies");
    const archivePath = path.join(root, "manual-dependencies.tgz");
    await mkdir(sourceWorkflowDir, { recursive: true });
    await writeFile(
      path.join(sourceWorkflowDir, "package.json"),
      JSON.stringify({
        id: "a7e15f8a-e179-4986-8b0d-1e69a0e65b51",
        name: "@steamharness/manual-dependencies",
        version: "0.1.0",
        dependencies: { "not-installed": "1.0.0" },
      }),
      "utf8",
    );
    await writeFile(path.join(sourceWorkflowDir, "index.ts"), "export default {};\n", "utf8");
    await writeFile(path.join(sourceWorkflowDir, "README.md"), "# Manual dependencies\n", "utf8");
    await writeFile(path.join(sourceWorkflowDir, ".env"), "SECRET=1\n", "utf8");
    await writeFile(path.join(sourceWorkflowDir, ".env.example"), "SECRET=\n", "utf8");
    await writeFile(path.join(sourceWorkflowDir, ".DS_Store"), "temporary", "utf8");
    await writeFile(path.join(sourceWorkflowDir, ".workflowignore"), ".env\n.DS_Store\n", "utf8");

    // CLI packaging only transports source; dependency installation
    // remains a server concern after upload.
    await expect(packWorkflow(
      "manual-dependencies",
      archivePath,
      sourceWorkflowDir,
    )).resolves.toBe(archivePath);

    expect(existsSync(path.join(sourceWorkflowDir, "node_modules"))).toBe(false);
    expect(existsSync(path.join(sourceWorkflowDir, "pnpm-lock.yaml"))).toBe(false);
    const contents = await runTarList(archivePath);
    expect(contents).toContain("workspace/workflow/manual-dependencies/package.json");
    expect(contents).toContain("workspace/workflow/manual-dependencies/README.md");
    expect(contents).toContain("workspace/workflow/manual-dependencies/.env.example");
    expect(contents).toContain("workspace/workflow/manual-dependencies/.workflowignore");
    expect(contents).not.toContain("workspace/workflow/manual-dependencies/.env\n");
    expect(contents).not.toContain(".DS_Store");
  });

  it("packs explicit source paths with a writable App packs directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-pack-app-"));
    const appRuntimeRoot = path.join(root, "app-runtime");
    const packsDir = path.join(root, "app-packs");
    const workspaceRoot = path.join(root, "external-workflows");
    const sourceWorkflowDir = path.join(workspaceRoot, "conversation");
    const siblingWorkflowDir = path.join(workspaceRoot, "openai-agents");

    await mkdir(appRuntimeRoot, { recursive: true });
    await mkdir(sourceWorkflowDir, { recursive: true });
    await mkdir(siblingWorkflowDir, { recursive: true });
    await writeFile(
      path.join(sourceWorkflowDir, "package.json"),
      JSON.stringify({
        id: "2dc44605-66d9-4a07-8090-72eb83d708a7",
        name: "@steamharness/conversation-workflow",
        version: "0.1.0",
      }),
      "utf8",
    );
    await writeFile(
      path.join(sourceWorkflowDir, "index.ts"),
      'import { openaiAgentsWorkflow } from "../openai-agents/index";\n',
      "utf8",
    );
    await writeFile(path.join(sourceWorkflowDir, "README.md"), "# Conversation\n", "utf8");
    await writeFile(path.join(siblingWorkflowDir, "package.json"), '{"name":"openai-agents"}\n', "utf8");
    await writeFile(path.join(siblingWorkflowDir, "index.ts"), "export const openaiAgentsWorkflow = {};\n", "utf8");
    await writeFile(path.join(siblingWorkflowDir, "README.md"), "# OpenAI agents\n", "utf8");

    const previousRepoRoot = process.env.STEAMHARNESS_REPO_ROOT;
    const previousPacksDir = process.env.STEAMHARNESS_WORKSPACE_PACKS_DIR;
    process.env.STEAMHARNESS_REPO_ROOT = appRuntimeRoot;
    process.env.STEAMHARNESS_WORKSPACE_PACKS_DIR = packsDir;
    try {
      // App-packaged uploads pass --path for the local project and
      // need temporary archives outside app.asar while still copying sibling
      // workflow imports from the source folder's parent.
      const packedPath = await packWorkflow("conversation", undefined, sourceWorkflowDir);
      expect(packedPath.startsWith(packsDir)).toBe(true);

      const result = await runTarList(packedPath);
      expect(result).toContain("workspace/workflow/conversation/index.ts");
      expect(result).toContain("workspace/workflow/openai-agents/index.ts");
    } finally {
      if (previousRepoRoot === undefined) {
        delete process.env.STEAMHARNESS_REPO_ROOT;
      } else {
        process.env.STEAMHARNESS_REPO_ROOT = previousRepoRoot;
      }
      if (previousPacksDir === undefined) {
        delete process.env.STEAMHARNESS_WORKSPACE_PACKS_DIR;
      } else {
        process.env.STEAMHARNESS_WORKSPACE_PACKS_DIR = previousPacksDir;
      }
    }
  });

  it("formats project permission failures and preserves request-specific details", () => {
    // The CLI default locale is zh-CN, so the translated output keeps the
    // original Chinese text verbatim.
    initI18n({ preference: "zh-CN" });
    expect(formatForbiddenMessage({
      errCode: 403,
      errMessage: "Project data access is not granted.",
    })).toBe("403: Project data access is not granted.");

    expect(formatForbiddenMessage({
      errCode: 403,
      errMessage: "Permission denied.",
    })).toBe("403: 当前账号对该项目没有足够权限。");
  });

  it("localizes forbidden messages to English after --locale en", () => {
    // --locale en resolves to initI18n({ preference: "en" }) and switches the
    // shared CLI namespace to English while keeping the "403: " prefix.
    initI18n({ preference: "en" });
    expect(formatForbiddenMessage({
      errCode: 403,
      errMessage: "Project source download is not granted.",
    })).toBe("403: Project source download is not granted.");

    expect(formatForbiddenMessage({
      errCode: 403,
      errMessage: "Permission denied.",
    })).toBe("403: Your account does not have sufficient permission for this project operation.");
  });

});

function createKanbanPackage(
  projectId: string,
  name: string,
  relatedProjectId?: string,
  relatedAlias = "stocks",
): Record<string, unknown> {
  return {
    id: projectId,
    name,
    version: "1.0.0",
    steamHarness: {
      projectType: "kanban",
      projectInfo: relatedProjectId === undefined
        ? createProjectInfo()
        : createProjectInfo(relatedAlias, relatedProjectId),
      kanban: {},
    },
  };
}

function createProjectInfo(alias?: string, projectId?: string): Record<string, unknown> {
  return {
    dataStorage: { mode: "both" },
    relatedProjects: alias === undefined || projectId === undefined ? [] : [{
      alias,
      projectId,
      grantToRelatedProject: {
        read: { mode: "all" },
        write: { mode: "none" },
      },
    }],
  };
}

function createPublishedDependencyLock(projectId: string) {
  return {
    alias: "stocks",
    projectId,
    delivery: "included" as const,
    version: "0.5.0",
    sourceHash: "b".repeat(64),
  };
}

function finalizeProjectGroupDownloadFixture<T extends {
  dependencies: Array<{
    projectId: string;
    delivery: "included" | "external";
    version?: string;
    sourceHash?: string;
  }>;
  projects: Array<{
    projectId: string;
    version: string;
    sourceHash: string;
    role: "root" | "dependency";
    files: Array<{ path: string; content: string; encoding?: "base64" }>;
  }>;
}>(download: T): T {
  for (const project of download.projects) {
    project.sourceHash = hashProjectGroupSourceFiles(project.files);
    if (project.role !== "dependency") continue;
    for (const dependency of download.dependencies) {
      if (
        dependency.delivery === "included" &&
        dependency.projectId === project.projectId &&
        dependency.version === project.version
      ) {
        dependency.sourceHash = project.sourceHash;
      }
    }
  }
  return download;
}

function hashProjectGroupSourceFiles(
  files: ReadonlyArray<{ path: string; content: string; encoding?: "base64" }>,
): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ))) {
    hash.update(file.path.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function runNode(
  scriptPath: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_OPTIONS: removeNodeOptionsConditions(process.env.NODE_OPTIONS ?? ""),
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function removeNodeOptionsConditions(value: string): string {
  return value
    .split(/\s+/)
    .filter((part) => part !== "--conditions=development" && part !== "--conditions" && part !== "development")
    .join(" ")
    .trim();
}

function createJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function runTarList(archivePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-tzf", archivePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString("utf8")));
    });
  });
}
