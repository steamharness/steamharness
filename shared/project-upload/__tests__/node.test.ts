import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectUploadPlan } from "../node";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("createProjectUploadPlan", () => {
  it("includes a git-ignored Kanban artifact and applies only .steamharnessignore", async () => {
    const root = await createProject({
      defaultEntry:"board", entries:[{entryId:"board",type:"kanban",name:"Board",root:".",entry:"dist/board.html",databases:[]}],
    });
    await mkdir(path.join(root, "dist"));
    await Promise.all([
      writeFile(path.join(root, ".gitignore"), "dist/\n.env\n"),
      writeFile(path.join(root, ".steamharnessignore"), "src/\ndist/**/*.map\n"),
      writeFile(path.join(root, ".env"), "TOKEN=value\n"),
      writeFile(path.join(root, "dist", "board.html"), "<!doctype html>"),
      writeFile(path.join(root, "dist", "app.js"), "console.log('ok')"),
      writeFile(path.join(root, "dist", "app.js.map"), "{}"),
    ]);

    const plan = await createProjectUploadPlan(root);
    expect(plan.files.map((file) => file.path)).toEqual([
      ".gitignore",
      ".steamharnessignore",
      "dist/app.js",
      "dist/board.html",
      "package.json",
    ]);
    expect(plan.ignoredPaths).toContain("dist/app.js.map");
  });

  it("excludes host dependencies even without .steamharnessignore", async () => {
    const root = await createProject();
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await Promise.all([
      writeFile(path.join(root, "index.ts"), "export {}"),
      writeFile(path.join(root, "README.md"), "# Project"),
      writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = {}"),
    ]);
    const plan = await createProjectUploadPlan(root);
    expect(plan.projectIgnorePresent).toBe(false);
    expect(plan.projectIgnoreConfigured).toBe(false);
    expect(plan.files.map((file) => file.path)).not.toContain("node_modules/pkg/index.js");
  });

  it("rejects symbolic links instead of following host paths", async () => {
    const root = await createProject();
    await Promise.all([
      writeFile(path.join(root, "index.ts"), "export {}"),
      writeFile(path.join(root, "README.md"), "# Project"),
    ]);
    try {
      await symlink(path.join(root, "README.md"), path.join(root, "linked.md"), "file");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(createProjectUploadPlan(root)).rejects.toThrow("must be a regular file or directory");
  });

  it("rejects a non-UTF-8 .steamharnessignore instead of applying replacement characters", async () => {
    const root = await createProject();
    await Promise.all([
      writeFile(path.join(root, "index.ts"), "export {}"),
      writeFile(path.join(root, "README.md"), "# Project"),
      writeFile(path.join(root, ".steamharnessignore"), Uint8Array.from([0xff, 0xfe, 0xfd])),
    ]);

    await expect(createProjectUploadPlan(root))
      .rejects.toThrow("Workflow .steamharnessignore must be a UTF-8 text file.");
  });
});

async function createProject(steamHarness?: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-upload-"));
  tempDirectories.push(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    id: "00000000-0000-4000-8000-000000000001",
    name: "upload-test",
    version: "0.1.0",
    steamHarness: steamHarness ?? {defaultEntry:"main",entries:[{entryId:"main",type:"workflow",name:"Main",root:".",entry:"index.ts",databases:[]}]},
  }));
  return root;
}
