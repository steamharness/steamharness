import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defineWorkflowEntrypoint,
  defineWorkflowExecutor,
  inspectLocalWorkflowStructure,
  inspectWorkspaceWorkflowStructureFromCli,
  resolveLocalWorkflowParams,
  runLocalWorkflowWithReport,
  runWorkspaceWorkflowWithReport,
  validateWorkflowScriptSource,
  HarnessError,
} from "../index";

test("workspace structure CLI errors use the standalone CLI command", () => {
  assert.throws(
    () => inspectWorkspaceWorkflowStructureFromCli([]),
    (error: unknown) =>
      error instanceof HarnessError &&
      error.message === "Missing workflow directory. Usage: steamharness structure <workflow-dir>",
  );
});

test("workflow entrypoint definitions report validation failures as HarnessError", () => {
  const workflow = {
    name: "test",
    run() {
      return { errCode: 0, errMessage: "" };
    },
  } as never;

  assert.throws(
    () => defineWorkflowEntrypoint({
      id: "main",
      title: 42,
      workflow,
      params: [],
      createInput() {
        return { errCode: 0, errMessage: "" };
      },
    } as never),
    (error: unknown) => error instanceof HarnessError && /non-empty title/.test(error.message),
  );
});

test("workflow entrypoint groups validate metadata and reject conflicting definitions", () => {
  const workflow = {
    name: "test",
    run() {
      return { errCode: 0, errMessage: "" };
    },
  } as never;
  const createEntrypoint = (id: string, group: unknown) => ({
    id,
    title: id,
    group,
    workflow,
    createInput() {
      return { errCode: 0, errMessage: "" };
    },
  });

  for (const [group, message] of [
    [null, /group must be an object/],
    [{ id: "", title: "Operations" }, /non-empty id/],
    [{ id: "operations", title: "  " }, /non-empty title/],
    [{ id: "operations", title: "Operations", order: -1 }, /non-negative integer/],
    [{ id: "operations", title: "Operations", order: 1.5 }, /non-negative integer/],
    [{ id: "operations", title: "Operations", order: undefined }, /non-negative integer/],
  ] as const) {
    assert.throws(
      () => defineWorkflowEntrypoint(createEntrypoint("main", group) as never),
      (error: unknown) => error instanceof HarnessError && message.test(error.message),
    );
  }

  for (const conflictingGroup of [
    { id: "operations", title: "Other title", order: 10 },
    { id: "operations", title: "Operations", order: 20 },
    { id: "operations", title: "Operations" },
  ]) {
    assert.throws(
      () => defineWorkflowExecutor({
        projectType: "workflow",
        defaultEntrypoint: "main",
        entrypoints: [
          createEntrypoint("main", { id: "operations", title: "Operations", order: 10 }),
          createEntrypoint("secondary", conflictingGroup),
        ],
      } as never),
      (error: unknown) => error instanceof HarnessError && /identical title and order/.test(error.message),
    );
  }
});

