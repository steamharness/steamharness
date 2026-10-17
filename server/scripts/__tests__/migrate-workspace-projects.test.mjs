import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveDefaultWorkspaceRoot } from "../migrate-workspace-projects.mjs";

test("workspace migration accepts an explicit cross-platform workspace root", () => {
  const explicit = path.join(path.parse(process.cwd()).root, "workflow-fixtures", "workspace");
  assert.equal(
    resolveDefaultWorkspaceRoot({ WORKFLOW_WORKSPACE_ROOT: explicit }),
    path.resolve(explicit),
  );
});

test("workspace migration defaults to the sibling Core repository workspace", () => {
  const expected = path.resolve(import.meta.dirname, "..", "..", "..", "core", "workspace", "workflow");
  assert.equal(resolveDefaultWorkspaceRoot({}), expected);
});
