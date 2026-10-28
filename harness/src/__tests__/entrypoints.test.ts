import { LocalDatabaseRegistry, createLocalDatabaseResolver, type DatabaseResolver } from "../databases/index";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defineProjectEntrypoint,
  defineProjectExecutor,
  inspectLocalProjectStructure,
  inspectWorkspaceProjectStructureFromCli,
  resolveLocalProjectParams,
  runLocalProjectWithReport as runProject,
  runWorkspaceProjectWithReport,
  validateProjectScriptSource,
  HarnessError,
} from "../index";

const fixtureDatabases=new Map<string,DatabaseResolver>();
function runLocalProjectWithReport(options:Parameters<typeof runProject>[0]) {
  return runProject({...options,databaseResolver:options?.projectDir?fixtureDatabases.get(options.projectDir):undefined});
}

test("workspace structure CLI errors use the standalone CLI command", () => {
  assert.throws(
    () => inspectWorkspaceProjectStructureFromCli([]),
    (error: unknown) =>
      error instanceof HarnessError &&
      error.message === "Missing workflow directory. Usage: steamharness structure <workflow-dir>",
  );
});

test("workflow entrypoint definitions report validation failures as HarnessError", () => {
  const definition = {
    name: "test",
    run() {
      return { errCode: 0, errMessage: "" };
    },
  } as never;

  assert.throws(
    () => defineProjectEntrypoint({
      id: "main",
      title: 42,
      definition,
      params: [],
      createInput() {
        return { errCode: 0, errMessage: "" };
      },
    } as never),
    (error: unknown) => error instanceof HarnessError && /non-empty title/.test(error.message),
  );
});