test("workflow entrypoints expose group metadata in a flat structure and run independently", async () => {
  const workflowDir = await createEntrypointWorkflow();
  const kvStoreDir = path.join(workflowDir, ".kv-test");

  try {
    const structure = inspectLocalWorkflowStructure({ workflowDir });
    assert.equal(structure.projectType, "workflow");
    assert.equal(structure.defaultEntrypoint, "main");
    assert.equal(Object.hasOwn(structure, "execution"), false);
    assert.equal(structure.execution, undefined);
    assert.deepEqual(structure.entrypoints?.map((entrypoint) => ({
      id: entrypoint.id,
      title: entrypoint.title,
      description: entrypoint.description,
      group: entrypoint.group,
      projectName: entrypoint.projectName,
      params: entrypoint.params?.map((param) => param.name),
      resolver: entrypoint.paramResolver,
    })), [
      {
        id: "main",
        title: "Complete flow",
        description: "Runs the complete flow",
        group: { id: "operations", title: "Operations", order: 10 },
        projectName: "main-flow",
        params: ["message"],
        resolver: undefined,
      },
      {
        id: "validate",
        title: "Validate data",
        description: "Only validates input",
        group: { id: "operations", title: "Operations", order: 10 },
        projectName: "validate-flow",
        params: ["rule"],
        resolver: { enabled: true },
      },
    ]);
    assert.equal(structure.entrypoints?.[0]?.execution.children.length, 0);

    const validation = await runLocalWorkflowWithReport({
      workflowDir,
      entrypointId: "validate",
      args: ["--rule", "strict"],
      storage: { host: "local", local: { kvStoreDir } },
    });
    assert.equal(validation.status, "success");
    assert.equal(validation.entrypointId, "validate");
    assert.equal(validation.entrypointTitle, "Validate data");
    const validationOutput = validation.result.ok
      ? (validation.result.data as { output?: Record<string, unknown> }).output
      : undefined;
    assert.deepEqual(pickEntrypointOutput(validationOutput), {
      errCode: 0,
      errMessage: "",
      entrypointId: "validate",
      entrypointTitle: "Validate data",
      metadataEntrypointId: "validate",
      metadataEntrypointTitle: "Validate data",
      rule: "strict",
    });

    const main = await runLocalWorkflowWithReport({
      workflowDir,
      args: ["--message", "hello"],
      storage: { host: "local", local: { kvStoreDir } },
    });
    assert.equal(main.entrypointId, "main");
    assert.equal(main.entrypointTitle, "Complete flow");
    const mainOutput = main.result.ok
      ? (main.result.data as { output?: Record<string, unknown> }).output
      : undefined;
    assert.deepEqual(pickEntrypointOutput(mainOutput), {
      errCode: 0,
      errMessage: "",
      entrypointId: "main",
      entrypointTitle: "Complete flow",
      message: "hello",
      shared: "strict",
    });

    assert.deepEqual(await resolveLocalWorkflowParams({
      workflowDir,
      entrypointId: "validate",
      request: {
        args: ["--rule", "strict"],
        draftText: "draft",
        inputMode: "form",
        trigger: { kind: "init" },
      },
    }), {
      params: { rule: { value: "resolved-strict" } },
    });
  } finally {
    await rm(workflowDir, { recursive: true, force: true });
  }
});

test("workflow entrypoint structure resolves imported workflows and keeps registries scoped", async () => {
  const workflowDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-imported-entrypoints-"));
  try {
    await writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
      name: "imported-entrypoint-test",
      version: "0.1.0",
      type: "module",
    }));
    await writeFile(path.join(workflowDir, "workflows.ts"), `
      export const mainNode = workflow.createInputNode({ name: "entry-main-input" });
      export const validateNode = workflow.createInputNode({ name: "entry-validate-input" });
      export const mainWorkflow = workflow.defineWorkflow({
        name: "main-flow",
        async run(input, context) {
          return workflow.runNode(mainNode, input, context);
        },
      });
      export const validateWorkflow = workflow.defineWorkflow({
        name: "validate-flow",
        async run(input, context) {
          return workflow.runNode(validateNode, input, context);
        },
      });
      export default mainWorkflow;
    `);
    await writeFile(path.join(workflowDir, "index.ts"), `
      import importedMainWorkflow, {
        mainNode,
        validateNode,
        validateWorkflow as importedValidateWorkflow,
      } from "./workflows.js";

      export const executor = workflow.defineExecutor({
        projectType: "workflow",
        defaultEntrypoint: "main",
        entrypoints: [
          workflow.defineEntrypoint({
            id: "main",
            title: "Main",
            workflow: importedMainWorkflow,
            registry: [{ name: "shared-debug", node: mainNode }],
            createInput() { return { errCode: 0, errMessage: "" }; },
          }),
          workflow.defineEntrypoint({
            id: "validate",
            title: "Validate",
            workflow: importedValidateWorkflow,
            registry: [{ name: "shared-debug", node: validateNode }],
            createInput() { return { errCode: 0, errMessage: "" }; },
          }),
        ],
      });
    `);

    const structure = inspectLocalWorkflowStructure({ workflowDir });
    assert.deepEqual(structure.diagnostics.violations, []);
    assert.deepEqual(structure.entrypoints?.map((entrypoint) => ({
      id: entrypoint.id,
      hasGroup: Object.hasOwn(entrypoint, "group"),
      projectName: entrypoint.projectName,
      registry: entrypoint.registry?.map((item) => item.name),
      executionNodes: entrypoint.execution.children.length,
    })), [
      {
        id: "main",
        hasGroup: false,
        projectName: "main-flow",
        registry: ["shared-debug"],
        executionNodes: 1,
      },
      {
        id: "validate",
        hasGroup: false,
        projectName: "validate-flow",
        registry: ["shared-debug"],
        executionNodes: 1,
      },
    ]);
    assert.deepEqual(structure.definitions.registry, {});
  } finally {
    await rm(workflowDir, { recursive: true, force: true });
  }
});

