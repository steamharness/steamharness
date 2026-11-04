import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRuntimeStateStorage } from "../runtime-storage/state";
import { emptyRuntimeRecord } from "../runtime-storage/history";

test("standalone runtime history lives outside source and survives rebuilding dist", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sdk-external-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.method(os, "homedir", () => path.join(directory, "user"));
  const source = path.join(directory, "source"); await mkdir(path.join(source, "dist"), { recursive: true });
  const options = { projectId: "00000000-0000-4000-8000-000000000001", entryId: "agent", rootDir: source, runId: "test" };
  const first = createRuntimeStateStorage(options);
  const lease = await first.persistence.acquire("test", () => undefined);
  await lease.write(emptyRuntimeRecord("state", "conversation", "test"));
  await lease.close(); await first.close();
  await rm(path.join(source, "dist"), { recursive: true }); await mkdir(path.join(source, "dist"));
  const reopened = createRuntimeStateStorage(options);
  assert.equal((await reopened.persistence.list("state"))[0]?.key, "conversation");
  await reopened.close();
  assert.deepEqual(await readdir(source), ["dist"]);
  assert.ok((await readdir(path.join(directory, "user/.steamharness/runtime", options.projectId, "agent"))).includes("history.sqlite"));
});
