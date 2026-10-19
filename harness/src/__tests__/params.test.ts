import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defineWorkflowExecutor,
  inspectLocalWorkflowStructure,
  parseWorkflowParamValues,
  resolveLocalWorkflowParams,
  runLocalWorkflow,
  validateWorkflowScriptSource,
  validateWorkflowParamResolveResult,
  readWorkflowParamDefinitionError,
  normalizeWorkflowParamDeclarations,
  type ParamDeclaration,
  type ParamDefinition,
  type KVStore,
} from "../index";

const params = [
  { name: "tone", flag: "--tone", type: "string" as const, defaultValue: "balanced" },
  { name: "sources", flag: "--sources", type: "string" as const, control: "checkboxes" as const, options: [{ value: "web" }, { value: "docs" }] },
  { name: "dryRun", flag: "--dry-run", type: "boolean" as const, defaultValue: "false" },
];

test("parseWorkflowParamValues returns structured defaults and selected values", () => {
  assert.deepEqual(parseWorkflowParamValues(params, [
    "--tone", "concise",
    "--sources", JSON.stringify(["web", "docs"]),
    "--dry-run",
  ]), {
    tone: "concise",
    sources: ["web", "docs"],
    dryRun: "true",
  });
});

test("multiple parameter actions retain declaration order and flatten into one value namespace", () => {
  const declarations: ParamDeclaration[] = [
    { name: "message", flag: "--message", type: "string" },
    {
      kind: "auxiliary", id: "workspace", label: "Workspace",
      fields: [
        { name: "workdir", flag: "--workdir", type: "string" },
        { name: "trace", flag: "--trace", type: "boolean" },
      ],
    },
    {
      kind: "quick", id: "ai", label: "AI", icon: "sparkle", summary: ["model", "effort"],
      fields: [
        { name: "model", flag: "--model", type: "string", control: "select", options: [{ value: "sol" }] },
        { name: "effort", flag: "--effort", type: "string", control: "select", options: [{ value: "high" }] },
      ],
    },
    { kind: "mode", name: "agentMode", flag: "--agent-mode", label: "Mode", options: [{ value: "ask" }, { value: "build" }] },
    { kind: "auxiliary", id: "output", label: "Output", fields: [{ name: "format", flag: "--format", type: "string" }] },
    { kind: "mode", name: "viewMode", flag: "--view-mode", label: "View", options: [{ value: "compact" }, { value: "full" }] },
    { kind: "quick", id: "permission", label: "Permission", summary: ["permission"], fields: [
      { name: "permission", flag: "--permission", type: "string", control: "select", options: [{ value: "read-only" }] },
    ] },
  ];
  const normalized = normalizeWorkflowParamDeclarations(declarations);
  assert.deepEqual(normalized.params.map(({ name, panel }) => [name, panel]), [
    ["message", undefined], ["workdir", "auxiliary"], ["trace", "auxiliary"],
    ["model", "quick"], ["effort", "quick"], ["agentMode", "mode"],
    ["format", "auxiliary"], ["viewMode", "mode"], ["permission", "quick"],
  ]);
  assert.deepEqual(normalized.layout?.actions, [
    { kind: "auxiliary", id: "workspace", label: "Workspace", params: ["workdir", "trace"] },
    { kind: "quick", id: "ai", label: "AI", icon: "sparkle", summary: ["model", "effort"], params: ["model", "effort"] },
    { kind: "mode", name: "agentMode" },
    { kind: "auxiliary", id: "output", label: "Output", params: ["format"] },
    { kind: "mode", name: "viewMode" },
    { kind: "quick", id: "permission", label: "Permission", summary: ["permission"], params: ["permission"] },
  ]);
  assert.deepEqual(parseWorkflowParamValues(declarations, ["--workdir", "/tmp", "--model", "sol", "--agent-mode", "ask"]), {
    message: "", workdir: "/tmp", trace: "", model: "sol", effort: "", agentMode: "ask", format: "", viewMode: "compact", permission: "",
  });
});

