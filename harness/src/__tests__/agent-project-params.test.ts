import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentConversationProject, createAgentProjectInput, createAgentProjectParams } from "../agent/project";
import { applyAgentProjectDefaults } from "../agent/project-params";
import { defineProjectExecutor } from "../executor/definition";
import { runLocalProjectWithReport } from "../executor/index";
import { normalizeProjectParamDeclarations } from "../executor/param-definition";
import { parseProjectParamValues, validateProjectParamResolveResult } from "../executor/params";
import { analyzeProjectScriptSource } from "../executor/rules";
import { withUserSettings } from "../user-settings";
import type { AgentProjectOptions } from "../agent/types";
import type { ExecutorContext, ParamResolverContext, ParamValues } from "../executor/types";

const customized: AgentProjectOptions = {
  modelSource: "project",
  paramOptions: {
    fields: { effort: { defaultValue: "medium" }, plan: false, permissionPolicy: { visible: false, fixedValue: "auto" } },
    groups: [{ kind: "quick", id: "ai", label: "AI", fields: ["provider", "model", "effort"], summary: ["model", "effort"] }],
  },
};
const resolverContext = (values: ParamValues = {}): ParamResolverContext => ({ projectName: "test", projectDir: ".", draftText: "", inputMode: "form", args: [], paramValues: values, config: {}, trigger: { kind: "init" }, abortSignal: new AbortController().signal });

test("a selected Core workflow inherits the assistant contract and model resolver", async () => {
  const project = createAgentConversationProject();
  const executor = defineProjectExecutor({ projectType: "conversation", workflow: project, createInput: createAgentProjectInput });
  assert.equal(executor.projectType, "conversation");
  if (executor.projectType !== "conversation") return;
  const normalized = normalizeProjectParamDeclarations(executor.params);
  assert.deepEqual(normalized.params.map(p => p.name), ["provider", "model", "effort", "plan", "permissionPolicy"]);
  assert.deepEqual(normalized.layout?.actions.map(a => a.kind), ["quick", "quick", "slash", "quick"]);
  const values = withUserSettings({ agent: { permissionPolicy: "read-only" } }, () => parseProjectParamValues(executor.params, []));
  assert.equal(values.effort, "high"); assert.equal(values.plan, "false"); assert.equal(values.permissionPolicy, "read-only");
  const resolution = await executor.resolveParams!(resolverContext());
  assert.deepEqual(resolution.params?.provider, { visible: false, disabled: true, value: null, resolvedOptions: [] });
  assert.doesNotThrow(() => validateProjectParamResolveResult(executor.params, resolution));
  assert.equal(JSON.stringify(project).includes("paramOptions"), false);
});

test("wrapped business workflows inherit only their explicitly selected agent", async () => {
  const core = createAgentConversationProject(customized);
  createAgentConversationProject({ effort: "max" });
  const business = { name: "business", run: core.run };
  const executor = defineProjectExecutor({ projectType: "conversation", workflow: business, coreAgent: core, createInput: createAgentProjectInput });
  if (executor.projectType !== "conversation") return assert.fail();
  assert.equal(executor.workflow, business);
  const { params, layout } = normalizeProjectParamDeclarations(executor.params);
  assert.deepEqual(layout?.actions, [{ kind: "quick", id: "ai", label: "AI", summary: ["model", "effort"], params: ["provider", "model", "effort"] }]);
  assert.equal(params.some(p => p.name === "plan"), false);
  for (const policy of ["read-only", "workspace", "auto"] as const) {
    await withUserSettings({ agent: { permissionPolicy: policy } }, async () => {
      const values = parseProjectParamValues(executor.params, ["--permission-policy", "read-only"]);
      assert.equal(values.permissionPolicy, "auto"); assert.equal(values.effort, "medium");
      const context: ExecutorContext = { ...resolverContext(), args: ["--message", "Question"], paramValues: { ...values, permissionPolicy: "workspace" } };
      const input = await executor.createInput(context);
      assert.equal(input.permissionPolicy, "auto"); assert.equal(input.effort, "medium");
      const resolution = await executor.resolveParams!(resolverContext({ permissionPolicy: "read-only" }));
      assert.deepEqual(resolution.params?.permissionPolicy, { value: "auto", visible: false, disabled: true });
    });
  }
  const ordinary = defineProjectExecutor({ projectType: "conversation", workflow: business, createInput: createAgentProjectInput });
  assert.equal(ordinary.projectType === "conversation" && ordinary.params, undefined);
});

