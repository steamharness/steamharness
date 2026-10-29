import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { MemoryStore } from "../store.js";
import { extract, type Turn } from "../extract.js";

test("extraction bounds all scenes and UTF-8 payloads, deduplicates sources and rejects assistant evidence", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "memory-extract-"));
  const store = new MemoryStore(root, "server:account");
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const old = { ...process.env };
  t.after(() => {
    for (const key of ["STEAMHARNESS_MEMORY_MODEL_BASE_URL", "STEAMHARNESS_MEMORY_MODEL_API_KEY", "STEAMHARNESS_MEMORY_MODEL"])
      if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
  });
  let content = "项目约定";
  const server = createServer((_req, res) => {
    const memory = (id: number) => ({ content: content + id, type: "instruction", source_message_ids: ["u", "u"] });
    const scenes = [null, { memories: [
      null,
      { content: "Unsupported assistant claim", source_message_ids: ["a"] },
      ...Array.from({ length: 15 }, (_, i) => memory(i)),
    ] }, { memories: Array.from({ length: 15 }, (_, i) => memory(i + 15)) }];
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(scenes) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.STEAMHARNESS_MEMORY_MODEL_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.STEAMHARNESS_MEMORY_MODEL_API_KEY = "test-only";
  process.env.STEAMHARNESS_MEMORY_MODEL = "test-extractor";
  const turn: Turn = { turnId: "t", scope: "project:p", messages: [
    { id: "u", role: "user", content: "中文来源", timestamp: 1 },
    { id: "a", role: "assistant", content: "Unsupported claim", timestamp: 2 },
  ] };
  const candidates = await extract(store, turn);
  assert.equal(candidates.length, 20);
  assert.ok(candidates.every(c => c.sources.length === 1 && c.sources[0].id === "u"));
  assert.ok(candidates.every(c => c.scope === "project:p"));
  assert.ok(Buffer.byteLength(JSON.stringify(candidates)) < 220000);
  content = "中文".repeat(7000);
  const large = await extract(store, { ...turn, messages: [{ ...turn.messages[0], content: "中文来源".repeat(2000) }] });
  assert.ok(large.length > 0 && large.length < 20);
  assert.ok(Buffer.byteLength(JSON.stringify({ method: "apply", account: "server:account", operation: {
    operationId: "job:t", action: "extract", scope: "project:p", expected: store.state("project:p"), candidates: large,
  } })) < 300000);
});