test("conversation structure reports every declared parameter action", async () => {
  const workflowDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-param-actions-"));
  try {
    await Promise.all([
      writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
        name: "param-actions-structure-test", version: "0.1.0", type: "module",
      })),
      writeFile(path.join(workflowDir, "index.ts"), `
        const conversationWorkflow = workflow.defineWorkflow({ name: "conversation", run(input) { return input; } });
        export const executor = workflow.defineExecutor({
          projectType: "conversation", workflow: conversationWorkflow,
          params: [
            { kind: "auxiliary", id: "workspace", label: "Workspace", fields: [
              { name: "workdir", flag: "--workdir", type: "string" },
              { name: "trace", flag: "--trace", type: "boolean" },
            ] },
            { kind: "quick", id: "ai", label: "AI", icon: "sparkle", summary: ["model"], fields: [
              { name: "model", flag: "--model", type: "string", control: "select", options: [{ value: "sol" }] },
            ] },
            { kind: "mode", name: "taskMode", flag: "--task-mode", options: [{ value: "ask" }, { value: "build" }] },
            { kind: "auxiliary", id: "output", label: "Output", fields: [
              { name: "format", flag: "--format", type: "string" },
            ] },
          ],
          createInput({ paramValues }) { return paramValues; },
        });
        export { conversationWorkflow as workflow };
        export default conversationWorkflow;
      `),
    ]);

    const structure = inspectLocalWorkflowStructure({ workflowDir });
    assert.deepEqual(structure.diagnostics.violations, []);
    assert.deepEqual(structure.params?.map(({ name, panel }) => [name, panel]), [
      ["workdir", "auxiliary"], ["trace", "auxiliary"],
      ["model", "quick"], ["taskMode", "mode"], ["format", "auxiliary"],
    ]);
    assert.equal(structure.params?.find((param) => param.name === "taskMode")?.defaultValue, "ask");
    assert.deepEqual(structure.paramLayout?.actions, [
      { kind: "auxiliary", id: "workspace", label: "Workspace", params: ["workdir", "trace"] },
      { kind: "quick", id: "ai", label: "AI", icon: "sparkle", summary: ["model"], params: ["model"] },
      { kind: "mode", name: "taskMode" },
      { kind: "auxiliary", id: "output", label: "Output", params: ["format"] },
    ]);
  } finally {
    await rm(workflowDir, { recursive: true, force: true });
  }
});

test("group declarations reject ambiguous placement, ids, summaries and fields", () => {
  const field = { name: "model", flag: "--model", type: "string" as const, control: "select" as const, options: [{ value: "sol" }] };
  assert.throws(() => normalizeWorkflowParamDeclarations([
    { kind: "quick", id: "ai", label: "AI", summary: ["missing"], fields: [field] },
  ]), /summary must name distinct fields/);
  assert.throws(() => normalizeWorkflowParamDeclarations([
    { kind: "auxiliary", id: "shared", label: "First", fields: [field] },
    { kind: "quick", id: "shared", label: "Second", summary: ["other"], fields: [{ ...field, name: "other", flag: "--other" }] },
  ]), /group id/);
  assert.throws(() => normalizeWorkflowParamDeclarations([
    { kind: "auxiliary", id: "advanced", label: "Advanced", fields: [{ ...field, panel: "quick" }] },
  ] as never), /cannot declare its own placement/);
  assert.throws(() => normalizeWorkflowParamDeclarations([
    { kind: "quick", id: "ai", label: "AI", summary: ["date"], fields: [
      { name: "date", flag: "--date", type: "string", control: "date" },
    ] },
  ] as never), /must be a string selector/);
  assert.throws(() => normalizeWorkflowParamDeclarations([
    { kind: "mode", name: "agentMode", flag: "--agent-mode", options: [{ value: "ask" }, { value: "ask" }] },
  ]), /distinct non-empty option values/);
  assert.throws(() => normalizeWorkflowParamDeclarations([
    { kind: "mode", name: "agentMode", flag: "--agent-mode", defaultValue: "other", options: [{ value: "ask" }, { value: "build" }] },
  ]), /defaultValue must name an option/);
  assert.throws(() => defineWorkflowExecutor({
    projectType: "workflow", defaultEntrypoint: "run", entrypoints: [{
      id: "run", title: "Run", workflow: {} as never,
      params: [{ kind: "mode", name: "agentMode", flag: "--agent-mode", options: [{ value: "ask" }, { value: "build" }] }],
    }],
  } as never), /only supported by Conversation/);
});

