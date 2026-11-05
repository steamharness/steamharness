import assert from "node:assert/strict";
import test from "node:test";
import { retryAgentTool } from "../agent/tool-retry";

for (const replay of [undefined, "unsafe", "never"]) test(`an unknown ${replay ?? "default"} tool result is never replayed`, async () => {
  let calls = 0;
  const failure = new Error("Write outcome unknown");
  await assert.rejects(retryAgentTool({ replay, delayMs: 0, before: async () => {}, execute: async () => { calls++; throw failure; } }), error => error === failure);
  assert.equal(calls, 1);
});

test("safe tool retries exhaust a bounded budget and retain the original failure", async () => {
  let calls = 0, checks = 0; const failure = new Error("Read unavailable");
  await assert.rejects(retryAgentTool({ replay: "safe", delayMs: 0, before: async () => { checks++; }, execute: async () => { calls++; throw failure; } }), error => error === failure);
  assert.equal(calls, 4); assert.equal(checks, 4);
});

test("a denied retry rechecks current authorization and does not execute again", async () => {
  let calls = 0, checks = 0;
  const blocked = { isError: true, details: "Access revoked" };
  const result = await retryAgentTool({ replay: "safe", delayMs: 0, before: async () => ++checks === 2 ? blocked : undefined,
    execute: async () => { calls++; throw new Error("Temporary failure"); } });
  assert.equal(result, blocked); assert.equal(calls, 1);
});

test("explicit non-retryable results and host storage failures keep their recovery barriers", async () => {
  for (const barrier of ["result", "storage", "permission", "input"] as const) {
    let calls = 0; const failure = Object.assign(new Error("Unrecoverable"),
      barrier === "permission" ? { status: 403 } : barrier === "input" ? { type: "input_validation" } : {});
    const result = retryAgentTool({ replay: "safe", delayMs: 0, before: async () => {}, canRetry: () => barrier !== "storage", execute: async () => {
      calls++; if (barrier === "result") return { isError: true, details: { retryable: false } }; throw failure;
    } });
    if (barrier === "result") assert.equal((await result).isError, true); else await assert.rejects(result, error => error === failure);
    assert.equal(calls, 1);
  }
});

test("Stop interrupts tool retry backoff without another tool invocation", async () => {
  const abort = new AbortController(); let calls = 0;
  const running = retryAgentTool({ replay: "safe", signal: abort.signal, delayMs: 1000, before: async () => {}, execute: async () => {
    calls++; queueMicrotask(() => abort.abort()); throw new Error("Temporary read failure");
  } });
  await assert.rejects(running, { name: "AbortError" }); assert.equal(calls, 1);
});
