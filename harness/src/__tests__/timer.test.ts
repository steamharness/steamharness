import { createTestResources } from "./entry-test-resources";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDisabledProjectConversationContext,
  createDisabledProjectTokenUsageContext,
  createTimerNode,
  endTimer,
  type RuntimeEvent,
} from "../index";
import { analyzeProjectScriptSource } from "../executor/rules";
import { createProjectRuntime } from "../executor/runtime";
import type { KVContext } from "../kv/index";
import { runNode } from "../workflow/index";
import type { RunContext } from "../types/index";

test("timer node starts and endTimer finishes a business timer", async () => {
  const events: RuntimeEvent[] = [];
  const runtime = createProjectRuntime({
    projectName: "timer-workflow",
    runId: "run-timer",
    onRuntimeEvent(event) {
      events.push(event);
    },
  });
  const context = {
    ...createTestProjectContext(runtime.timers),
    nodeHooks: runtime.runtimeNodeHooks,
  };
  const timerNode = createTimerNode({ title: "业务阶段" });

  await runtime.start();
  const timer = await runNode(timerNode, { timerId: "phase-1", metadata: { phase: 1 } }, context);
  const finished = await endTimer(timer, context, { message: "done" });
  const report = await runtime.finish({
    result: { ok: true, data: { errCode: 0, errMessage: "" } },
  });

  assert.equal(timer.errCode, 0);
  assert.equal(timer.timerId, "phase-1");
  assert.equal(finished.status, "success");
  assert.equal(finished.message, "done");
  assert.equal(typeof finished.durationMs, "number");
  assert.deepEqual(report.timers?.map((item) => item.status), ["success"]);
  assert.deepEqual(events.map((event) => event.type), [
    "project_started",
    "node_started",
    "timer_started",
    "node_finished",
    "timer_finished",
    "project_succeeded",
  ]);
});

test("endTimer supports failed status and rejects duplicate finish", async () => {
  const runtime = createProjectRuntime({ projectName: "timer-failed" });
  const context = createTestProjectContext(runtime.timers);
  const timer = await runNode(createTimerNode(), { timerId: "phase-failed" }, context);

  const failed = await endTimer(timer, context, {
    status: "failed",
    message: "provider failed",
  });

  assert.equal(failed.status, "failed");
  assert.equal(failed.message, "provider failed");
  await assert.rejects(
    () => endTimer(timer, context),
    /already finished with status "failed"/,
  );
});

test("runtime finish clears running timers before terminal report", async () => {
  const events: RuntimeEvent[] = [];
  const runtime = createProjectRuntime({
    projectName: "timer-fixture",
    runId: "run-clear",
    onRuntimeEvent(event) {
      events.push(event);
    },
  });

  await runtime.start();
  await runtime.timers.start({ timerId: "unclosed", title: "Unclosed timer" });
  const report = await runtime.finish({
    result: { ok: false, error: { type: "execution", message: "boom" } },
  });

  assert.equal(report.status, "failed");
  assert.equal(report.timers?.[0]?.status, "cleared");
  assert.notEqual(report.timers?.[0]?.endedAt, undefined);
  assert.equal(report.timers?.some((timer) => timer.status === "running"), false);
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("timer_")).map((event) => event.type),
    ["timer_started", "timer_finished"],
  );
});

test("workflow structure recognizes timer node and endTimer API call", () => {
  const analysis = analyzeProjectScriptSource(`
    const timerNode = steamharness.createTimerNode({
      name: "timer",
      title: "业务阶段",
    });
    const outputNode = steamharness.createOutputNode({
      name: "output",
      format() {
        return { errCode: 0, errMessage: "", items: [] };
      },
    });

    export const demo = steamharness.defineProject({
      name: "demo",
      async run(input, context) {
        const timer = await steamharness.runNode(timerNode, undefined, context);
        await steamharness.endTimer(timer, context);
        return steamharness.runNode(outputNode, input, context);
      },
    });
  `);

  assert.equal(analysis.structureNodes[0]?.factory, "createTimerNode");
  assert.equal(analysis.structureNodes[0]?.standardName, "timer");
  assert.equal(analysis.structureApiCalls.some((call) => call.method === "endTimer"), true);
});

function createTestProjectContext(timers: RunContext["timers"]): RunContext {
  const kv = createMemoryKVContext();
  return {
    config: {},
    providers: {},
    ...createTestResources(),
    conversation: createDisabledProjectConversationContext(),
    tokenUsage: createDisabledProjectTokenUsageContext(),
    timers,
  };
}

function createMemoryKVContext(): KVContext {
  const values = new Map<string, unknown>();

  function createNamespace(prefix: string) {
    return {
      async getValue(key: string) {
        return values.get(`${prefix}:${key}`);
      },
      async setValue(key: string, value: unknown) {
        values.set(`${prefix}:${key}`, value);
      },
      async deleteValue(key: string) {
        return values.delete(`${prefix}:${key}`);
      },
      async updateValue(key: string, updater: (current: unknown | undefined) => unknown) {
        const next = updater(values.get(`${prefix}:${key}`));
        values.set(`${prefix}:${key}`, next);
        return next;
      },
    };
  }

  const project = createNamespace("project");

  return {
    getValue: project.getValue,
    setValue: project.setValue,
    deleteValue: project.deleteValue,
    updateValue: project.updateValue,
    conversation: createNamespace("conversation"),
  };
}