test("Quick icons reject invalid runtime names and non-static source declarations", () => {
  const fields = [{ name: "permission", flag: "--permission", type: "string" as const, control: "select" as const, options: [{ value: "auto" }] }];
  for (const icon of ["", "shield extra-class", "$(shield)", 1]) {
    assert.throws(() => normalizeWorkflowParamDeclarations([
      { kind: "quick", id: "permissions", label: "Permission", icon, summary: ["permission"], fields },
    ] as never), /icon must be a Codicon name/);
  }
  for (const sourceIcon of ["'shield extra-class'", "selectedIcon", "1"]) {
    const violations = validateWorkflowScriptSource(`
      const flow = workflow.defineWorkflow({ name: 'icons', run(input) { return input; } });
      export const executor = workflow.defineExecutor({ projectType: 'conversation', workflow: flow,
        params: [{ kind: 'quick', id: 'permissions', label: 'Permission', icon: ${sourceIcon}, summary: ['permission'], fields: [
          { name: 'permission', flag: '--permission', type: 'string', control: 'select', options: [{ value: 'auto' }] }
        ] }], createInput({ paramValues }) { return paramValues; }
      });
    `);
    assert.ok(violations.some(violation => /icon must be a Codicon name/.test(violation.message)));
  }
});

test("parseWorkflowParamValues treats multiple booleans as JSON arrays", () => {
  const definitions = [
    { name: "switches", flag: "--switches", type: "boolean" as const, multiple: true, defaultValue: "[false]" },
    { name: "tail", type: "positional" as const },
  ];

  assert.deepEqual(parseWorkflowParamValues(definitions, [
    "--switches", "[true,false]", "after",
  ]), {
    switches: ["true", "false"],
    tail: "after",
  });
});

test("validateWorkflowParamResolveResult rejects unknown options", () => {
  assert.throws(() => validateWorkflowParamResolveResult(params, {
    params: { sources: { options: { unknown: { disabled: true } } } },
  }), /Unknown option "unknown"/);
});

test("validateWorkflowParamResolveResult accepts replacement options atomically", () => {
  assert.deepEqual(validateWorkflowParamResolveResult(params, {
    params: {
      tone: {
        value: "server-model",
        resolvedOptions: [{ value: "server-model", label: "Server model" }],
        options: { "server-model": { disabled: false } },
      },
    },
  }), {
    params: {
      tone: {
        value: "server-model",
        resolvedOptions: [{ value: "server-model", label: "Server model" }],
        options: { "server-model": { disabled: false } },
      },
    },
  });
  assert.throws(() => validateWorkflowParamResolveResult(params, {
    params: { tone: { resolvedOptions: [{ value: "duplicate" }, { value: "duplicate" }] } },
  }), /Duplicate resolved option/);
  assert.throws(() => validateWorkflowParamResolveResult(params, {
    params: { tone: { resolvedOptions: [{ value: "" }] } },
  }), /non-empty strings/);
  assert.throws(() => validateWorkflowParamResolveResult(params, {
    params: { tone: { resolvedOptions: [{ value: "server-model", label: 42 } as never] } },
  }), /must be a string/);
});

test("date params reject option patches from resolveParams", () => {
  const dateParams = [{
    name: "day",
    flag: "--day",
    type: "string" as const,
    control: "date" as const,
  }];
  assert.throws(() => validateWorkflowParamResolveResult(dateParams, {
    params: { day: { resolvedOptions: [{ value: "2026-07-26" }] } },
  }), /cannot resolve options/);
  assert.throws(() => validateWorkflowParamResolveResult(dateParams, {
    params: { day: { options: { "2026-07-26": { disabled: true } } } },
  }), /cannot resolve options/);
  assert.deepEqual(validateWorkflowParamResolveResult(dateParams, {
    params: { day: { visible: false, value: null } },
  }), {
    params: { day: { visible: false, value: null } },
  });
});

test("a param step must be a positive integer", () => {
  const param: ParamDefinition = { name: "question_1", type: "string", step: 2 };
  assert.equal(readWorkflowParamDefinitionError(param), undefined);
  assert.match(readWorkflowParamDefinitionError({ ...param, step: 0 }) ?? "", /step must be a positive integer/);
  assert.match(readWorkflowParamDefinitionError({ ...param, step: 1.5 }) ?? "", /step must be a positive integer/);
  // A request that never declares steps keeps asking its fields at once.
  assert.equal(readWorkflowParamDefinitionError({ name: "question_2", type: "string" }), undefined);

  assert.throws(() => defineWorkflowExecutor({
    params: [{ name: "notAStep", type: "string", step: 0 }],
  } as never), /step must be a positive integer/);
});