test("selected Core executors inherit durable control for static and context-created sessions", () => {
  for (const options of [{ session: {} }, { createSession: () => ({}) }]) {
    const core = createAgentConversationProject(options);
    const executor = defineProjectExecutor({ projectType: "conversation", workflow: { name: "business", run: core.run }, coreAgent: core, createInput: createAgentProjectInput });
    assert.equal(executor.projectType === "conversation" && executor.conversation?.durable?.enabled, true);
    assert.equal(executor.projectType === "conversation" && executor.conversation?.recovery?.enabled, true);
  }
  for (const declaration of ["session: {}", "createSession: () => ({})", "createSession(context) { return {}; }"]) {
    const source = `const coreAgent = steamharness.createAgentConversationProject({ ${declaration} });
      export const executor = steamharness.defineExecutor({ projectType: "conversation", workflow: coreAgent });`;
    const analysis = analyzeProjectScriptSource(source);
    assert.equal(analysis.executorConversation?.durable?.enabled, true);
  }
});

test("explicit parameter replacement and custom resolution remain independent", async () => {
  const project = createAgentConversationProject();
  const executor = defineProjectExecutor({ projectType: "conversation", workflow: project, params: [], createInput: createAgentProjectInput });
  if (executor.projectType !== "conversation") return assert.fail();
  assert.deepEqual(await executor.resolveParams!(resolverContext()), { params: {} });
  const other = defineProjectExecutor({ projectType: "conversation", workflow: project, createInput: createAgentProjectInput });
  assert.equal(other.projectType === "conversation" && other.params?.length, 4);
  const custom = defineProjectExecutor({ projectType: "conversation", workflow: project, params: [], createInput: createAgentProjectInput,
    resolveParams: () => ({ params: { invalid: { value: "invalid" } } }) });
  if (custom.projectType !== "conversation") return assert.fail();
  const result = await custom.resolveParams!(resolverContext());
  assert.throws(() => validateProjectParamResolveResult(custom.params, result), /Unknown parameter/);
  const fixed = defineProjectExecutor({ projectType: "conversation", workflow: project, params: [
    { kind: "quick", id: "choices", label: "Choices", summary: ["choices"], fields: [
      { name: "choices", flag: "--choices", type: "string", control: "checkboxes", fixedValue: '["one","two"]' },
    ] },
  ], createInput: createAgentProjectInput, resolveParams: () => ({ params: {} }) });
  if (fixed.projectType !== "conversation") return assert.fail();
  const fixedResult = await fixed.resolveParams!(resolverContext());
  assert.deepEqual(fixedResult.params?.choices?.value, ["one", "two"]);
  assert.doesNotThrow(() => validateProjectParamResolveResult(fixed.params, fixedResult));
});

test("field customization replaces user bindings and validates groups", () => {
  const params = createAgentProjectParams({ paramOptions: { fields: { permissionPolicy: { defaultValue: "workspace" }, model: { userSetting: null }, effort: { visible: false } } } });
  const normalized = normalizeProjectParamDeclarations(params);
  assert.equal(normalized.params.find(p => p.name === "permissionPolicy")?.userSetting, undefined);
  assert.equal(normalized.params.find(p => p.name === "model")?.userSetting, undefined);
  assert.equal(normalized.layout?.actions.some(a => "id" in a && a.id === "effort"), false);
  assert.throws(() => createAgentProjectParams({ paramOptions: { groups: [{ kind: "quick", id: "ai", label: "AI", fields: ["model", "model"], summary: ["model"] }] } }), /assigned once/);
  assert.throws(() => createAgentProjectParams({ paramOptions: { fields: { model: false }, groups: [{ kind: "quick", id: "ai", label: "AI", fields: ["model"], summary: ["model"] }] } }), /enabled/);
  assert.throws(() => createAgentProjectParams({ paramOptions: { fields: { plan: null } } } as unknown as AgentProjectOptions), /object or false/);
  assert.equal(normalizeProjectParamDeclarations(createAgentProjectParams({ model: "developer-model" })).params.find(p => p.name === "model")?.userSetting, undefined);
  assert.equal(normalizeProjectParamDeclarations(createAgentProjectParams({ model: "developer-model" })).params.find(p => p.name === "model")?.defaultValue, "developer-model");
  const disabledModel = normalizeProjectParamDeclarations(createAgentProjectParams({ paramOptions: { fields: { model: false } } }));
  assert.equal(disabledModel.params.some(p => p.name === "model"), false);
  assert.deepEqual(disabledModel.layout?.actions[0], { kind: "quick", id: "model", label: "Model", icon: "sparkle", summary: ["provider"], params: ["provider"] });
  const regrouped = normalizeProjectParamDeclarations(createAgentProjectParams({ paramOptions: { groups: [
    { kind: "quick", id: "choice", label: "Choice", fields: ["model"], summary: ["model"] },
    { kind: "auxiliary", id: "advanced", label: "Advanced", fields: ["plan"] },
  ] } }));
  assert.equal(regrouped.params.find(p => p.name === "plan")?.panel, "auxiliary");
  assert.equal(regrouped.layout?.actions.some(a => a.kind === "slash"), false);
});

