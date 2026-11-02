import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { runServerCommand } from "../dev.mjs";

test("Server command preserves exit codes and removes signal handlers on exit or spawn failure", async () => {
  const listeners = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const original = listeners();
  assert.equal(await runServerCommand(process.execPath, ["-e", "process.exit(7)"], { env: process.env }), 7);
  assert.deepEqual(listeners(), original);
  await assert.rejects(runServerCommand(process.execPath, [], { cwd: new URL("./missing-command-directory/", import.meta.url), env: process.env }), { code: "ENOENT" });
  assert.deepEqual(listeners(), original);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`Server command forwards ${signal} to its child and waits for shutdown`, { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
    const childSource = `
      process.once(${JSON.stringify(signal)}, () => {
        process.stdout.write('received-${signal}\\n');
        process.exit(0);
      });
      process.stdout.write('ready\\n');
      setTimeout(() => process.exit(99), 3000);
    `;
    const runnerUrl = new URL("../dev.mjs", import.meta.url).href;
    const parentSource = `
      import { runServerCommand } from ${JSON.stringify(runnerUrl)};
      process.exitCode = await runServerCommand(process.execPath, ['-e', ${JSON.stringify(childSource)}], { env: process.env });
    `;
    const parent = spawn(process.execPath, ["--input-type=module", "-e", parentSource], { stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => { if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL"); });
    let output = "", errors = "", sent = false;
    parent.stdout.on("data", chunk => {
      output += chunk.toString();
      if (!sent && output.includes("ready\n")) {
        sent = true;
        parent.kill(signal);
      }
    });
    parent.stderr.on("data", chunk => { errors += chunk.toString(); });
    const code = await new Promise((resolve, reject) => {
      parent.once("error", reject);
      parent.once("close", resolve);
    });
    assert.equal(code, 0, errors || output);
    assert.equal(sent, true);
    assert.ok(output.includes(`received-${signal}\n`), output);
  });
}
