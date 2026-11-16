import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { writeProjectFixture } from "../../scripts/test-project-fixture.mjs";
import {
  inspectLocalProjectStructure,
  readEntrypointOutput,
  runLocalProjectWithReport,
  type RuntimeEvent,
  type UserInputContext,
} from "../index";
import { testExecutionStorage } from "./runtime-test-storage";

test("entry pauses after streaming output and resumes the same request into either branch", async (t) => {
  const directory = await temporaryDirectory(t);
  const projectDir = await writeEntryFixture(directory, randomUUID(), `
    const introNode = steamharness.createOutputNode({ name: "intro", metadata: { title: "intro" }, async *stream() {
      yield steamharness.createOutputItemChunk({ type: "output_item_start", item: { id: "intro", title: "Output", content: "" } });
      yield steamharness.createOutputItemChunk({ type: "output_item_delta", itemId: "intro", contentDelta: "Before confirmation" });
      yield steamharness.createOutputItemChunk({ type: "output_item_end", itemId: "intro" });
    }, format() {
      return { errCode: 0, errMessage: "", items: [{ id: "intro", title: "Output", content: "Before confirmation" }] };
    }});
    const confirmationNode = steamharness.createUserInputNode({ name: "confirmation",
      params: [{ name: "approved", type: "boolean" }] });
    const timerNode = steamharness.createTimerNode({ title: "Confirmed work" });
    const decisionNode = steamharness.createOutputNode({ name: "decision-output", format(input) {
      return { ...input, items: [{ id: "decision", title: "Output", content: String(input.approved) }] };
    }});
    const flow = steamharness.defineProject({ name: "runtime-contract", async run(input, context) {
      await steamharness.runStreamNode(introNode, input, context);
      const answer = await steamharness.runNode(confirmationNode, input, context);
      if (answer.values.approved) {
        const running = await steamharness.runNode(timerNode, {}, context);
        await steamharness.endTimer(running, context);
      }
      return steamharness.runNode(decisionNode, { errCode: 0, errMessage: "", approved: answer.values.approved }, context);
    }});
    export const executor = steamharness.defineExecutor({ projectType: "workflow", defaultEntrypoint: "main",
      entrypoints: [steamharness.defineEntrypoint({ id: "main", title: "Main", workflow: flow,
        createInput() { return { errCode: 0, errMessage: "" }; } })] });
  `);
  const events: RuntimeEvent[] = [];
  assert.deepEqual(inspectLocalProjectStructure({ projectDir }).diagnostics.violations, []);
  const options = { projectDir, projectName: "runtime-contract", runId: "resume-contract", storage: testExecutionStorage() };
  const waiting = await runLocalProjectWithReport({ ...options,
    userInput: { getResolvedInput() { return undefined; }, requestInput() {} },
    onRuntimeEvent: event => { events.push(event); },
  });
  assert.equal(waiting.status, "waiting_for_input", JSON.stringify(waiting.result));
  assert.equal(waiting.pendingUserInput?.requestId, "runtime-contract:resume-contract:confirmation");
  assert.deepEqual(waiting.pendingUserInput?.params.map(param => param.name), ["approved"]);
  assert.ok(events.some(event => event.type === "node_chunk"));
  assert.match(JSON.stringify(waiting.outputs), /Before confirmation/);
  assert.equal(waiting.timers?.length ?? 0, 0);

  const requestId = waiting.pendingUserInput!.requestId;
  const submittedAt = new Date("2026-11-05T00:00:00.000Z");
  for (const approved of [true, false]) {
    const resumedEvents: RuntimeEvent[] = [];
    const resumed = await runLocalProjectWithReport({ ...options,
      userInput: { __projectResumeRuntimeEventAfterRequestId: requestId,
        getResolvedInput(id) {
          assert.equal(id, requestId);
          return { requestId, nodeName: "confirmation", values: { approved }, submittedAt };
        },
        requestInput() { assert.fail("A resolved request must not be requested again"); },
      } as UserInputContext & { __projectResumeRuntimeEventAfterRequestId: string },
      onRuntimeEvent: event => { resumedEvents.push(event); },
    });
    assert.equal(resumed.runId, waiting.runId);
    assert.equal(resumed.status, "success", JSON.stringify(resumed.result));
    assert.equal(resumed.pendingUserInput, undefined);
    assert.equal(resumed.resolvedUserInputs?.[0]?.requestId, requestId);
    assert.deepEqual(resumed.resolvedUserInputs?.[0]?.values, { approved });
    assert.deepEqual(resumed.resolvedUserInputs?.[0]?.submittedAt, submittedAt);
    assert.ok(resumedEvents.some(event => event.type === "user_input_resolved"));
    assert.equal(resumedEvents.some(event => event.type === "node_chunk" && event.metadata?.title === "intro"), false);
    assert.equal(resumed.result.ok, true);
    if (resumed.result.ok) {
      const output = readEntrypointOutput(resumed.result.data) as { approved: boolean; errCode: number };
      assert.equal(output.approved, approved, JSON.stringify(resumed.result));
      assert.equal(output.errCode, 0);
    }
    assert.deepEqual(resumed.timers?.map(timer => timer.status) ?? [], approved ? ["success"] : []);
  }
});

test("cancelling a streaming entry interrupts in-flight work and emits a terminal report", { timeout: 5000 }, async (t) => {
  const directory = await temporaryDirectory(t);
  const projectDir = await writeEntryFixture(directory, randomUUID(), `
    const stream = { name: "in-flight", async *stream(input, context) {
      yield "started";
      await new Promise((resolve, reject) => {
        const stop = () => reject(context.abortSignal.reason);
        if (context.abortSignal.aborted) stop();
        else context.abortSignal.addEventListener("abort", stop, { once: true });
      });
      yield "must not finish";
    }};
    const flow = steamharness.defineProject({ name: "cancel-contract", async run(input, context) {
      await steamharness.runStreamNode(stream, input, context);
      return { errCode: 0, errMessage: "" };
    }});
    export const executor = steamharness.defineExecutor({ projectType: "workflow", defaultEntrypoint: "main",
      entrypoints: [steamharness.defineEntrypoint({ id: "main", title: "Main", workflow: flow, createInput() { return {}; } })] });
  `);
  const abort = new AbortController(), events: RuntimeEvent[] = [];
  const report = await runLocalProjectWithReport({ projectDir, storage: testExecutionStorage(), abortSignal: abort.signal,
    onRuntimeEvent(event) {
      events.push(event);
      if (event.type === "node_chunk") queueMicrotask(() => abort.abort(new Error("Cancelled in flight")));
    },
  });
  assert.equal(report.status, "aborted", JSON.stringify(report.result));
  assert.equal(report.pendingUserInput, undefined);
  assert.ok(events.some(event => event.type === "node_chunk"));
  assert.equal(events.at(-1)?.type, "project_aborted");
  assert.equal(events.some(event => event.type === "project_succeeded"), false);
});

async function temporaryDirectory(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "steamharness-entry-contract-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeEntryFixture(directory: string, projectId: string, source: string) {
  await mkdir(directory, { recursive: true });
  await writeProjectFixture(path.join(directory, "package.json"), JSON.stringify({
    id: projectId, name: "runtime-contract", version: "0.1.0", type: "module", defaultEntry: "main",
    entries: [{ entryId: "main", name: "main", type: "workflow", root: ".", entry: "index.ts" }],
  }));
  await writeFile(path.join(directory, "index.ts"), source);
  return directory;
}