test("declared visibility overrides model resolver visibility", async () => {
  const project = createAgentConversationProject({ paramOptions: { fields: { provider: { visible: true } } } });
  const executor = defineProjectExecutor({ projectType: "conversation", workflow: project, createInput: createAgentProjectInput });
  if (executor.projectType !== "conversation") return assert.fail();
  assert.equal((await executor.resolveParams!(resolverContext())).params?.provider?.visible, true);
});

test("input helpers preserve business defaults and consume resolved values before enforcing fixed fields", () => {
  const options: AgentProjectOptions = { ...customized, workdir: "/business", allowedDirectories: ["../linked"], systemPrompt: "Business prompt", webSearch: false };
  const input = createAgentProjectInput({ args: ["--message", "Question", "--model", "raw", "--effort", "low", "--plan", "true", "--permission-policy", "read-only"],
    paramValues: { model: "resolved", effort: "medium", permissionPolicy: "workspace" } }, options);
  assert.equal(input.model, "resolved");
  assert.equal(input.effort, "medium");
  assert.equal(input.permissionPolicy, "auto");
  assert.equal(input.agent, undefined);
  assert.equal(input.systemPrompt, "Business prompt");
  assert.equal(input.workdir, "/business");
  assert.deepEqual(input.allowedDirectories, ["../linked"]);
  assert.notEqual(input.allowedDirectories, options.allowedDirectories);
  assert.equal(input.webSearch, false);
  assert.equal(input.prompt, "Question");
  const raw = createAgentProjectInput(["--message", "Question", "--plan", "true", "--permission-policy", "workspace"], options);
  assert.equal(raw.agent, undefined);
  assert.equal(raw.permissionPolicy, "auto");
  const fixedPlan = createAgentProjectInput({ args: [], paramValues: { plan: "false" } }, { paramOptions: { fields: { plan: { fixedValue: "true" } } } });
  assert.equal(fixedPlan.agent, "plan");
});

test("context input uses only the selected contract's enabled defaults", async () => {
  const core = createAgentConversationProject({ paramOptions: { fields: {
    effort: { defaultValue: "medium" }, plan: false, permissionPolicy: false,
  } } });
  const executor = defineProjectExecutor({ projectType: "conversation", workflow: core, createInput: createAgentProjectInput });
  if (executor.projectType !== "conversation") return assert.fail();
  const input = await executor.createInput({ ...resolverContext(), args: ["--message", "Question", "--plan", "true", "--permission-policy", "read-only"] });
  assert.equal(input.effort, "medium");
  assert.equal(input.agent, undefined);
  assert.equal(input.permissionPolicy, undefined);
  const disabled = createAgentProjectInput({ args: ["--effort", "low"], paramValues: {} });
  assert.equal(disabled.effort, undefined);
  assert.equal(disabled.agent, undefined);
  assert.equal(disabled.permissionPolicy, undefined);
});

test("omitted and undefined inputs inherit the same Core parameter defaults", () => {
  const params = createAgentProjectParams({ model: "project-model" });
  const input = { errCode: 0, errMessage: "", prompt: "Question" };
  const omitted = applyAgentProjectDefaults(input, params);
  const undefinedFields = applyAgentProjectDefaults({ ...input, model: undefined, effort: undefined, agent: undefined, permissionPolicy: undefined }, params);
  assert.deepEqual(undefinedFields, omitted);
  assert.equal(undefinedFields.effort, "high");
  assert.equal(undefinedFields.model, "project-model");
});

