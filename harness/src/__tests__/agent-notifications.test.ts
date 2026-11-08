import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import * as ai from "@earendil-works/pi-ai";
import { createRegistry, Harness, InboxDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { deferAgentNotifications, deliverAgentNotifications, submitAgentNotification } from "../agent/notifications";

async function fixture(t: test.TestContext) {
  const faux = ai.fauxProvider({ models: [{ id: "test", contextWindow: 100_000, maxTokens: 100 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), settings: { retry: { enabled: false }, compaction: { enabled: false } } }, context);
  t.after(() => harness.close(context));
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "test" } } });
  const input = (requestId: string) => root.submit({ type: "input", content: requestId, requestId,
    entry: { kind: "project.input", data: { requestId } } }, context);
  const notice = (requestId: string, content: string, key = "batch") => root.commit(tx => submitAgentNotification(tx, root.id, { requestId, key, content }), context);
  return { faux, models, harness, root, input, notice };
}
function hold(models: ai.Models) {
  const source = ai.createAssistantMessageEventStream();
  models.streamSimple = (_model, _context, options) => {
    const abort = () => {
      const message = ai.fauxAssistantMessage([], { stopReason: "aborted" });
      source.push({ type: "error", reason: "aborted", error: message }); source.end(message);
    };
    if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener("abort", abort, { once: true });
    return source;
  };
}

test("failed parents retain the latest background result without buying another model retry budget", async t => {
  const f = await fixture(t);
  f.faux.setResponses([ai.fauxAssistantMessage([], { stopReason: "error", errorMessage: "API error (503): Service temporarily unavailable" })]);
  assert.equal((await (await f.input("original")).wait(context)).status, "unanswered");
  const first = await f.notice("progress:1", "Batch 1/3");
  assert.equal(first.status, "deferred");
  assert.equal((await f.notice("progress:3", "Batch 3/3")).status, "deferred");
  assert.deepEqual(await f.notice("progress:1", "Batch 1/3"), { ...first, status: "duplicate" });
  assert.equal(f.faux.state.callCount, 1);
  assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  await f.root.commit(async tx => { await deferAgentNotifications(tx, f.root.id); await deliverAgentNotifications(tx, f.root.id); }, context);
  f.faux.setResponses([request => {
    const text = JSON.stringify(request.messages);
    assert.match(text, /Batch 3\/3/); assert.doesNotMatch(text, /Batch 1\/3/);
    return ai.fauxAssistantMessage("Resumed from saved results");
  }]);
  assert.equal((await (await f.input("continue")).wait(context)).status, "done");
  assert.equal(f.faux.state.callCount, 2);
});

test("busy parents coalesce pending progress and consume it at the next tool boundary", async t => {
  const f = await fixture(t);
  hold(f.models);
  await f.input("original");
  const first = await f.notice("progress:1", "Batch 1/3");
  const last = await f.notice("progress:3", "Batch 3/3");
  assert.equal(first.status, "queued"); assert.equal(last.status, "queued");
  const inbox = await f.harness.snapshot(InboxDoc, f.root.id, context);
  assert.equal(inbox!.items.length, 1); assert.equal(inbox!.items[0]!.mode, "steer");
  assert.equal("content" in inbox!.items[0]! && inbox!.items[0]!.content, "Batch 3/3");
  const previous = await f.root.commit(tx => tx.submissionByRequest(f.root.id, "progress:1"), context);
  assert.equal(previous!.status, "unanswered"); assert.equal(previous!.reason, "superseded");
});

test("explicit continuation folds queued notifications into context and leaves paused user inputs alone", async t => {
  const f = await fixture(t);
  hold(f.models);
  await f.input("original");
  await f.notice("batch-a:1", "Batch A complete", "a");
  await f.notice("batch-b:1", "Batch B needs input", "b");
  await f.root.submit({ type: "input", content: "Keep this queued user request", requestId: "user-queued", whenBusy: "followUp" }, context);
  await f.root.commit(tx => deferAgentNotifications(tx, f.root.id), context);
  const inbox = await f.harness.snapshot(InboxDoc, f.root.id, context);
  assert.equal(inbox!.items.length, 1);
  assert.equal("content" in inbox!.items[0]! && inbox!.items[0]!.content, "Keep this queued user request");
  await f.root.commit(tx => deliverAgentNotifications(tx, f.root.id), context);
  const view = await f.root.context(context);
  assert.match(JSON.stringify(view.messages), /Batch A complete/); assert.match(JSON.stringify(view.messages), /Batch B needs input/);
  assert.equal(await f.root.commit(tx => deliverAgentNotifications(tx, f.root.id), context), false);
});

test("notification admission rejects changed request content and cannot revive an explicitly stopped parent", async t => {
  const f = await fixture(t);
  hold(f.models);
  await f.input("original");
  await f.root.abort(context, { background: true }); await f.root.waitForIdle(context);
  assert.equal((await f.notice("finished", "Saved result")).status, "deferred");
  await assert.rejects(f.notice("finished", "Changed result"), /requestId/);
  assert.equal((await f.harness.inspect(context)).tasks.length, 0);
});

test("legacy queued reports fold into continuation and preserve previously admitted request identities", async t => {
  const f = await fixture(t); hold(f.models); await f.input("original");
  await f.root.submit({ type: "input", content: "Previously saved batch result", requestId: "legacy-report", whenBusy: "followUp",
    entry: { kind: "project.child-result", data: { requestId: "legacy-report", mode: "report" } } }, context);
  assert.equal((await f.root.commit(tx => submitAgentNotification(tx, f.root.id, { key: "batch", requestId: "legacy-report", content: "Previously saved batch result", kind: "project.child-result" }), context)).status, "duplicate");
  await f.root.commit(async tx => { await deferAgentNotifications(tx, f.root.id); await deliverAgentNotifications(tx, f.root.id); }, context);
  assert.equal((await f.harness.snapshot(InboxDoc, f.root.id, context))!.items.length, 0);
  assert.match(JSON.stringify((await f.root.context(context)).messages), /Previously saved batch result/);
});
