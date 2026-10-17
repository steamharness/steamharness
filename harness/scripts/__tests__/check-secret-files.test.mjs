import assert from "node:assert/strict";
import test from "node:test";
import {
  findUnsafeEnvironmentPaths,
  findUnsafeExampleAssignments,
  findUnsafeHistoricalExampleAssignments,
  isExampleEnvironmentFile,
} from "../check-secret-files.mjs";

test("secret file audit rejects local env files from current or historical refs", () => {
  assert.deepEqual(findUnsafeEnvironmentPaths({
    tracked: ["workspace/workflow/hello/.env.example"],
    untracked: ["workspace/workflow/hello/.env.local"],
    historical: ["workspace/workflow/hello/.env"],
  }), ["workspace/workflow/hello/.env", "workspace/workflow/hello/.env.local"]);
  assert.equal(isExampleEnvironmentFile("workspace\\workflow\\hello\\.env.production.example"), true);
});

test("secret file audit scans deleted example values in reachable history", async () => {
  const findings = await findUnsafeHistoricalExampleAssignments([
    { objectId: "safe", filePath: ".env.example" },
    { objectId: "unsafe", filePath: "workspace/workflow/hello/.env.example" },
    { objectId: "ignored", filePath: "README.md" },
  ], async (objectId) => objectId === "unsafe" ? "LLM_API_KEY=sk-live-value\n" : "LLM_API_KEY=\n");
  assert.deepEqual(findings, [{
    filePath: "workspace/workflow/hello/.env.example",
    line: 1,
    name: "LLM_API_KEY",
  }]);
});

test("secret file audit accepts placeholders and reports only variable names", () => {
  assert.deepEqual(findUnsafeExampleAssignments([
    "OPENAI_API_KEY=",
    "STEAMHARNESS_DATABASE_URL=postgresql://user:replace-with-password@localhost/db",
    "JWT_SECRET=change_me_with_openssl_rand_hex_32",
    "STEAMHARNESS_SERVER_PORT=7130",
  ].join("\n")), []);
  assert.deepEqual(findUnsafeExampleAssignments("OPENAI_API_KEY=sk-live-value\n"), [
    { line: 1, name: "OPENAI_API_KEY" },
  ]);
});