test("workflow entrypoint structure resolves wrapped definitions and inline default exports", async () => {
  const workflowDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-wrapped-entrypoints-"));
  try {
    await writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
      name: "wrapped-entrypoint-test",
      version: "0.1.0",
      type: "module",
    }));
    await writeFile(path.join(workflowDir, "workflows.ts"), `
      const wrappedNode = workflow.createInputNode({ name: "wrapped-input" });
      const defaultNode = workflow.createInputNode({ name: "default-input" });

      export const wrappedWorkflow = ((
        workflow.defineWorkflow(({
          name: "wrapped-flow",
          async run(input, context) {
            return workflow.runNode(wrappedNode, input, context);
          },
        } satisfies Record<string, unknown>)) as unknown
      )!);

      export default (
        workflow.defineWorkflow(({
          name: "inline-default-flow",
          async run(input, context) {
            return workflow.runNode(defaultNode, input, context);
          },
        } as const)) satisfies unknown
      );
    `);
    await writeFile(path.join(workflowDir, "index.ts"), `
      import inlineDefaultWorkflow, { wrappedWorkflow } from "./workflows.js";

      export const executor = workflow.defineExecutor({
        projectType: "workflow",
        defaultEntrypoint: "main",
        entrypoints: [
          workflow.defineEntrypoint({
            id: "main",
            title: "Main",
            workflow: wrappedWorkflow,
            createInput() { return { errCode: 0, errMessage: "" }; },
          }),
          workflow.defineEntrypoint({
            id: "inline-default",
            title: "Inline default",
            workflow: inlineDefaultWorkflow,
            createInput() { return { errCode: 0, errMessage: "" }; },
          }),
        ],
      });
    `);

    const structure = inspectLocalWorkflowStructure({ workflowDir });
    assert.deepEqual(structure.diagnostics.violations, []);
    assert.deepEqual(structure.entrypoints?.map((entrypoint) => ({
      id: entrypoint.id,
      projectName: entrypoint.projectName,
      executionNodes: entrypoint.execution.children.length,
    })), [
      { id: "main", projectName: "wrapped-flow", executionNodes: 1 },
      { id: "inline-default", projectName: "inline-default-flow", executionNodes: 1 },
    ]);
  } finally {
    await rm(workflowDir, { recursive: true, force: true });
  }
});

test("workflow entrypoint structure does not accept an unrelated same-name workflow", async () => {
  const workflowDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-colliding-entrypoint-"));
  try {
    await writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
      name: "colliding-entrypoint-test",
      version: "0.1.0",
      type: "module",
    }));
    await writeFile(path.join(workflowDir, "other.ts"), `
      export const notAWorkflow = workflow.defineWorkflow({
        name: "unrelated-flow",
        async run(input) { return input; },
      });
    `);
    await writeFile(path.join(workflowDir, "index.ts"), `
      const notAWorkflow = { name: "plain-object", async run(input) { return input; } };
      export const executor = workflow.defineExecutor({
        projectType: "workflow",
        defaultEntrypoint: "main",
        entrypoints: [workflow.defineEntrypoint({
          id: "main",
          title: "Main",
          workflow: notAWorkflow,
          createInput() { return { errCode: 0, errMessage: "" }; },
        })],
      });
    `);

    assert.throws(
      () => inspectLocalWorkflowStructure({ workflowDir }),
      (error: unknown) => error instanceof HarnessError && (
        (error.metadata?.violations as Array<{ type?: string; message?: string }> | undefined)?.some(
          (violation) => violation.type === "invalid_workflow_entrypoints" &&
            /must reference a workflow defined with workflow\.defineWorkflow/.test(violation.message ?? ""),
        ) ?? false
      ),
    );
  } finally {
    await rm(workflowDir, { recursive: true, force: true });
  }
});

