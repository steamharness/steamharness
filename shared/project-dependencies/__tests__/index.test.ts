import { describe, expect, it } from "vitest";
import {
  i18n,
  initI18n,
  readSteamHarnessI18nDescriptor,
  translateSteamHarnessError,
} from "@steamharness/i18n";
import {
  createExternalWorkflowProjectDependencyLocks,
  createWorkflowProjectDependencyLocks,
  finalizeWorkflowProjectDependencyLock,
  isProjectGroupHostDataPath,
  parseWorkflowProjectDependencyLocks,
  parseWorkflowProjectGroupManifest,
} from "../index";

const ROOT_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_ID = "00000000-0000-4000-8000-000000000002";
const relatedProjects = [{
  alias: "stocks",
  projectId: SOURCE_ID,
  grantToRelatedProject: {
    read: { mode: "all" as const },
    write: { mode: "none" as const },
  },
}];

describe("workflow project dependencies", () => {
  it("attaches translatable descriptors to malformed project-group input", async () => {
    let failure: unknown;
    try {
      parseWorkflowProjectGroupManifest({ version: 2 });
    } catch (error) {
      failure = error;
    }

    expect((failure as Error).message).toBe("Project group manifest version must be 1.");
    expect(readSteamHarnessI18nDescriptor(failure)).toEqual({
      namespace: "common",
      key: "projectDependencies.validation.manifestVersion",
      values: { version: 1 },
    });
    initI18n({ preference: "zh-CN" });
    expect(translateSteamHarnessError(failure)).toBe("项目组清单版本必须是 1。");
    try {
      await i18n.changeLanguage("en");
      expect(translateSteamHarnessError(failure)).toBe("Project group manifest version must be 1.");
    } finally {
      await i18n.changeLanguage("zh-CN");
    }
  });

  it("derives locks from confirmed related projects", () => {
    expect(createExternalWorkflowProjectDependencyLocks(relatedProjects)).toEqual([{
      alias: "stocks",
      projectId: SOURCE_ID,
      delivery: "external",
    }]);
    expect(createWorkflowProjectDependencyLocks(relatedProjects, [{
      alias: "stocks",
      delivery: "included",
    }])[0]?.delivery).toBe("included");
  });

  it("requires published included locks to pin exact version and source hash", () => {
    expect(() => parseWorkflowProjectDependencyLocks([{
      ...createWorkflowProjectDependencyLocks(relatedProjects, [{ alias: "stocks", delivery: "included" }])[0],
    }], { published: true })).toThrow("must pin version and sourceHash");

    expect(finalizeWorkflowProjectDependencyLock(
      createWorkflowProjectDependencyLocks(relatedProjects, [{ alias: "stocks", delivery: "included" }])[0]!,
      { version: "1.2.3", sourceHash: "a".repeat(64) },
    )).toMatchObject({ version: "1.2.3", sourceHash: "a".repeat(64) });
  });

  it("rejects malformed optional lock and manifest fields instead of treating them as absent", () => {
    const included = createWorkflowProjectDependencyLocks(relatedProjects, [{
      alias: "stocks",
      delivery: "included",
    }])[0]!;
    expect(() => parseWorkflowProjectDependencyLocks([{
      ...included,
      version: 12,
      sourceHash: "a".repeat(64),
    }], { published: true })).toThrow("dependencies[0].version must be a non-empty string");
    expect(() => parseWorkflowProjectGroupManifest({
      version: 1,
      rootProjectId: ROOT_ID,
      projects: [{
        projectId: ROOT_ID,
        role: "root",
        archivePath: "projects/root.tgz",
        sourceId: "removed",
      }],
      dependencies: [],
    })).toThrow("projects[0].sourceId is not supported");
  });

  it("validates a project-group manifest and its included archive mapping", () => {
    expect(parseWorkflowProjectGroupManifest({
      version: 1,
      rootProjectId: ROOT_ID,
      projects: [
        { projectId: ROOT_ID, role: "root", archivePath: `projects/${ROOT_ID}.tgz` },
        { projectId: SOURCE_ID, role: "dependency", alias: "stocks", archivePath: `projects/${SOURCE_ID}.tgz` },
      ],
      dependencies: [{
        alias: "stocks",
        projectId: SOURCE_ID,
        delivery: "included",
      }],
    }).projects).toHaveLength(2);
  });

  it("accepts exact project versions and rejects malformed ones", () => {
    const manifest = parseWorkflowProjectGroupManifest({
      version: 1,
      rootProjectId: ROOT_ID,
      projects: [{
        projectId: ROOT_ID,
        role: "root",
        archivePath: `projects/${ROOT_ID}.tgz`,
        version: "0.1.2",
      }],
      dependencies: [],
    });
    expect(manifest.projects[0]?.version).toBe("0.1.2");
    expect(() => parseWorkflowProjectGroupManifest({
      version: 1,
      rootProjectId: ROOT_ID,
      projects: [{
        projectId: ROOT_ID,
        role: "root",
        archivePath: `projects/${ROOT_ID}.tgz`,
        version: "next",
      }],
      dependencies: [],
    })).toThrow(/projects\[0\]\.version is invalid/u);
  });

  it("rejects duplicate dependency aliases and unmatched included projects", () => {
    const duplicate = createExternalWorkflowProjectDependencyLocks(relatedProjects)[0]!;
    expect(() => parseWorkflowProjectDependencyLocks([duplicate, duplicate]))
      .toThrow("alias \"stocks\" is duplicated");
    expect(() => parseWorkflowProjectGroupManifest({
      version: 1,
      rootProjectId: ROOT_ID,
      projects: [{ projectId: ROOT_ID, role: "root", archivePath: "projects/root.tgz" }],
      dependencies: [{ ...duplicate, delivery: "included" }],
    })).toThrow("has no project archive");
  });

  it("rejects a project-group dependency that references the root project", () => {
    expect(() => parseWorkflowProjectGroupManifest({
      version: 1,
      rootProjectId: ROOT_ID,
      projects: [{ projectId: ROOT_ID, role: "root", archivePath: "projects/root.tgz" }],
      dependencies: [{
        alias: "self",
        projectId: ROOT_ID,
        delivery: "external",
      }],
    })).toThrow("cannot reference the root project");
  });

  it("identifies host data that project groups must never transport", () => {
    for (const filePath of [
      ".env",
      ".env.production",
      ".workflow-kv/value.json",
      ".workflow-persistent-values/value.json",
      ".workflow-schedules/schedules.json",
      ".workflow-runs/history.json",
      ".data/server.json",
      "steamharness.sqlite",
      "steamharness.sqlite-wal",
      "steamharness.sqlite-shm",
      "workflow-auth.json",
      "local-project-registries/dev.json",
      "workflow-files/file-1/content",
      "local-projects.json",
      ".envrc",
    ]) {
      expect(isProjectGroupHostDataPath(filePath), filePath).toBe(true);
    }
    expect(isProjectGroupHostDataPath(".env.example")).toBe(false);
    expect(isProjectGroupHostDataPath("src/index.ts")).toBe(false);
  });
});
