import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { MemoryStore } from "../store.js";

test("online snapshots restore WAL content, receipts and forgotten-source suppression", () => {
  const root = mkdtempSync(path.join(tmpdir(), "memory-snapshot-"));
  const live = new MemoryStore(path.join(root, "live"), "instance:account");
  let restored: MemoryStore | undefined;
  try {
    const remember = { operationId: "manual", action: "remember" as const, scope: "global" as const, content: "跨会话保存的中文偏好" };
    const item = live.apply(remember);
    live.apply({ operationId: "auto", action: "extract", scope: "global", expected: live.state("global"), candidates: [{ scope: "global", content: "Forgotten fact", sources: [{ id: "message:u", role: "user", content: "Original user evidence" }] }] });
    const forgotten = live.list(["global"]).items.find(i => i.content === "Forgotten fact")!;
    live.apply({ operationId: "forget", action: "forget", scope: "global", id: forgotten.id });
    const backup = path.join(root, "backup");
    execFileSync(process.execPath, [fileURLToPath(new URL("../../scripts/snapshot.mjs", import.meta.url)), path.join(root, "live"), backup], { stdio: "pipe" });
    restored = new MemoryStore(backup, "instance:account");
    assert.deepEqual(restored.apply(remember), item);
    assert.equal(restored.recall(["global"], "中文偏好")[0]?.content, remember.content);
    restored.apply({ operationId: "retry-auto", action: "extract", scope: "global", expected: restored.state("global"), candidates: [{ scope: "global", content: "Rephrased forgotten fact", sources: [{ id: "message:u", role: "user", content: "Original user evidence" }] }] });
    assert.equal(restored.list(["global"]).items.length, 1);
    assert.throws(() => restored!.get(forgotten.id, ["global"]), /not found/);
  } finally {
    restored?.close();
    live.close();
    rmSync(root, { recursive: true, force: true });
  }
});
