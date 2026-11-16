import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProjectManifest } from "@steamharness/project-manifest";
import { DatabaseRepository, InvalidStoredProjectError } from "../persistence";
import { isSupportedStoredProject, readStoredProjectManifest } from "../stored-project";

const projectId = "00000000-0000-4000-8000-000000000201";
const entry = { entryId: "main", name: "Main", type: "workflow", root: ".", entry: "index.ts" };

test("stored project reads omit retired declarations without changing rows or accepting old uploads", () => {
  const row = {
    id: projectId, name: "Existing project", default_entry: "main",
    entries: [{ ...entry, databases: [{ id: "retained" }], knowledgeBases: [] }],
  };
  const original = structuredClone(row);
  assert.deepEqual(readStoredProjectManifest(row).entries, [entry]);
  assert.equal(isSupportedStoredProject(row), true);
  assert.deepEqual(row, original);
  assert.throws(() => normalizeProjectManifest({
    projectId, name: row.name, entries: row.entries, defaultEntry: row.default_entry,
  }), /unsupported fields/);
});

test("stored project reads still reject unsupported types, fields, identities, defaults and unsafe paths", () => {
  const row = { id: projectId, name: "Invalid project", entries: [entry], default_entry: "main" };
  for (const invalid of [
    { entries: null },
    { entries: [] },
    { entries: [null] },
    { entries: [{ ...entry, type: "conversation", databases: [] }] },
    { entries: [{ ...entry, unknown: [] }] },
    { entries: [{ ...entry, root: "../outside" }] },
    { entries: [entry, entry] },
    { id: "invalid-id" },
    { default_entry: null },
    { default_entry: "missing" },
  ]) {
    assert.equal(isSupportedStoredProject({ ...row, ...invalid }), false);
    assert.throws(() => readStoredProjectManifest({ ...row, ...invalid }), error => {
      assert.ok(error instanceof InvalidStoredProjectError);
      assert.equal(error.projectId, invalid.id ?? projectId);
      assert.ok(error.cause instanceof Error);
      return true;
    });
  }
});

test("project lists isolate unsupported records and propagate database and metadata failures", async () => {
  const db = new DatabaseRepository("postgresql://unused:unused@127.0.0.1:1/unused");
  const current = {
    id: projectId, name: "Current", entries: [entry], default_entry: "main",
    project_info: {}, project_card: null, package_version: "1.0.0", has_draft: false,
    latest_version: null, created_at: new Date(), updated_at: new Date(),
  };
  const legacy = {
    ...current, id: "00000000-0000-4000-8000-000000000202", name: "Existing",
    entries: [{ ...entry, databases: [], knowledgeBases: [] }],
  };
  let rows: unknown[] = [
    { ...current, entries: [{ ...entry, type: "conversation" }] },
    { ...current, entries: [] }, legacy, current,
  ];
  let failure: Error | undefined;
  const pool = Reflect.get(db, "pool") as { query: () => Promise<{ rows: unknown[] }> };
  pool.query = async () => {
    if (failure) throw failure;
    return { rows };
  };
  try {
    assert.deepEqual((await db.listProjects()).map(project => project.id), [legacy.id, current.id]);
    assert.deepEqual((await db.listProjects())[0]!.entries, [entry]);
    rows = [legacy];
    assert.deepEqual((await db.getProject(legacy.id))!.entries, [entry]);
    rows = [{ ...current, entries: [{ ...entry, type: "conversation" }] }];
    await assert.rejects(db.getProject(current.id), InvalidStoredProjectError);
    rows = [{ ...current, project_info: { platformSupport: { mode: "invalid" } } }];
    await assert.rejects(db.listProjects());
    failure = new Error("Database connection failed.");
    await assert.rejects(db.listProjects(), error => error === failure);
  } finally { await db.close(); }
});