test("audio params use the file contract and validate limits", () => {
  const audio: ParamDefinition = {
    name: "audio", type: "file", control: "audio", multiple: false,
    audio: { maxDurationSeconds: 500, maxBytes: 52428800 },
  };
  assert.equal(readWorkflowParamDefinitionError(audio), undefined);
  assert.match(readWorkflowParamDefinitionError({ ...audio, type: "string" } as never) ?? "", /type: "file"/);
  assert.match(readWorkflowParamDefinitionError({ ...audio, multiple: true } as never) ?? "", /single file/);
  assert.match(readWorkflowParamDefinitionError({ ...audio, audio: { maxBytes: 0 } } as never) ?? "", /positive/);
  assert.match(readWorkflowParamDefinitionError({ ...audio, audio: { maxBytes: 1.5 } } as never) ?? "", /integer/);
  const violations = validateWorkflowScriptSource([
    "const w = workflow.defineWorkflow({ name: 'audio', run: async () => ({ errCode: 0, errMessage: '' }) });",
    "export const executor = workflow.defineExecutor({ projectType: 'workflow', defaultEntrypoint: 'main', entrypoints: [workflow.defineEntrypoint({ id: 'main', title: 'Main', workflow: w, params: [{ name: 'audio', flag: '--audio', type: 'file', control: 'audio', multiple: true }, { name: 'audioLimit', flag: '--audio-limit', type: 'file', control: 'audio', audio: { maxBytes: 0 } }], createInput({ paramValues }) { return paramValues; } })] });",
  ].join("\n"));
  assert.ok(violations.some((violation) => violation.type === "invalid_executor_param_configuration" && /single file/.test(violation.message)));
  assert.ok(violations.some((violation) => violation.type === "invalid_executor_param_configuration" && /positive/.test(violation.message)));
});

test("date params reject invalid type, quick, options and multiple combinations", () => {
  const violations = validateWorkflowScriptSource([
    "const testWorkflow = workflow.defineWorkflow({ name: 'invalid-date-params', run: async () => ({ errCode: 0, errMessage: '' }) });",
    "export const executor = workflow.defineExecutor({",
    "  projectType: 'workflow',",
    "  defaultEntrypoint: 'main',",
    "  entrypoints: [workflow.defineEntrypoint({",
    "    id: 'main', title: 'Main', workflow: testWorkflow,",
    "    params: [",
    "    { name: 'wrongType', flag: '--wrong-type', type: 'number', control: 'date' },",
    "    { name: 'quickDate', flag: '--quick-date', type: 'string', control: 'time', panel: 'quick' },",
    "    { name: 'optionDate', flag: '--option-date', type: 'string', control: 'datetime', options: [] },",
    "    { name: 'multipleDate', flag: '--multiple-date', type: 'string', control: 'date-range', multiple: true },",
    "    ],",
    "    createInput({ paramValues }) { return paramValues; },",
    "  })],",
    "});",
  ].join("\n"));
  const dateViolations = violations.filter((violation) => violation.type === "invalid_executor_param_configuration");

  assert.deepEqual(dateViolations.map((violation) => violation.name), [
    "wrongType",
    "quickDate",
    "optionDate",
    "multipleDate",
  ]);
  assert.match(dateViolations[0]?.message ?? "", /type: "string"/);
  assert.match(dateViolations[1]?.message ?? "", /panel: "quick"/);
  assert.match(dateViolations[2]?.message ?? "", /cannot declare options/);
  assert.match(dateViolations[3]?.message ?? "", /multiple: true/);

  assert.throws(() => defineWorkflowExecutor({
    params: [{ name: "hiddenDate", type: "string", control: "date", panel: "quick" }],
  } as never), /must declare placement through/);
});

