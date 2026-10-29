import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore, type MemoryItem } from "../store.js";
function fixture(fn: (a: MemoryStore, b: MemoryStore, root: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "memory-test-"));
  const a = new MemoryStore(root, "server-a:user-a"),
    b = new MemoryStore(root, "server-a:user-b");
  try {
    fn(a, b, root);
  } finally {
    a.close();
    b.close();
    rmSync(root, { recursive: true, force: true });
  }
}
const remember = (s: MemoryStore, id: string, scope: any, content: string) =>
  s.apply({
    operationId: id,
    action: "remember",
    scope,
    content,
  }) as MemoryItem;
test("Chinese and English FTS work without embedding; account and server files remain isolated", () =>
  fixture((a, b, root) => {
    remember(a, "a", "global", "用户偏好使用中文进行交流。");
    remember(a, "b", "global", "Prefer concise English responses.");
    assert.equal(
      a.recall(["global"], "中文交流")[0].content,
      "用户偏好使用中文进行交流。",
    );
    assert.equal(a.recall(["global"], "concise English").length, 1);
    assert.equal(b.recall(["global"], "中文 English").length, 0);
    const other = new MemoryStore(root, "server-b:user-a");
    try {
      assert.deepEqual(other.list(["global"]).items, []);
    } finally {
      other.close();
    }
  }));
test("scope filtering happens before BM25 LIMIT, even with hundreds of other-project hits", () =>
  fixture((a) => {
    for (let i = 0; i < 150; i++)
      remember(
        a,
        "other" + i,
        "project:other",
        "postgres database migration postgres " + i,
      );
    remember(a, "target", "project:target", "database migration");
    assert.equal(
      a.recall(["project:target"], "postgres database migration")[0]?.scope,
      "project:target",
    );
    assert.equal(
      a.list(["project:target"], { query: "migration", pageSize: 1 }).items
        .length,
      1,
    );
    assert.throws(
      () => a.get(a.list(["project:other"]).items[0].id, ["global"]),
      /not found/,
    );
  }));
test("operation receipts survive restart, reject changed payloads, and preserve optimistic edits", () =>
  fixture((a, _b, root) => {
    const item = remember(a, "stable", "global", "First");
    assert.deepEqual(remember(a, "stable", "global", "First"), item);
    assert.throws(() => remember(a, "stable", "global", "Changed"), /reused/);
    const other = new MemoryStore(root, "server-a:user-a");
    try {
      assert.deepEqual(remember(other, "stable", "global", "First"), item);
    } finally {
      other.close();
    }
    a.apply({
      operationId: "edit",
      action: "update",
      scope: "global",
      id: item.id,
      content: "Edited",
      version: 1,
    });
    assert.throws(
      () =>
        a.apply({
          operationId: "stale",
          action: "update",
          scope: "global",
          id: item.id,
          content: "Lost",
          version: 1,
        }),
      /changed/,
    );
    assert.equal(a.get(item.id, ["global"]).content, "Edited");
  }));
test("manual edits, forgetting and clearing cannot be undone by an older extraction", () =>
  fixture((a) => {
    const state = a.state("project:p");
    const old = remember(a, "manual", "project:p", "Manual decision");
    const result = a.apply({
      operationId: "auto-old",
      action: "extract",
      scope: "project:p",
      expected: state,
      candidates: [
        { scope: "project:p", content: "Old decision", sources: [] },
      ],
    });
    assert.equal(result.discarded, true);
    const fresh = a.state("project:p");
    a.apply({ operationId: "clear", action: "clear", scope: "project:p" });
    assert.equal(
      a.apply({
        operationId: "auto-clear",
        action: "extract",
        scope: "project:p",
        expected: fresh,
        candidates: [
          { scope: "project:p", content: "Old decision", sources: [] },
        ],
      }).discarded,
      true,
    );
    assert.deepEqual(a.list(["project:p"]).items, []);
    assert.equal(a.state("project:p").generation, fresh.generation + 1);
    assert.throws(() => a.get(old.id, ["project:p"]), /not found/);
  }));