test("unknown workflow entrypoints fail with the allowed catalog", async () => {
  const workflowDir = await createEntrypointWorkflow();
  try {
    const report = await runLocalWorkflowWithReport({
      workflowDir,
      entrypointId: "missing",
    });
    assert.equal(report.status, "failed");
    assert.equal(report.result.ok, true);
    assert.match(
      String((report.result.ok ? report.result.data as { errMessage?: string } : {}).errMessage),
      /Unknown entrypoint "missing"/,
    );
    await assert.rejects(
      resolveLocalWorkflowParams({
        workflowDir,
        entrypointId: "missing",
        request: {
          args: [],
          draftText: "",
          inputMode: "form",
          trigger: { kind: "init" },
        },
      }),
      (error: unknown) => {
        assert.deepEqual((error as { metadata?: unknown }).metadata, {
          workflow: "entrypoint-test",
          entrypointId: "missing",
          defaultEntrypoint: "main",
          allowedEntrypoints: ["main", "validate"],
        });
        return true;
      },
    );
  } finally {
    await rm(workflowDir, { recursive: true, force: true });
  }
});

test("conversation executors reject entrypoint selection without changing their shape", async () => {
  const workflowDir = await createConversationWorkflow();
  try {
    const structure = inspectLocalWorkflowStructure({ workflowDir });
    assert.equal(structure.projectType, "conversation");
    assert.equal(structure.entrypoints, undefined);
    assert.equal(structure.execution?.kind, "sequence");

    const conversation = await runLocalWorkflowWithReport({ workflowDir });
    assert.equal(conversation.status, "success");
    assert.equal(conversation.projectName, "conversation-flow");
    assert.equal(conversation.entrypointId, undefined);
    assert.equal(conversation.entrypointTitle, undefined);

    const report = await runLocalWorkflowWithReport({
      workflowDir,
      entrypointId: "main",
      conversationId: "conversation-1",
    });
    assert.equal(report.status, "failed");
    assert.equal(report.result.ok, true);
    assert.match(
      String((report.result.ok ? report.result.data as { errMessage?: string } : {}).errMessage),
      /does not accept an entrypoint/,
    );
  } finally {
    await rm(workflowDir, { recursive: true, force: true });
  }
});