test("static structure and runtime resolver share quick param metadata", async () => {
  const workflowDir = await createResolverWorkflow();
  const structure = inspectLocalWorkflowStructure({ workflowDir });
  const entrypoint = structure.entrypoints?.[0];
  assert.equal(entrypoint?.params?.[0]?.panel, "quick");
  assert.deepEqual(entrypoint?.paramLayout?.actions, [{
    kind: "quick", id: "writing", label: "Writing", summary: ["tone"],
    params: ["tone", "sources", "dynamic"],
  }]);
  assert.equal(entrypoint?.params?.[0]?.resolveOnInput, true);
  // The step a declared field is asked in survives the static extraction, so a
  // host can page a prompt whose questions were written in the source.
  assert.equal(entrypoint?.params?.[0]?.step, 2);
  assert.equal(entrypoint?.params?.find((param) => param.name === "dynamic")?.options, undefined);
  assert.deepEqual(entrypoint?.paramResolver, { enabled: true });

  const result = await resolveLocalWorkflowParams({
    workflowDir,
    request: {
      draftText: "please search docs",
      args: ["--tone", "precise"],
      inputMode: "form",
      trigger: { kind: "input" },
    },
  });

  assert.deepEqual(result, {
    params: {
      tone: { value: "precise", options: { creative: { disabled: true } } },
      sources: { value: ["docs"] },
    },
  });
});

test("server-only parameter resolution loads project server credentials before importing user code", async () => {
  const workflowDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-server-param-resolver-"));
  const projectId = "917a6ac8-c01a-43db-b892-71c1d922bb92";
  const importMarker = "__workflowServerParamResolverImported";
  const envNames = [
    "STEAMHARNESS_CLI_AUTH_DIR",
    "STEAMHARNESS_PERSISTENT_VALUE_SERVER_URL",
    "STEAMHARNESS_PERSISTENT_VALUE_SERVER_TOKEN",
    "STEAMHARNESS_SERVER_URL",
    "STEAMHARNESS_SERVER_ADMIN_KEY",
  ] as const;
  const previousEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  delete (globalThis as Record<string, unknown>)[importMarker];
  process.env.STEAMHARNESS_CLI_AUTH_DIR = path.join(workflowDir, "empty-auth");
  for (const name of envNames.slice(1)) delete process.env[name];
  await writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
    id: projectId,
    name: "server-param-resolver",
    type: "module",
    steamHarness: { projectInfo: { dataStorage: { mode: "server" } } },
  }));
  await writeFile(path.join(workflowDir, "index.ts"), [
    `(globalThis as Record<string, unknown>)[${JSON.stringify(importMarker)}] = true;`,
    "const serverWorkflow = workflow.defineWorkflow({ name: 'server-param-resolver', run: async () => ({ errCode: 0, errMessage: '' }) });",
    "export const executor = workflow.defineExecutor({",
    "  projectType: 'workflow',",
    "  defaultEntrypoint: 'main',",
    "  entrypoints: [workflow.defineEntrypoint({",
    "    id: 'main', title: 'Main', workflow: serverWorkflow,",
    "    params: [{ name: 'value', flag: '--value', type: 'string' }],",
    "    createInput({ paramValues }) { return paramValues; },",
    "    resolveParams() { return { params: { value: { value: 'server' } } }; },",
    "  })],",
    "});",
    "export { serverWorkflow as workflow };",
    "export default serverWorkflow;",
  ].join("\n"));
  const request = {
    draftText: "",
    args: [],
    inputMode: "form" as const,
    trigger: { kind: "init" as const },
  };
  const store: KVStore = {
    async getValue() { return undefined; },
    async setValue() {},
    async deleteValue() { return false; },
  };

  try {
    await assert.rejects(
      resolveLocalWorkflowParams({ workflowDir, request }),
      /authenticated server connection/,
    );
    assert.equal((globalThis as Record<string, unknown>)[importMarker], undefined);

    await writeFile(path.join(workflowDir, ".env"), [
      "STEAMHARNESS_SERVER_URL=https://server.example.test",
      "STEAMHARNESS_SERVER_ADMIN_KEY=project-env-key",
      "",
    ].join("\n"));
    assert.deepEqual(await resolveLocalWorkflowParams({
      workflowDir,
      request,
    }), {
      params: { value: { value: "server" } },
    });
    assert.equal((globalThis as Record<string, unknown>)[importMarker], true);

    assert.deepEqual(await resolveLocalWorkflowParams({
      workflowDir,
      request,
      storage: {
        host: "server",
        server: {
          kvStore: store,
          persistentValueStore: store,
        },
      },
    }), {
      params: { value: { value: "server" } },
    });
  } finally {
    delete (globalThis as Record<string, unknown>)[importMarker];
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(workflowDir, { recursive: true, force: true });
  }
});