test("legacy model aliases override defaults while disabled fields stay disabled", () => {
  assert.equal(createAgentProjectInput(["-m", "selected"], { model: "default" }).model, "selected");
  assert.equal(createAgentProjectInput(["-m", "selected", "--model", "last"], { model: "default" }).model, "last");
  assert.equal(createAgentProjectInput(["-m", "selected"], { paramOptions: { fields: { model: false } } }).model, undefined);
});

test("inherited input keeps legacy aliases and ignores parameter-like message text", async () => {
  const core = createAgentConversationProject({ model: "default" });
  const executor = defineProjectExecutor({ projectType: "conversation", workflow: core, createInput: createAgentProjectInput });
  if (executor.projectType !== "conversation") return assert.fail();
  for (const [args, expected] of [
    [["--message", "Question", "-m", "selected"], { model: "selected", agent: "build" }],
    [["--message", "Question", "-m", "selected", "--model", "last"], { model: "last", agent: "build" }],
    [["--message", "Question", "--agent", "plan"], { model: "default", agent: "plan" }],
    [["--message", "Question", "--agent", "plan", "--plan", "false"], { model: "default", agent: "build" }],
    [["--message", "--plan"], { model: "default", agent: "build" }],
    [["--message", "-m"], { model: "default", agent: "build" }],
  ] as const) {
    const input = await executor.createInput({ ...resolverContext(), args: [...args] });
    assert.equal(input.model, expected.model);
    assert.equal(input.agent, expected.agent);
  }
  for (const model of ["resolved", "default"]) {
    const resolved = await executor.createInput({ ...resolverContext(), args: ["-m", "raw"], paramValues: { model } });
    assert.equal(resolved.model, model);
  }
  const fixed = defineProjectExecutor({ projectType: "conversation", workflow: createAgentConversationProject({ paramOptions: { fields: { plan: { fixedValue: "false" } } } }), createInput: createAgentProjectInput });
  if (fixed.projectType !== "conversation") return assert.fail();
  assert.equal((await fixed.createInput({ ...resolverContext(), args: ["--agent", "plan"] })).agent, "build");
});

test("offline execution resolves inherited aliases before constructing input", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-param-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "agent-param-runtime", version: "0.0.0", type: "module" }));
  await writeFile(path.join(directory, "steamharness.json"), JSON.stringify({ id: randomUUID(), name: "Agent params", version: "1.0.0",
    defaultEntry: "main", entries: [{ entryId: "main", name: "Main", type: "conversation", root: ".", entry: "index.ts", databases: [] }],
  }));
  await writeFile(path.join(directory, "index.ts"), `
    const coreAgent = steamharness.createAgentConversationProject({ model: "default" });
    const workflow = steamharness.defineProject({ name: "Echo parameters", async run(input) { return input; } });
    export const executor = steamharness.defineExecutor({ projectType: "conversation", workflow, coreAgent,
      createInput(context) { return steamharness.createAgentProjectInput(context); }
    });
  `);
  for (const [args, model, agent] of [
    [["--message", "Question", "-m", "selected", "--agent", "plan"], "selected", "plan"],
    [["--message", "--plan"], "default", "build"],
  ] as const) {
    const report = await runLocalProjectWithReport({ projectDir: directory, args: [...args] });
    assert.equal(report.status, "success", JSON.stringify(report.result));
    if (report.result.ok) {
      const output = (report.result.data as { output: { model: string; agent: string } }).output;
      assert.equal(output.model, model);
      assert.equal(output.agent, agent);
    }
  }
});

test("inherited contexts discard disabled fields and enforce fixed user bindings", async () => {
  const core = createAgentConversationProject({ paramOptions: { fields: { plan: false, effort: false } } });
  const executor = defineProjectExecutor({ projectType: "conversation", workflow: core, createInput: createAgentProjectInput });
  if (executor.projectType !== "conversation") return assert.fail();
  await withUserSettings({ agent: { permissionPolicy: "read-only" } }, async () => {
    const input = await executor.createInput({ ...resolverContext(), args: ["--message", "Question", "--agent", "plan"], paramValues: { plan: "true", effort: "max", permissionPolicy: "auto" } });
    assert.equal(input.agent, undefined);
    assert.equal(input.effort, undefined);
    assert.equal(input.permissionPolicy, "read-only");
  });
  const input = createAgentProjectInput({ args: [], paramValues: { plan: "true", effort: "max" } }, { paramOptions: { fields: { plan: false, effort: false } } });
  assert.equal(input.agent, undefined);
  assert.equal(input.effort, undefined);
});

