import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProjectScriptSource } from "../executor/rules";
import {
  createDisabledProjectConversationContext,
  createDisabledProjectTokenUsageContext,
  createProjectRelatedProjectsContext,
  type KVContext,
} from "../index";
import { runIf } from "../workflow/index";
import type { NodeExecutionHookFinishEvent, RunContext } from "../types/index";

test("runIf selects elseif branches and emits branch node hooks", async () => {
  const finishes: NodeExecutionHookFinishEvent[] = [];
  const context = createTestProjectContext({
    onFinish(event) {
      finishes.push(event);
    },
  });

  const result = await runIf({ score: 8 }, context, {
    name: "Score branch",
    branches: [
      {
        label: "low score",
        condition: (input) => input.score < 3,
        run: () => "low",
      },
      {
        label: "high score",
        description: "score is high enough",
        condition: (input) => input.score >= 7,
        run: () => "high",
      },
    ],
    else: {
      label: "middle score",
      run: () => "middle",
    },
  });

  assert.equal(result, "high");
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0]?.kind, "branch-node");
  assert.equal(finishes[0]?.nodeName, "run-if");
  assert.equal(finishes[0]?.metadata?.title, "Score branch");
  assert.deepEqual(finishes[0]?.executionInfo, {
    branch: "high score",
    branchIndex: 1,
    selectedBranch: "high score",
    selectedBranchIndex: 1,
    description: "score is high enough",
  });
});

test("runIf uses else when no branch matches", async () => {
  const result = await runIf("plain", createTestProjectContext(), {
    branches: [
      {
        label: "contains error",
        condition: (input) => input.includes("error"),
        run: () => "error",
      },
    ],
    else: {
      run: () => "fallback",
    },
  });

  assert.equal(result, "fallback");
});

test("workflow structure keeps nested runIf inside its branch", () => {
  const analysis = analyzeProjectScriptSource(`
    const outputNode = steamharness.createOutputNode({
      name: "output",
      format(input) {
        return { errCode: 0, errMessage: "", content: String(input) };
      },
    });

    export const demo = steamharness.defineProject({
      name: "demo",
      async run(input, context) {
        const result = await steamharness.runIf(input, context, {
          name: "Outer branch",
          branches: [
            {
              label: "outer match",
              condition: (value) => value === "nested",
              async run(value, innerContext) {
                return steamharness.runIf(value, innerContext, {
                  name: "Nested branch",
                  branches: [
                    {
                      label: "nested match",
                      condition: (innerValue) => innerValue.length > 0,
                      run: (innerValue) => innerValue.toUpperCase(),
                    },
                  ],
                  else: {
                    label: "nested else",
                    run: () => "EMPTY",
                  },
                });
              },
            },
          ],
          else: {
            label: "outer else",
            run: () => "fallback",
          },
        });

        return steamharness.runNode(outputNode, result, context);
      },
    });
  `);

  assert.equal(analysis.structureCalls.filter((call) => call.callee === "runIf").length, 2);
  assert.equal(analysis.structureTrees.length, 1);

  const outer = analysis.structureTrees[0]?.children[0];
  assert.equal(outer?.kind, "run-if");
  assert.equal(outer.label, "Outer branch");
  assert.equal(outer.branches[0]?.children[0]?.kind, "run-if");

  const nested = outer.branches[0]?.children[0];
  assert.equal(nested?.kind, "run-if");
  assert.equal(nested.label, "Nested branch");
});

function createTestProjectContext(options: {
  onFinish?: (event: NodeExecutionHookFinishEvent) => void;
} = {}): RunContext {
  const kv = createMemoryKVContext();

  return {
    config: {},
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