test("date-related params pass their exact strings to args and createInput paramValues", async () => {
  const workflowDir = await createDateParamWorkflow();
  const args = [
    "--day", "2026-07-26",
    "--time", "08:09:10",
    "--starts-at", "2026-07-26T08:09:10",
    "--period", "2026-07-01/2026-07-31",
  ];
  const result = await runLocalWorkflow({ workflowDir, args });
  assert.equal(result.ok, true);
  const resultData = result.ok
    ? result.data as { output?: { items?: Array<{ content?: unknown }> } }
    : undefined;

  assert.deepEqual(resultData?.output?.items?.[0]?.content, {
    errCode: 0,
    errMessage: "",
    args,
    paramValues: {
      day: "2026-07-26",
      time: "08:09:10",
      startsAt: "2026-07-26T08:09:10",
      period: "2026-07-01/2026-07-31",
    },
  });
});

async function createResolverWorkflow(): Promise<string> {
  const workflowDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-param-resolver-"));
  await writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
    id: "11111111-1111-4111-8111-111111111111",
    name: "@steamharness/param-resolver-test",
    type: "module",
    steamHarness: { projectInfo: { dataStorage: { mode: "local" } } },
  }));
  await writeFile(path.join(workflowDir, "index.ts"), [
    "const testWorkflow = workflow.defineWorkflow({ name: 'param-resolver-test', run: async () => ({ errCode: 0, errMessage: '' }) });",
    "export const executor = workflow.defineExecutor({",
    "  projectType: 'workflow',",
    "  defaultEntrypoint: 'main',",
    "  entrypoints: [workflow.defineEntrypoint({",
    "    id: 'main', title: 'Main', workflow: testWorkflow,",
    "    params: [",
    "    { kind: 'quick', id: 'writing', label: 'Writing', summary: ['tone'], fields: [",
    "      { name: 'tone', flag: '--tone', type: 'string', defaultValue: 'balanced', control: 'select', resolveOnInput: true, step: 2, options: [{ value: 'precise' }, { value: 'creative' }] },",
    "      { name: 'sources', flag: '--sources', type: 'string', control: 'checkboxes', options: [{ value: 'web' }, { value: 'docs' }] },",
    "      { name: 'dynamic', flag: '--dynamic', type: 'string', control: 'select', options: [] },",
    "    ] },",
    "    ],",
    "    createInput({ paramValues }) { return paramValues; },",
    "    resolveParams({ draftText, paramValues }) {",
    "    return { params: {",
    "      tone: { value: paramValues.tone, options: { creative: { disabled: draftText.includes('docs') } } },",
    "      sources: { value: draftText.includes('docs') ? ['docs'] : [] },",
    "    } };",
    "    },",
    "  })],",
    "});",
    "export { testWorkflow as workflow };",
    "export default testWorkflow;",
  ].join("\n"));
  return workflowDir;
}

async function createDateParamWorkflow(): Promise<string> {
  const workflowDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-date-param-"));
  await writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
    id: "22222222-2222-4222-8222-222222222222",
    name: "@steamharness/date-param-test",
    type: "module",
    steamHarness: { projectInfo: { dataStorage: { mode: "local" } } },
  }));
  await writeFile(path.join(workflowDir, "index.ts"), [
    "const outputNode = workflow.createOutputNode({ name: 'output', format(input) { return input; } });",
    "const dateParamWorkflow = workflow.defineWorkflow({",
    "  name: 'date-param-test',",
    "  run(input, context) { return workflow.runNode(outputNode, input, context); },",
    "});",
    "export const executor = workflow.defineExecutor({",
    "  projectType: 'workflow',",
    "  defaultEntrypoint: 'main',",
    "  entrypoints: [workflow.defineEntrypoint({",
    "    id: 'main', title: 'Main', workflow: dateParamWorkflow,",
    "    params: [",
    "    { name: 'day', flag: '--day', type: 'string', control: 'date' },",
    "    { name: 'time', flag: '--time', type: 'string', control: 'time' },",
    "    { name: 'startsAt', flag: '--starts-at', type: 'string', control: 'datetime' },",
    "    { name: 'period', flag: '--period', type: 'string', control: 'date-range' },",
    "    ],",
    "    createInput({ args, paramValues }) {",
    "      return { errCode: 0, errMessage: '', args, paramValues };",
    "    },",
    "  })],",
    "});",
    "export { dateParamWorkflow as workflow };",
    "export default dateParamWorkflow;",
  ].join("\n"));
  return workflowDir;
}
