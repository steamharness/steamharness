import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createInjectedKanbanParams,
  inspectLocalProjectStructure,
  runLocalProjectWithReport,
} from "steamharness";
import { afterEach, describe, expect, it } from "vitest";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("workspace steamharness Kanban contract", () => {
  it("inspects package metadata, the HTML entry, and manifest params without an executor", async () => {
    const projectDir = await createKanbanProject();

    const structure = inspectLocalProjectStructure({ projectDir: projectDir });

    expect(structure.projectType).toBe("kanban");
    expect(structure.kanban?.entry).toBe("index.html");
    expect(structure.params).toBeUndefined();
    expect(structure.configuration?.fields).toEqual([{ name: "title", type: "string", defaultValue: "Roadmap" }]);
    expect(structure.workflow.files.map((file) => file.replaceAll("\\", "/"))).toEqual([
      "configuration.json",
      "index.html",
      "package.json",
    ]);
  });

  it("rejects workflow execution for a static Kanban package", async () => {
    const projectDir = await createKanbanProject();

    await expect(runLocalProjectWithReport({ projectDir: projectDir })).rejects.toThrow(
      /static HTML project.*does not support workflow execution/,
    );
  });

  it("injects opaque file references without local or server storage paths", () => {
    const [file] = createInjectedKanbanParams([{
      name: "attachments",
      type: "file",
      multiple: true,
    }], {
      attachments: JSON.stringify([{
        id: "file-1",
        name: "brief.pdf",
        mimeType: "application/pdf",
        size: 42,
        kind: "file",
        storage: "server",
        storagePath: "/private/workflow-files/file-1/content",
        localAbsolutePath: "/Users/example/brief.pdf",
      }]),
    }).attachments as Array<Record<string, unknown>>;

    expect(file).toEqual({
      id: "file-1",
      name: "brief.pdf",
      mimeType: "application/pdf",
      size: 42,
      kind: "file",
      storage: "server",
    });
    expect(file).not.toHaveProperty("storagePath");
    expect(file).not.toHaveProperty("localAbsolutePath");
  });

  it("uses manifest defaults for values missing from an older configuration", () => {
    expect(createInjectedKanbanParams([
      { name: "title", type: "string", defaultValue: "Roadmap" },
      { name: "columns", type: "number", defaultValue: "3" },
    ], {})).toEqual({ title: "Roadmap", columns: 3 });
  });
});

async function createKanbanProject(): Promise<string> {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-workspace-kanban-"));
  tempDirectories.push(projectDir);
  await Promise.all([
    writeFile(path.join(projectDir, "package.json"), JSON.stringify({
      id: "019fa4f0-5bc9-7d04-b552-112d2f4b66ea",
      name: "Workspace Kanban",
      version: "0.1.0",
      steamHarness: { projectType: "kanban" },
    }), "utf8"),
    writeFile(path.join(projectDir, "index.html"), "<!doctype html><title>Kanban</title>", "utf8"),
    writeFile(path.join(projectDir, "configuration.json"), JSON.stringify({
      version: 1,
      fields: [{ name: "title", type: "string", defaultValue: "Roadmap" }],
    }), "utf8"),
  ]);
  return projectDir;
}