test("source suppression prevents regeneration and explicit remembering takes effect immediately", () =>
  fixture((a) => {
    a.apply({
      operationId: "extract",
      action: "extract",
      scope: "global",
      expected: a.state("global"),
      candidates: [
        {
          scope: "global",
          content: "Lasting preference",
          sources: [
            { id: "turn:u", role: "user", content: "Please remember this." },
          ],
        },
      ],
    });
    const item = a.list(["global"]).items[0];
    a.apply({
      operationId: "forget",
      action: "forget",
      scope: "global",
      id: item.id,
    });
    a.apply({
      operationId: "later-extract",
      action: "extract",
      scope: "global",
      expected: a.state("global"),
      candidates: [
        {
          scope: "global",
          content: "Paraphrased preference",
          sources: [
            { id: "turn:u", role: "user", content: "Please remember this." },
          ],
        },
      ],
    });
    assert.equal(a.list(["global"]).items.length, 0);
    const explicit = remember(a, "explicit", "global", "Lasting preference");
    assert.equal(a.get(explicit.id, ["global"]).origin, "manual");
  }));
test("cursor pages are stable and FTS syntax is inert", () =>
  fixture((a) => {
    for (let i = 0; i < 8; i++) remember(a, "page" + i, "global", "entry " + i);
    const first = a.list(["global"], { pageSize: 3 }),
      second = a.list(["global"], { pageSize: 3, cursor: first.nextCursor });
    assert.equal(first.items.length, 3);
    assert.equal(second.items.length, 3);
    assert.equal(
      new Set([...first.items, ...second.items].map((i) => i.id)).size,
      6,
    );
    assert.doesNotThrow(() => a.recall(["global"], '" OR NOT * NEAR('));
  }));

test("account namespaces and operation payloads are case sensitive; deleted receipt replays disclose no text", () =>
  fixture((a, _b, root) => {
    const upper = new MemoryStore(root, "server-a:USER-A");
    try {
      remember(upper, "case", "global", "Upper account");
      assert.equal(a.list(["global"]).items.length, 0);
    } finally {
      upper.close();
    }
    const item = remember(a, "case-sensitive", "global", "Keep Case");
    assert.throws(
      () => remember(a, "case-sensitive", "global", "keep case"),
      /reused/,
    );
    const operation = {
      operationId: "forget-retry",
      action: "forget" as const,
      scope: "global" as const,
      id: item.id,
    };
    assert.deepEqual(a.apply(operation), a.apply(operation));
    assert.equal(a.locate(item.id, ["global"]).scope, "global");
    const replay = remember(a, "case-sensitive", "global", "Keep Case") as any;
    assert.equal(replay.deleted, true);
    assert.equal("content" in replay, false);
  }));
test("L0 staging survives retries and keeps the original generation across a clear", () =>
  fixture((a) => {
    const turn = {
      turnId: "durable-turn",
      scope: "project:p" as const,
      messages: [
        { id: "u", role: "user", content: "中文事实", timestamp: 1 },
        { id: "a", role: "assistant", content: "好的", timestamp: 2 },
      ],
    };
    const states = a.stageTurn(turn);
    a.apply({ operationId: "clear-turn", action: "clear", scope: "project:p" });
    assert.deepEqual(
      a.stageTurn({
        ...turn,
        messages: turn.messages.map((m) => ({ ...m, timestamp: 99 })),
      }),
      states,
    );
    assert.equal(a.getTurn(turn.turnId).messages[0].content, "中文事实");
    assert.throws(
      () =>
        a.stageTurn({
          ...turn,
          messages: [{ ...turn.messages[0], content: "Changed" }],
        }),
      /reused/,
    );
    a.completeTurn(turn.turnId);
    assert.throws(() => a.getTurn(turn.turnId), /not found/);
    assert.deepEqual(a.stageTurn(turn), states);
  }));
test("malformed cursors and page sizes fail as validation errors", () =>
  fixture((a) => {
    for (const cursor of [
      "bad",
      Buffer.from("{}").toString("base64url"),
      Buffer.from("null").toString("base64url"),
    ])
      assert.throws(() => a.list(["global"], { cursor }), /cursor/);
    for (const pageSize of [0, -1, NaN, 1.5, 101])
      assert.throws(() => a.list(["global"], { pageSize }), /page size/);
  }));