test("workflow entrypoint groups validate metadata and reject conflicting definitions", () => {
  const definition = {
    name: "test",
    run() {
      return { errCode: 0, errMessage: "" };
    },
  } as never;
  const createEntrypoint = (id: string, group: unknown) => ({
    id,
    title: id,
    group,
    definition,
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
      () => defineProjectEntrypoint(createEntrypoint("main", group) as never),
      (error: unknown) => error instanceof HarnessError && message.test(error.message),
    );
  }

  for (const conflictingGroup of [
    { id: "operations", title: "Other title", order: 10 },
    { id: "operations", title: "Operations", order: 20 },
    { id: "operations", title: "Operations" },
  ]) {
    assert.throws(
      () => defineProjectExecutor({
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
  const projectDir = await createEntrypointProject();
  const kvStoreDir = path.join(projectDir, ".kv-test");

  try {
    const structure = inspectLocalProjectStructure({ projectDir });
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

    const validation = await runLocalProjectWithReport({
      projectDir,
      entrypointId: "validate",
      args: ["--rule", "strict"],
      storage: { host: "local", local: { kvStoreDir } },
    });
    assert.equal(validation.status, "success",JSON.stringify(validation.result));
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

    const main = await runLocalProjectWithReport({
      projectDir,
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

    assert.deepEqual(await resolveLocalProjectParams({
      projectDir,
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
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workflow entrypoint structure resolves imported workflows and keeps registries scoped", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-imported-entrypoints-"));
  try {
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({id:crypto.randomUUID(),steamHarness:{defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:"workflow",root:".",entry:"index.ts",databases:[]}]},
      name: "imported-entrypoint-test",
      version: "0.1.0",
      type: "module",
    }));
    await writeFile(path.join(projectDir, "workflows.ts"), `
      export const mainNode = steamharness.createInputNode({ name: "entry-main-input" });
      export const validateNode = steamharness.createInputNode({ name: "entry-validate-input" });
      export const mainProject = steamharness.defineProject({
        name: "main-flow",
        async run(input, context) {
          return steamharness.runNode(mainNode, input, context);
        },
      });
      export const validateProject = steamharness.defineProject({
        name: "validate-flow",
        async run(input, context) {
          return steamharness.runNode(validateNode, input, context);
        },
      });
      export default mainProject;
    `);
    await writeFile(path.join(projectDir, "index.ts"), `
      import importedMainProject, {
        mainNode,
        validateNode,
        validateProject as importedValidateProject,
      } from "./workflows.js";

      export const executor = steamharness.defineExecutor({
        projectType: "workflow",
        defaultEntrypoint: "main",
        entrypoints: [
          steamharness.defineEntrypoint({
            id: "main",
            title: "Main",
            workflow: importedMainProject,
            registry: [{ name: "shared-debug", node: mainNode }],
            createInput() { return { errCode: 0, errMessage: "" }; },
          }),
          steamharness.defineEntrypoint({
            id: "validate",
            title: "Validate",
            workflow: importedValidateProject,
            registry: [{ name: "shared-debug", node: validateNode }],
            createInput() { return { errCode: 0, errMessage: "" }; },
          }),
        ],
      });
    `);

    const structure = inspectLocalProjectStructure({ projectDir });
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
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workflow entrypoint structure resolves wrapped definitions and inline default exports", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-wrapped-entrypoints-"));
  try {
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({id:crypto.randomUUID(),steamHarness:{defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:"workflow",root:".",entry:"index.ts",databases:[]}]},
      name: "wrapped-entrypoint-test",
      version: "0.1.0",
      type: "module",
    }));
    await writeFile(path.join(projectDir, "workflows.ts"), `
      const wrappedNode = steamharness.createInputNode({ name: "wrapped-input" });
      const defaultNode = steamharness.createInputNode({ name: "default-input" });

      export const wrappedProject = ((
        steamharness.defineProject(({
          name: "wrapped-flow",
          async run(input, context) {
            return steamharness.runNode(wrappedNode, input, context);
          },
        } satisfies Record<string, unknown>)) as unknown
      )!);

      export default (
        steamharness.defineProject(({
          name: "inline-default-flow",
          async run(input, context) {
            return steamharness.runNode(defaultNode, input, context);
          },
        } as const)) satisfies unknown
      );
    `);
    await writeFile(path.join(projectDir, "index.ts"), `
      import inlineDefaultProject, { wrappedProject } from "./workflows.js";

      export const executor = steamharness.defineExecutor({
        projectType: "workflow",
        defaultEntrypoint: "main",
        entrypoints: [
          steamharness.defineEntrypoint({
            id: "main",
            title: "Main",
            workflow: wrappedProject,
            createInput() { return { errCode: 0, errMessage: "" }; },
          }),
          steamharness.defineEntrypoint({
            id: "inline-default",
            title: "Inline default",
            workflow: inlineDefaultProject,
            createInput() { return { errCode: 0, errMessage: "" }; },
          }),
        ],
      });
    `);

    const structure = inspectLocalProjectStructure({ projectDir });
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
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workflow entrypoint structure does not accept an unrelated same-name workflow", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-colliding-entrypoint-"));
  try {
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({id:crypto.randomUUID(),steamHarness:{defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:"workflow",root:".",entry:"index.ts",databases:[]}]},
      name: "colliding-entrypoint-test",
      version: "0.1.0",
      type: "module",
    }));
    await writeFile(path.join(projectDir, "other.ts"), `
      export const notAProject = steamharness.defineProject({
        name: "unrelated-flow",
        async run(input) { return input; },
      });
    `);
    await writeFile(path.join(projectDir, "index.ts"), `
      const notAProject = { name: "plain-object", async run(input) { return input; } };
      export const executor = steamharness.defineExecutor({
        projectType: "workflow",
        defaultEntrypoint: "main",
        entrypoints: [steamharness.defineEntrypoint({
          id: "main",
          title: "Main",
          workflow: notAProject,
          createInput() { return { errCode: 0, errMessage: "" }; },
        })],
      });
    `);

    assert.throws(
      () => inspectLocalProjectStructure({ projectDir }),
      (error: unknown) => error instanceof HarnessError && (
        (error.metadata?.violations as Array<{ type?: string; message?: string }> | undefined)?.some(
          (violation) => violation.type === "invalid_project_entrypoints" &&
            /must reference a project defined with steamharness\.defineProject/.test(violation.message ?? ""),
        ) ?? false
      ),
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("unknown workflow entrypoints fail with the allowed catalog", async () => {
  const projectDir = await createEntrypointProject();
  try {
    const report = await runLocalProjectWithReport({
      projectDir,
      entrypointId: "missing",
    });
    assert.equal(report.status, "failed");
    assert.equal(report.result.ok, true);
    assert.match(
      String((report.result.ok ? report.result.data as { errMessage?: string } : {}).errMessage),
      /Unknown entrypoint "missing"/,
    );
    await assert.rejects(
      resolveLocalProjectParams({
        projectDir,
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
          project: "entrypoint-test",
          entrypointId: "missing",
          defaultEntrypoint: "main",
          allowedEntrypoints: ["main", "validate"],
        });
        return true;
      },
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("conversation executors reject entrypoint selection without changing their shape", async () => {
  const projectDir = await createConversationProject();
  try {
    const structure = inspectLocalProjectStructure({ projectDir });
    assert.equal(structure.projectType, "conversation");
    assert.equal(structure.entrypoints, undefined);
    assert.equal(structure.execution?.kind, "sequence");

    const conversation = await runLocalProjectWithReport({ projectDir });
    assert.equal(conversation.status, "success");
    assert.equal(conversation.projectName, "conversation-flow");
    assert.equal(conversation.entrypointId, undefined);
    assert.equal(conversation.entrypointTitle, undefined);

    const report = await runLocalProjectWithReport({
      projectDir,
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
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("workspace runtime layers prepare before inspection and started events include the selected entrypoint", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "steamharness-entrypoint-runtime-"));
  const projectName = "runtime-order";
  const projectDir = path.join(cwd, "workspace", "workflow", projectName);
  let layerPrepared = false;
  const events: Array<{ type: string; entrypointId?: string; entrypointTitle?: string }> = [];

  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({
      id: "11111111-1111-4111-8111-111111111111",
      name: projectName,
      version: "0.1.0",
      type: "module",
      steamHarness: {defaultEntry:"main",entries:[{entryId:"main",type:"workflow",name:"Main",root:".",entry:"index.ts",databases:[]}], projectInfo:{}},
    }));
    await writeFile(path.join(projectDir, "index.ts"), `
      const mainProject = steamharness.defineProject({
        name: "runtime-order-main",
        run(input) { return input; },
      });
      export const executor = steamharness.defineExecutor({
        projectType: "workflow",
        defaultEntrypoint: "main",
        entrypoints: [steamharness.defineEntrypoint({
          id: "main",
          title: "Main entrypoint",
          workflow: mainProject,
          createInput() { return { errCode: 0, errMessage: "" }; },
        })],
      });
    `);

    const report = await runWorkspaceProjectWithReport({
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

    assert.equal(report.status, "success",JSON.stringify(report.result));
    assert.equal(report.entrypointId, "main");
    assert.deepEqual(events.filter((event) => event.type === "project_started"), [{
      type: "project_started",
      projectId:"11111111-1111-4111-8111-111111111111",
      entryId:"main",
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
  const projectSource = `
    const mainProject = steamharness.defineProject({
      name: "main",
      run() { return { errCode: 0, errMessage: "" }; },
    });
  `;
  const legacy = validateProjectScriptSource(`${projectSource}
    export const executor = steamharness.defineExecutor({
      projectType: "workflow",
      workflow: mainProject,
      createInput() { return { errCode: 0, errMessage: "" }; },
    });
  `);
  assert.equal(legacy.some((violation) => violation.type === "legacy_project_executor_fields"), true);

  const dynamic = validateProjectScriptSource(`${projectSource}
    const entrypoint = steamharness.defineEntrypoint({
      id: "main", title: "Main", workflow: mainProject,
      createInput() { return { errCode: 0, errMessage: "" }; },
    });
    export const executor = steamharness.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "missing",
      entrypoints: [entrypoint],
    });
  `);
  assert.equal(dynamic.some((violation) => (
    violation.type === "invalid_project_entrypoints" &&
    /directly call steamharness\.defineEntrypoint/.test(violation.message)
  )), true);
  assert.equal(dynamic.some((violation) => (
    violation.type === "invalid_project_entrypoints" &&
    /does not match/.test(violation.message)
  )), true);

  const dynamicDescription = validateProjectScriptSource(`${projectSource}
    const description = "Main";
    export const executor = steamharness.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "main",
      entrypoints: [steamharness.defineEntrypoint({
        id: "main",
        title: "Main",
        description,
        workflow: mainProject,
        createInput() { return { errCode: 0, errMessage: "" }; },
      })],
    });
  `);
  assert.equal(dynamicDescription.some((violation) => (
    violation.type === "invalid_project_entrypoints" &&
    /description must be a static string literal/.test(violation.message)
  )), true);

  const dynamicGroup = validateProjectScriptSource(`${projectSource}
    const group = { id: "operations", title: "Operations", order: 10 };
    export const executor = steamharness.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "main",
      entrypoints: [steamharness.defineEntrypoint({
        id: "main",
        title: "Main",
        group,
        workflow: mainProject,
        createInput() { return { errCode: 0, errMessage: "" }; },
      })],
    });
  `);
  assert.equal(dynamicGroup.some((violation) => (
    violation.type === "invalid_project_entrypoints" &&
    /group must be an inline object literal/.test(violation.message)
  )), true);

  const dynamicGroupId = validateProjectScriptSource(`${projectSource}
    const groupId = "operations";
    export const executor = steamharness.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "main",
      entrypoints: [steamharness.defineEntrypoint({
        id: "main",
        title: "Main",
        group: { id: groupId, title: "Operations", order: 10 },
        workflow: mainProject,
        createInput() { return { errCode: 0, errMessage: "" }; },
      })],
    });
  `);
  assert.equal(dynamicGroupId.some((violation) => (
    violation.type === "invalid_project_entrypoints" &&
    /group id must be a non-empty static string literal/.test(violation.message)
  )), true);

  const invalidGroupOrder = validateProjectScriptSource(`${projectSource}
    export const executor = steamharness.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "main",
      entrypoints: [steamharness.defineEntrypoint({
        id: "main",
        title: "Main",
        group: { id: "operations", title: "Operations", order: 1.5 },
        workflow: mainProject,
        createInput() { return { errCode: 0, errMessage: "" }; },
      })],
    });
  `);
  assert.equal(invalidGroupOrder.some((violation) => (
    violation.type === "invalid_project_entrypoints" &&
    /group order must be a non-negative static integer/.test(violation.message)
  )), true);

  for (const conflictingGroup of [
    `{ id: "operations", title: "Other", order: 10 }`,
    `{ id: "operations", title: "Operations" }`,
  ]) {
    const conflict = validateProjectScriptSource(`${projectSource}
      export const executor = steamharness.defineExecutor({
        projectType: "workflow",
        defaultEntrypoint: "main",
        entrypoints: [
          steamharness.defineEntrypoint({
            id: "main",
            title: "Main",
            group: { id: "operations", title: "Operations", order: 10 },
            workflow: mainProject,
            createInput() { return { errCode: 0, errMessage: "" }; },
          }),
          steamharness.defineEntrypoint({
            id: "secondary",
            title: "Secondary",
            group: ${conflictingGroup},
            workflow: mainProject,
            createInput() { return { errCode: 0, errMessage: "" }; },
          }),
        ],
      });
    `);
    assert.equal(conflict.some((violation) => (
      violation.type === "invalid_project_entrypoints" &&
      /group "operations" must use identical title and order/.test(violation.message)
    )), true);
  }

  const unknownProject = validateProjectScriptSource(`
    const notAProject = { name: "main", run() {} };
    export const executor = steamharness.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "main",
      entrypoints: [steamharness.defineEntrypoint({
        id: "main",
        title: "Main",
        workflow: notAProject,
        createInput() { return { errCode: 0, errMessage: "" }; },
      })],
    });
  `);
  assert.equal(unknownProject.some((violation) => (
    violation.type === "invalid_project_entrypoints" &&
    /must reference a project defined with steamharness\.defineProject/.test(violation.message)
  )), true);

  const constantProjectName = validateProjectScriptSource(`
    const STEAMHARNESS_NAME = "main-flow";
    const mainProject = steamharness.defineProject({
      name: STEAMHARNESS_NAME,
      async run(input) { return input; },
    });
    export const executor = steamharness.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "main",
      entrypoints: [steamharness.defineEntrypoint({
        id: "main",
        title: "Main",
        workflow: mainProject,
        createInput() { return { errCode: 0, errMessage: "" }; },
      })],
    });
  `);
  assert.equal(constantProjectName.some((violation) => (
    violation.type === "invalid_project_entrypoints"
  )), false);
});

async function createEntrypointProject(): Promise<string> {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-entrypoints-"));
  await writeFile(path.join(projectDir, "package.json"), JSON.stringify({
    id: "11111111-1111-4111-8111-111111111111",
    name: "entrypoint-test",
    version: "0.1.0",
    type: "module",
    steamHarness: {defaultEntry:"main",entries:[{entryId:"main",type:"workflow",name:"Main",root:".",entry:"index.ts",databases:[]}], projectInfo:{}},
  }));
  await writeFile(path.join(projectDir, "index.ts"), `
    const mainProject = steamharness.defineProject({
      name: "main-flow",
      async run(input, context) {
        return {
          ...input,
          shared: await context.databases.get("data").kv.getValue("shared-rule"),
        };
      },
    });
    const validateProject = steamharness.defineProject({
      name: "validate-flow",
      async run(input, context) {
        await context.databases.get("data").kv.setValue("shared-rule", input.rule);
        return {
          ...input,
          metadataEntrypointId: context.metadata?.entrypointId,
          metadataEntrypointTitle: context.metadata?.entrypointTitle,
        };
      },
    });
    export const executor = steamharness.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "main",
      entrypoints: [
        steamharness.defineEntrypoint({
          id: "main",
          title: "Complete flow",
          description: "Runs the complete flow",
          group: { id: "operations", title: "Operations", order: 10 },
          workflow: mainProject,
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
        steamharness.defineEntrypoint({
          id: "validate",
          title: "Validate data",
          description: "Only validates input",
          group: { id: "operations", title: "Operations", order: 10 },
          workflow: validateProject,
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
  const registry=new LocalDatabaseRegistry(path.join(projectDir,".registry"));
  const all={mode:"all" as const};const permissions={kv:{read:all,write:all},knowledge:{read:all,write:all}};
  const request=registry.request({projectId:"11111111-1111-4111-8111-111111111111",entryId:"main",alias:"data",target:{kind:"create",name:"Test data"},permissions});
  const approved=registry.review(request.requestId,{approve:true});
  const pkg=JSON.parse(await readFile(path.join(projectDir,"package.json"),"utf8"));
  pkg.steamHarness.entries[0].databases=[{alias:"data",host:"local",permissions,bindingRef:approved.bindingRef}];
  await writeFile(path.join(projectDir,"package.json"),JSON.stringify(pkg));
  fixtureDatabases.set(projectDir,createLocalDatabaseResolver(registry));
  return projectDir;
}

function pickEntrypointOutput(
  output: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (output === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(output).filter(([key]) => key !== "items"),
  );
}

async function createConversationProject(): Promise<string> {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-entrypoint-conversation-"));
  await writeFile(path.join(projectDir, "package.json"), JSON.stringify({
    id: "22222222-2222-4222-8222-222222222222",
    name: "entrypoint-conversation-test",
    version: "0.1.0",
    type: "module",
    steamHarness: {defaultEntry:"main",entries:[{entryId:"main",type:"conversation",name:"Main",root:".",entry:"index.ts",databases:[]}], projectInfo:{}},
  }));
  await writeFile(path.join(projectDir, "index.ts"), `
    const conversationProject = steamharness.defineProject({
      name: "conversation-flow",
      run(input) { return input; },
    });
    export const executor = steamharness.defineExecutor({
      projectType: "conversation",
      workflow: conversationProject,
      createInput() { return { errCode: 0, errMessage: "" }; },
    });
  `);
  return projectDir;
}
