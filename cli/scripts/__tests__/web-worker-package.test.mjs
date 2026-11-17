import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const cliRoot = path.resolve(import.meta.dirname, "../..");

// A copied worker must run without the monorepo's private workspace packages.
// Only the published runtime dependencies are made available in this fixture.
test("the built Web worker inspects a project outside the workspace", async () => {
  await promisify(execFile)(process.execPath, [path.join(cliRoot, "scripts/build-web.mjs")], { timeout: 30_000 });
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cli-worker-package-")));
  try {
    await mkdir(path.join(root, "node_modules/steamharness"), { recursive: true });
    await writeFile(path.join(root, "node_modules/steamharness/package.json"), JSON.stringify({
      name: "steamharness", version: "0.2.0", type: "module", exports: "./index.js",
    }));
    // No project is inspected; this Core fixture isolates worker startup and
    // its bundled project metadata from the rest of the execution runtime.
    await writeFile(path.join(root, "node_modules/steamharness/index.js"), "export {};\n");
    for (const name of ["tsx", "import-meta-resolve", "typescript"]) {
      await symlink(await realpath(path.join(cliRoot, "node_modules", name)), path.join(root, "node_modules", name), "junction");
    }
    await cp(path.join(cliRoot, "dist/web/worker.mjs"), path.join(root, "worker.mjs"));
    await cp(path.join(cliRoot, "dist/web/worker-transport.mjs"), path.join(root, "worker-transport.mjs"));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, "worker.mjs")], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Worker timed out: ${stderr}`)); }, 10_000);
      child.stdout.setEncoding("utf8").on("data", (data) => { stdout += data; });
      child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
      child.on("error", reject);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      child.stdin.end(JSON.stringify({ method: "inspect", project: { folderPath: root }, paths: [] }));
    });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const frame = JSON.parse(result.stdout.trim().slice("__STEAMHARNESS_WEB__".length));
    assert.deepEqual(frame, { kind: "result", value: { projects: [], errors: [] } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
