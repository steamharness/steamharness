import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import { DurableAgentSession } from "../agent/session";
import type { AgentSessionSnapshot } from "../agent/session-types";

test("slow snapshot consumers coalesce commits and serialize explicit snapshots", { timeout: 5000 }, async t => {
  const storage = new MemoryStorage(), models = createModels(), registry = createRegistry();
  const harness = await Harness.open(storage, { models, registry }, context);
  const root = await harness.root(context);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let block = false, blocked = false, active = 0, maximum = 0;
  const frames: AgentSessionSnapshot[] = [], errors: unknown[] = [];
  const session = new DurableAgentSession(harness, root, {}, async frame => {
    maximum = Math.max(maximum, ++active);
    try { frames.push(frame); if (block) { blocked = true; await gate; } }
    finally { active--; }
  }, error => { errors.push(error); }, models, storage, registry, () => ({
    extensions: [], catalogs: [], codeMode: false, storage: "Memory",
    environment: { id: "local", label: "Local", state: "ready", remote: false },
  }));
  t.after(async () => { release(); await session.stop(); await harness.close(context); });
  session.install(registry);
  await session.start("Fixture");
  await new Promise(resolve => setTimeout(resolve, 120));
  block = true;
  await root.commit(tx => tx.appendEntry(root.id, { kind: "fixture.change", data: { index: 0 } }), context);
  for (let attempt = 0; !blocked && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(blocked, true);
  const count = frames.length;
  const explicit = session.emit();
  for (let index = 1; index <= 20; index++) {
    await root.commit(tx => tx.appendEntry(root.id, { kind: "fixture.change", data: { index } }), context);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.equal(frames.length, count, "A blocked consumer must not start another projection");
  block = false; release(); await explicit;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(maximum, 1);
  assert.ok(frames.length <= count + 2, `Expected one explicit and one latest update, received ${frames.length - count}`);
  assert.deepEqual(errors, []);
  assert.deepEqual(frames.map(frame => frame.revision), [...frames.map(frame => frame.revision)].sort((a, b) => a - b));
});