test("workspace runtime layers prepare before inspection and started events include the selected entrypoint", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "steamharness-entrypoint-runtime-"));
  const projectName = "runtime-order";
  const workflowDir = path.join(cwd, "workspace", "workflow", projectName);
  let layerPrepared = false;
  const events: Array<{ type: string; entrypointId?: string; entrypointTitle?: string }> = [];

  try {
    await mkdir(workflowDir, { recursive: true });
    await writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
      id: "11111111-1111-4111-8111-111111111111",
      name: projectName,
      version: "0.1.0",
      type: "module",
      steamHarness: { projectInfo: { dataStorage: { mode: "local" } } },
    }));
    await writeFile(path.join(workflowDir, "index.ts"), `
      const mainWorkflow = workflow.defineWorkflow({
        name: "runtime-order-main",
        run(input) { return input; },
      });
      export const executor = workflow.defineExecutor({
        projectType: "workflow",
        defaultEntrypoint: "main",
        entrypoints: [workflow.defineEntrypoint({
          id: "main",
          title: "Main entrypoint",
          workflow: mainWorkflow,
          createInput() { return { errCode: 0, errMessage: "" }; },
        })],
      });
    `);

    const report = await runWorkspaceWorkflowWithReport({
      cwd,
      projectName,
      layers: [{
        name: "runtime-order-test",
        onBeforeRun() {
          layerPrepared = true;
        },
      }],
      onDefinedNodes() {
        assert.equal(layerPrepared, true);
      },
      onRuntimeEvent(event) {
        events.push(event);
      },
    });

    assert.equal(report.status, "success");
    assert.equal(report.entrypointId, "main");
    assert.deepEqual(events.filter((event) => event.type === "workflow_started"), [{
      type: "workflow_started",
      runId: report.runId,
      projectName,
      entrypointId: "main",
      entrypointTitle: "Main entrypoint",
      startedAt: report.startedAt,
    }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow entrypoint structure rules reject legacy and dynamic declarations", () => {
  const workflowSource = `
    const mainWorkflow = workflow.defineWorkflow({
      name: "main",
      run() { return { errCode: 0, errMessage: "" }; },
    });
  `;
  const legacy = validateWorkflowScriptSource(`${workflowSource}
    export const executor = workflow.defineExecutor({
      projectType: "workflow",
      workflow: mainWorkflow,
      createInput() { return { errCode: 0, errMessage: "" }; },
    });
  `);
  assert.equal(legacy.some((violation) => violation.type === "legacy_workflow_executor_fields"), true);

  const dynamic = validateWorkflowScriptSource(`${workflowSource}
    const entrypoint = workflow.defineEntrypoint({
      id: "main", title: "Main", workflow: mainWorkflow,
      createInput() { return { errCode: 0, errMessage: "" }; },
    });
    export const executor = workflow.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "missing",
      entrypoints: [entrypoint],
    });
  `);
  assert.equal(dynamic.some((violation) => (
    violation.type === "invalid_workflow_entrypoints" &&
    /directly call workflow\.defineEntrypoint/.test(violation.message)
  )), true);
  assert.equal(dynamic.some((violation) => (
    violation.type === "invalid_workflow_entrypoints" &&
    /does not match/.test(violation.message)
  )), true);

  const dynamicDescription = validateWorkflowScriptSource(`${workflowSource}
    const description = "Main";
    export const executor = workflow.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "main",
      entrypoints: [workflow.defineEntrypoint({
        id: "main",
        title: "Main",
        description,
        workflow: mainWorkflow,
        createInput() { return { errCode: 0, errMessage: "" }; },
      })],
    });
  `);
  assert.equal(dynamicDescription.some((violation) => (
    violation.type === "invalid_workflow_entrypoints" &&
    /description must be a static string literal/.test(violation.message)
  )), true);

  const dynamicGroup = validateWorkflowScriptSource(`${workflowSource}
    const group = { id: "operations", title: "Operations", order: 10 };
    export const executor = workflow.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "main",
      entrypoints: [workflow.defineEntrypoint({
        id: "main",
        title: "Main",
        group,
        workflow: mainWorkflow,
        createInput() { return { errCode: 0, errMessage: "" }; },
      })],
    });
  `);
  assert.equal(dynamicGroup.some((violation) => (
    violation.type === "invalid_workflow_entrypoints" &&
    /group must be an inline object literal/.test(violation.message)
  )), true);

  const dynamicGroupId = validateWorkflowScriptSource(`${workflowSource}
    const groupId = "operations";
    export const executor = workflow.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "main",
      entrypoints: [workflow.defineEntrypoint({
        id: "main",
        title: "Main",
        group: { id: groupId, title: "Operations", order: 10 },
        workflow: mainWorkflow,
        createInput() { return { errCode: 0, errMessage: "" }; },
      })],
    });
  `);
  assert.equal(dynamicGroupId.some((violation) => (
    violation.type === "invalid_workflow_entrypoints" &&
    /group id must be a non-empty static string literal/.test(violation.message)
  )), true);

  const invalidGroupOrder = validateWorkflowScriptSource(`${workflowSource}
    export const executor = workflow.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "main",
      entrypoints: [workflow.defineEntrypoint({
        id: "main",
        title: "Main",
        group: { id: "operations", title: "Operations", order: 1.5 },
        workflow: mainWorkflow,
        createInput() { return { errCode: 0, errMessage: "" }; },
      })],
    });
  `);
  assert.equal(invalidGroupOrder.some((violation) => (
    violation.type === "invalid_workflow_entrypoints" &&
    /group order must be a non-negative static integer/.test(violation.message)
  )), true);

  for (const conflictingGroup of [
    `{ id: "operations", title: "Other", order: 10 }`,
    `{ id: "operations", title: "Operations" }`,
  ]) {
    const conflict = validateWorkflowScriptSource(`${workflowSource}
      export const executor = workflow.defineExecutor({
        projectType: "workflow",
        defaultEntrypoint: "main",
        entrypoints: [
          workflow.defineEntrypoint({
            id: "main",
            title: "Main",
            group: { id: "operations", title: "Operations", order: 10 },
            workflow: mainWorkflow,
            createInput() { return { errCode: 0, errMessage: "" }; },
          }),
          workflow.defineEntrypoint({
            id: "secondary",
            title: "Secondary",
            group: ${conflictingGroup},
            workflow: mainWorkflow,
            createInput() { return { errCode: 0, errMessage: "" }; },
          }),
        ],
      });
    `);
    assert.equal(conflict.some((violation) => (
      violation.type === "invalid_workflow_entrypoints" &&
      /group "operations" must use identical title and order/.test(violation.message)
    )), true);
  }

  const unknownWorkflow = validateWorkflowScriptSource(`
    const notAWorkflow = { name: "main", run() {} };
    export const executor = workflow.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "main",
      entrypoints: [workflow.defineEntrypoint({
        id: "main",
        title: "Main",
        workflow: notAWorkflow,
        createInput() { return { errCode: 0, errMessage: "" }; },
      })],
    });
  `);
  assert.equal(unknownWorkflow.some((violation) => (
    violation.type === "invalid_workflow_entrypoints" &&
    /must reference a workflow defined with workflow\.defineWorkflow/.test(violation.message)
  )), true);

  const constantProjectName = validateWorkflowScriptSource(`
    const STEAMHARNESS_NAME = "main-flow";
    const mainWorkflow = workflow.defineWorkflow({
      name: STEAMHARNESS_NAME,
      async run(input) { return input; },
    });
    export const executor = workflow.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "main",
      entrypoints: [workflow.defineEntrypoint({
        id: "main",
        title: "Main",
        workflow: mainWorkflow,
        createInput() { return { errCode: 0, errMessage: "" }; },
      })],
    });
  `);
  assert.equal(constantProjectName.some((violation) => (
    violation.type === "invalid_workflow_entrypoints"
  )), false);
});

