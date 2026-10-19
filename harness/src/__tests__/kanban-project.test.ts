import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  inspectLocalProjectStructure,
  resolveLocalProjectParams,
  runLocalProjectWithReport,
} from "../index";

test("inspects a Kanban project without an executor", async () => {
  const projectDir = await createKanbanFixture();
  try {
    const report = inspectLocalProjectStructure({ projectDir: projectDir });
    assert.equal(report.projectType, "kanban");
    assert.equal(report.kanban?.entry, "index.html");
    assert.deepEqual(report.params, [{ name: "title", type: "string", defaultValue: "Roadmap" }]);
    assert.deepEqual(report.workflow.files, ["index.html", "kanban.json", "package.json"]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("rejects run and parameter resolver commands for Kanban", async () => {
  const projectDir = await createKanbanFixture();
  try {
    await assert.rejects(
      runLocalProjectWithReport({ projectDir: projectDir }),
      /static HTML project.*does not support workflow execution/,
    );
    await assert.rejects(
      resolveLocalProjectParams({
        projectDir: projectDir,
        request: { draftText: "", args: [], inputMode: "form", trigger: { kind: "init" } },
      }),
      /static HTML project.*does not support workflow execution/,
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("inspects a Kanban project from a configured artifact directory", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-kanban-artifact-"));
  try {
    await mkdir(path.join(projectDir, "dist", "pages"), { recursive: true });
    await Promise.all([
      writeFile(path.join(projectDir, "package.json"), JSON.stringify({
        id: "kanban-artifact-test",
        name: "Kanban Artifact Test",
        version: "0.1.0",
        steamHarness: {
          projectType: "kanban",
          kanban: {
            artifactDir: "dist",
            entry: "pages/board.html",
          },
        },
      })),
      writeFile(path.join(projectDir, "dist", "pages", "board.html"), "<!doctype html>"),
    ]);

    const report = inspectLocalProjectStructure({ projectDir: projectDir });
    assert.deepEqual(report.kanban, {
      artifactDir: "dist",
      entry: "pages/board.html",
      manifest: undefined,
    });
    assert.ok(report.workflow.files.includes("dist/pages/board.html"));
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("rejects removed Kanban dataSources declarations", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-kanban-data-sources-"));
  try {
    await Promise.all([
      writeFile(path.join(projectDir, "package.json"), JSON.stringify({
        id: "11111111-1111-4111-8111-111111111111",
        name: "Legacy Kanban",
        version: "0.1.0",
        steamHarness: {
          projectType: "kanban",
          kanban: {
            dataSources: [{
              id: "stocks",
              kind: "workflow-kv",
              projectId: "f4ee23d7-abbb-4ba3-8baf-75b7c6c0b964",
              keyPrefixes: ["stock-database.v3:"],
            }],
          },
        },
      })),
      writeFile(path.join(projectDir, "index.html"), "<!doctype html>"),
    ]);

    assert.throws(
      () => inspectLocalProjectStructure({ projectDir: projectDir }),
      /dataSources was removed/,
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("rejects a configured Kanban artifact entry through a symbolic-link directory", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-kanban-symlink-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-kanban-outside-"));
  try {
    await writeFile(path.join(outsideDir, "index.html"), "<!doctype html>");
    try {
      await symlink(outsideDir, path.join(projectDir, "dist"), "dir");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({
      id: "kanban-symlink-test",
      name: "Kanban Symlink Test",
      version: "0.1.0",
      steamHarness: {
        projectType: "kanban",
        kanban: { artifactDir: "dist", entry: "index.html" },
      },
    }));

    assert.throws(
      () => inspectLocalProjectStructure({ projectDir: projectDir }),
      /must contain regular artifact entry dist\/index\.html/,
    );
  } finally {
    await Promise.all([
      rm(projectDir, { recursive: true, force: true }),
      rm(outsideDir, { recursive: true, force: true }),
    ]);
  }
});

async function createKanbanFixture(): Promise<string> {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-kanban-"));
  await Promise.all([
    writeFile(path.join(projectDir, "package.json"), JSON.stringify({
      id: "kanban-test",
      name: "Kanban Test",
      version: "0.1.0",
        steamHarness: {
          projectType: "kanban",
          kanban: {},
        },
    })),
    writeFile(path.join(projectDir, "index.html"), "<!doctype html><title>Kanban</title>"),
    writeFile(path.join(projectDir, "kanban.json"), JSON.stringify({
      version: 1,
      params: [{ name: "title", type: "string", defaultValue: "Roadmap" }],
    })),
  ]);
  return projectDir;
}
