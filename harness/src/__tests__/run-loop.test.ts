import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProjectScriptSource } from "../executor/rules";
import {
  createDisabledProjectConversationContext,
  createDisabledProjectTokenUsageContext,
  createProjectRelatedProjectsContext,
  type KVContext,
} from "../index";
import { runFor, runWhile } from "../workflow/index";
import type { NodeExecutionHookFinishEvent, RunContext } from "../types/index";

test("runFor iterates items and emits loop node hooks", async () => {
  const finishes: NodeExecutionHookFinishEvent[] = [];
  const context = createTestProjectContext({
    onFinish(event) {
      finishes.push(event);
    },
  });

  const result = await runFor({ total: 0 }, context, {
    name: "Accumulate items",
    items: () => [1, 2, 3],
    run: (state, item) => ({ total: state.total + item }),
  });

  assert.deepEqual(result, { total: 6 });
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0]?.kind, "branch-node");
  assert.equal(finishes[0]?.nodeName, "run-for");
  assert.equal(finishes[0]?.metadata?.title, "Accumulate items");
  assert.deepEqual(finishes[0]?.executionInfo, {
    loopType: "for",
    iterations: 3,
    iterationCount: 3,
    maxIterations: 1000,
    completed: true,
  });
});

test("runWhile iterates until condition fails", async () => {
  const result = await runWhile({ count: 0 }, createTestProjectContext(), {
    name: "Count while",
    condition: (state) => state.count < 3,
    run: (state) => ({ count: state.count + 1 }),
  });

  assert.deepEqual(result, { count: 3 });
});

test("runWhile fails when maxIterations is exceeded", async () => {
  await assert.rejects(
    () => runWhile(0, createTestProjectContext(), {
      name: "No exit",
      maxIterations: 2,
      condition: () => true,
      run: (value) => value + 1,
    }),
    /exceeded maxIterations/,
  );
});

test("workflow structure keeps runFor and runWhile bodies inside loop items", () => {
  const analysis = analyzeProjectScriptSource(`
    const stepNode = steamharness.createInputNode({
      name: "step",
      parse(input) {
        return input;
      },
    });

    const outputNode = steamharness.createOutputNode({
      name: "output",
      format(input) {
        return { errCode: 0, errMessage: "", content: String(input.count) };
      },
    });

    export const demo = steamharness.defineProject({
      name: "demo",
      async run(input, context) {
        const forResult = await steamharness.runFor({ count: 0 }, context, {
          name: "For loop",
          items: () => ["alpha", "beta"],
          async run(state, item, index, loopContext) {
            return steamharness.runNode(stepNode, { count: state.count + index + 1, item }, loopContext);
          },
        });

        const whileResult = await steamharness.runWhile(forResult, context, {
          name: "While loop",
          maxIterations: 3,
          condition: (state) => state.count < 5,
          async run(state, loopContext) {
            return steamharness.runIf(state, loopContext, {
              name: "While branch",
              branches: [
                {
                  label: "needs steps",
                  condition: (current) => current.count < 4,
                  async run(current, branchContext) {
                    return steamharness.runFor(current, branchContext, {
                      name: "Inner for",
                      items: () => [1],
                      async run(innerState, value, index, innerContext) {
                        return steamharness.runNode(stepNode, { ...innerState, count: innerState.count + value + index }, innerContext);
                      },
                    });
                  },
                },
              ],
              else: {
                label: "finish",
                async run(current, branchContext) {
                  return steamharness.runNode(stepNode, { ...current, count: current.count + 1 }, branchContext);
                },
              },
            });
          },
        });

        return steamharness.runNode(outputNode, whileResult, context);
      },
    });
  `);

  assert.equal(analysis.structureCalls.filter((call) => call.callee === "runFor").length, 2);
  assert.equal(analysis.structureCalls.filter((call) => call.callee === "runIf").length, 1);
  assert.equal(analysis.structureCalls.filter((call) => call.callee === "runWhile").length, 1);
  assert.equal(analysis.structureTrees.length, 1);

  const forLoop = analysis.structureTrees[0]?.children[0];
  assert.equal(forLoop?.kind, "loop");
  assert.equal(forLoop.source, "run-for");
  assert.equal(forLoop.children[0]?.kind, "call");

  const whileLoop = analysis.structureTrees[0]?.children[1];
  assert.equal(whileLoop?.kind, "loop");
  assert.equal(whileLoop.source, "run-while");
  assert.equal(whileLoop.maxIterations, 3);
  assert.equal(whileLoop.children[0]?.kind, "run-if");
  const whileBranch = whileLoop.children[0];
  assert.equal(whileBranch.branches[0]?.children[0]?.kind, "loop");
  const innerForLoop = whileBranch.branches[0]?.children[0];
  assert.equal(innerForLoop?.source, "run-for");
  assert.equal(innerForLoop.children[0]?.kind, "call");
  assert.equal(whileBranch.branches[1]?.children[0]?.kind, "call");
});

function createTestProjectContext(options: {
  onFinish?: (event: NodeExecutionHookFinishEvent) => void;
} = {}): RunContext {
  const kv = createMemoryKVContext();

  return {
    providers: {},
    storage: {
      local: { kv, persistentValue: createMemoryKVContext(), relatedProjects: createProjectRelatedProjectsContext() },
      server: { kv: createMemoryKVContext(), persistentValue: createMemoryKVContext(), relatedProjects: createProjectRelatedProjectsContext() },
    },
    conversation: createDisabledProjectConversationContext(),
    tokenUsage: createDisabledProjectTokenUsageContext(),
    nodeHooks: {
      onNodeFinish: options.onFinish,
    },
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
