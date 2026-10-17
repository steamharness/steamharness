import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("server launchd helper keeps production keepalive configuration in repo", () => {
  const scriptPath = path.resolve(import.meta.dirname, "../../scripts/launchd.mjs");
  const contents = readFileSync(scriptPath, "utf8");

  assert.match(contents, /<print\|install\|uninstall\|status>/);
  assert.match(contents, /KeepAlive/);
  assert.match(contents, /RunAtLoad/);
  assert.match(contents, /dist", "index\.js"/);
  assert.match(contents, /WORKFLOW_REPO_ROOT/);
  assert.match(contents, /WORKFLOW_SERVER_DATA_DIR/);
  assert.match(contents, /mkdir\(path\.join\(dataRoot, "logs"\)/);
});

test("docs launchd helper keeps published docs on the release root", () => {
  const scriptPath = path.resolve(import.meta.dirname, "../../scripts/docs-launchd.mjs");
  const contents = readFileSync(scriptPath, "utf8");

  assert.match(contents, /<print\|install\|uninstall\|status>/);
  assert.match(contents, /scripts", "docs-server\.mjs"/);
  assert.match(contents, /WORKFLOW_DOCS_ROOT/);
  assert.match(contents, /WORKFLOW_SERVER_DATA_DIR/);
});