test("undefined field overrides preserve defaults and user bindings", () => {
  const options: AgentProjectOptions = { paramOptions: { fields: { model: { userSetting: undefined }, effort: { defaultValue: undefined } } } };
  assert.deepEqual(createAgentProjectParams(options), createAgentProjectParams());
  const report = analyzeProjectScriptSource(`const workflow = steamharness.createAgentConversationProject({ paramOptions: { fields: { model: { userSetting: undefined }, effort: { defaultValue: undefined } } } }); export const executor = steamharness.defineExecutor({ projectType: "conversation", workflow });`);
  assert.deepEqual(report.executorConfigurationViolations, []);
  assert.deepEqual(report.executorParams, normalizeProjectParamDeclarations(createAgentProjectParams()).params);
});

test("fixed positional and multiple parameters cannot be overridden by argv", () => {
  assert.deepEqual(parseProjectParamValues([
    { name: "target", type: "positional", fixedValue: "project" },
    { name: "models", type: "string", flag: "--models", multiple: true, fixedValue: '["first","second"]' },
  ], ["external", "--models", '["third"]']), { target: "project", models: ["first", "second"] });
});

test("static inspection expands the same selected contract without executing code", () => {
  const source = `throw new Error("never execute");
    const selected = steamharness.createAgentConversationProject(${JSON.stringify(customized)});
    const unrelated = steamharness.createAgentConversationProject({ effort: "max" });
    const business = steamharness.defineProject({ name: "business", run(input, context) { return selected.run(input, context); } });
    export const executor = steamharness.defineExecutor({ projectType: "conversation", workflow: business, coreAgent: selected, createInput: steamharness.createAgentProjectInput });`;
  const report = analyzeProjectScriptSource(source);
  assert.deepEqual(report.executorConfigurationViolations, []);
  const normalized = normalizeProjectParamDeclarations(createAgentProjectParams(customized));
  assert.deepEqual(report.executorParams, normalized.params);
  assert.deepEqual(report.executorParamLayout, normalized.layout);
  assert.deepEqual(report.executorParamResolver, { enabled: true });
});

test("static discovery supports direct factories and imported aliases", () => {
  for (const source of [
    'const selected = steamharness.createAgentConversationProject();',
    'import { createAgentConversationProject as makeAgent } from "steamharness/agent"; const selected = makeAgent();',
  ]) {
    const report = analyzeProjectScriptSource(`${source} export const executor = steamharness.defineExecutor({ projectType: "conversation", workflow: selected, createInput: steamharness.createAgentProjectInput });`);
    assert.deepEqual(report.executorParams, normalizeProjectParamDeclarations(createAgentProjectParams()).params);
  }
});

test("static discovery supports shorthand references and namespace import aliases", () => {
  const expected = normalizeProjectParamDeclarations(createAgentProjectParams(customized));
  for (const source of [
    `const workflow = steamharness.createAgentConversationProject(${JSON.stringify(customized)}); export const executor = steamharness.defineExecutor({ projectType: "conversation", workflow });`,
    `const coreAgent = steamharness.createAgentConversationProject(${JSON.stringify(customized)}); const workflow = steamharness.defineProject({ name: "business", run(input, context) { return coreAgent.run(input, context); } }); export const executor = steamharness.defineExecutor({ projectType: "conversation", workflow, coreAgent });`,
    `import * as core from "steamharness/agent"; const selected = core.createAgentConversationProject(${JSON.stringify(customized)}); export const executor = steamharness.defineExecutor({ projectType: "conversation", workflow: selected });`,
  ]) {
    const report = analyzeProjectScriptSource(source);
    assert.deepEqual(report.executorConfigurationViolations, []);
    assert.deepEqual(report.executorParams, expected.params);
    assert.deepEqual(report.executorParamLayout, expected.layout);
    assert.deepEqual(report.executorParamResolver, { enabled: true });
  }
});

test("dynamic Core parameter configuration reports a diagnostic instead of disappearing", () => {
  for (const options of ['{ paramOptions: readOptions() }', '{ effort: readEffort() }', '{ ...readOptions() }']) {
    const report = analyzeProjectScriptSource(`const agent = steamharness.createAgentConversationProject(${options}); export const executor = steamharness.defineExecutor({ projectType: "conversation", workflow: agent });`);
    assert.ok(report.executorConfigurationViolations.some(v => v.type === "invalid_executor_param_configuration"));
  }
});