async function createEntrypointWorkflow(): Promise<string> {
  const workflowDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-entrypoints-"));
  await writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
    id: "11111111-1111-4111-8111-111111111111",
    name: "entrypoint-test",
    version: "0.1.0",
    type: "module",
    steamHarness: { projectInfo: { dataStorage: { mode: "local" } } },
  }));
  await writeFile(path.join(workflowDir, "index.ts"), `
    const mainWorkflow = workflow.defineWorkflow({
      name: "main-flow",
      async run(input, context) {
        return {
          ...input,
          shared: await context.storage.local.kv.getValue("shared-rule"),
        };
      },
    });
    const validateWorkflow = workflow.defineWorkflow({
      name: "validate-flow",
      async run(input, context) {
        await context.storage.local.kv.setValue("shared-rule", input.rule);
        return {
          ...input,
          metadataEntrypointId: context.metadata?.entrypointId,
          metadataEntrypointTitle: context.metadata?.entrypointTitle,
        };
      },
    });
    export const executor = workflow.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "main",
      entrypoints: [
        workflow.defineEntrypoint({
          id: "main",
          title: "Complete flow",
          description: "Runs the complete flow",
          group: { id: "operations", title: "Operations", order: 10 },
          workflow: mainWorkflow,
          params: [{ name: "message", flag: "--message", type: "string" }],
          createInput({ paramValues, entrypointId, entrypointTitle }) {
            return {
              errCode: 0,
              errMessage: "",
              entrypointId,
              entrypointTitle,
              message: paramValues.message,
            };
          },
        }),
        workflow.defineEntrypoint({
          id: "validate",
          title: "Validate data",
          description: "Only validates input",
          group: { id: "operations", title: "Operations", order: 10 },
          workflow: validateWorkflow,
          params: [{ name: "rule", flag: "--rule", type: "string" }],
          createInput({ paramValues, entrypointId, entrypointTitle }) {
            return {
              errCode: 0,
              errMessage: "",
              entrypointId,
              entrypointTitle,
              rule: paramValues.rule,
            };
          },
          resolveParams({ paramValues }) {
            return { params: { rule: { value: \`resolved-\${paramValues.rule}\` } } };
          },
          createContext() {
            return {
              metadata: {
                entrypointId: "spoofed",
                entrypointTitle: "Spoofed title",
              },
            };
          },
        }),
      ],
    });
  `);
  return workflowDir;
}

function pickEntrypointOutput(
  output: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (output === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(output).filter(([key]) => key !== "items"),
  );
}

async function createConversationWorkflow(): Promise<string> {
  const workflowDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-entrypoint-conversation-"));
  await writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
    id: "22222222-2222-4222-8222-222222222222",
    name: "entrypoint-conversation-test",
    version: "0.1.0",
    type: "module",
    steamHarness: { projectInfo: { dataStorage: { mode: "local" } } },
  }));
  await writeFile(path.join(workflowDir, "index.ts"), `
    const conversationWorkflow = workflow.defineWorkflow({
      name: "conversation-flow",
      run(input) { return input; },
    });
    export const executor = workflow.defineExecutor({
      projectType: "conversation",
      workflow: conversationWorkflow,
      createInput() { return { errCode: 0, errMessage: "" }; },
    });
  `);
  return workflowDir;
}
