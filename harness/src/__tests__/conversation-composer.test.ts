import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defineWorkflowExecutor, inspectLocalWorkflowStructure, normalizeWorkflowParamDeclarations, parseWorkflowParamValues,
  validateWorkflowParamResolveResult, type ConversationParamDeclaration, type ParamDeclaration } from "../index";

const commands = [
  { command: "export", label: "Export conversation", action: { kind: "export" as const } },
  { command: "compact", label: "Summarize context", localizedLabel: { "zh-CN": "上下文总结" }, action: { kind: "prompt" as const, text: "/compact" } },
];

test("Conversation execution commands are independent of parameters and reject collisions", () => {
  const definition = { projectType: "conversation" as const, workflow: {} as never, params, createInput: () => ({}) };
  assert.deepEqual(defineWorkflowExecutor({ ...definition, conversation: { commands } }).conversation?.commands, commands);
  for (const invalid of [
    {}, [{ ...commands[0], command: "/export" }], [commands[0], commands[0]], [{ ...commands[0], command: "plan" }],
    [{ ...commands[0], label: "" }], [{ ...commands[0], action: { kind: "shell", text: "ls" } }],
    [{ ...commands[1], action: { kind: "prompt", text: "" } }], [{ ...commands[0], localizedLabel: { en: false } }],
    [{ ...commands[0], action: { kind: "export", text: "wrong" } }],
  ]) { assert.throws(() => defineWorkflowExecutor({ ...definition, conversation: { commands: invalid as never } }), /Conversation commands/); }
});

const params: ConversationParamDeclaration[] = [
  { kind: "slash", name: "agent", flag: "--agent", type: "string", defaultValue: "build", options: [
    { value: "build", label: "Build" }, { value: "plan", label: "Plan" },
  ] },
  { kind: "slash", name: "webSearch", flag: "--web-search", type: "boolean", command: "search", label: "Web search" },
];

test("Slash selectors and booleans share the ordinary parameter value and CLI protocol", () => {
  const normalized = normalizeWorkflowParamDeclarations(params);
  assert.deepEqual(normalized.layout?.actions, [{ kind: "slash", name: "agent" }, { kind: "slash", name: "webSearch" }]);
  assert.deepEqual(normalized.params.map(({ name, panel, defaultValue }) => ({ name, panel, defaultValue })), [
    { name: "agent", panel: "slash", defaultValue: "build" }, { name: "webSearch", panel: "slash", defaultValue: "false" },
  ]);
  assert.deepEqual(parseWorkflowParamValues(params, []), { agent: "build", webSearch: "false" });
  assert.deepEqual(parseWorkflowParamValues(params, ["--agent", "plan", "--web-search", "true"]), { agent: "plan", webSearch: "true" });
  assert.deepEqual(parseWorkflowParamValues(params, ["--agent", "build", "--web-search", "false"]), { agent: "build", webSearch: "false" });
});

test("Slash declarations reject ambiguous commands, invalid selectors and Workflow placement", () => {
  const selector = params[0];
  for (const bad of [
    { kind: "slash", name: "search", flag: "--search", type: "boolean", command: "plan" },
    { kind: "slash", name: "extra", flag: "--extra", type: "string", options: [{ value: "x", command: "plan" }] },
    { kind: "slash", name: "search", flag: "--search", type: "boolean", command: "/search" },
  ]) { assert.throws(() => normalizeWorkflowParamDeclarations([selector!, bad] as never), /Slash command/); }
  for (const patch of [
    { options: [] }, { defaultValue: "unknown" }, { type: "number" }, { multiple: true }, { control: "select" },
  ]) { assert.throws(() => normalizeWorkflowParamDeclarations([{ ...selector, ...patch }] as never), /Slash parameter/); }
  assert.throws(() => defineWorkflowExecutor({ projectType: "workflow", defaultEntrypoint: "run", entrypoints: [
    { id: "run", title: "Run", workflow: {} as never, params, createInput: () => ({}) },
  ] }), /only supported by Conversation/);
});

test("Conversation footer definitions reject missing and contradictory parameter references", () => {
  for (const footer of [
    {}, [{ text: "Plan mode", param: "agent" }], [{ param: "missing" }], [{ text: "" }],
    [{ text: "Plan", when: { param: "missing", value: "plan" } }],
    [{ text: "Plan", localizedText: { en: false } }], [{ param: "agent", localizedText: { en: "Plan" } }],
  ]) {
    assert.throws(() => defineWorkflowExecutor({ projectType: "conversation", workflow: {} as never, params,
      conversation: { footer: footer as never }, createInput: () => ({}) }), /Conversation footer/);
  }
});

test("Conversation user input configures composer visibility and generic parameter effects", () => {
  const userInput = { hideComposer: false, effects: [{ when: { type: "review", nodeName: "confirm", values: { accepted: true, tags: ["ready"] } }, params: { webSearch: "false" } }] };
  const definition = { projectType: "conversation" as const, workflow: {} as never, params, createInput: () => ({}) };
  assert.deepEqual(defineWorkflowExecutor({ ...definition, conversation: { userInput } }).conversation?.userInput, userInput);
  for (const invalid of [
    [], { hideComposer: "yes" }, { effects: {} }, { effects: [{}] },
    { effects: [{ when: {}, params: { webSearch: "false" } }] },
    { effects: [{ when: { type: "" }, params: { webSearch: "false" } }] },
    { effects: [{ when: { title: "Confirm" }, params: { webSearch: "false" } }] },
    { effects: [{ when: { values: {} }, params: { webSearch: "false" } }] },
    { effects: [{ when: { values: { accepted: {} } }, params: { webSearch: "false" } }] },
    { effects: [{ when: { type: "review" }, params: {} }] },
    { effects: [{ when: { type: "review" }, params: { missing: "false" } }] },
    { effects: [{ when: { type: "review" }, params: { webSearch: false } }] },
    { effects: [{ when: { type: "review" }, params: { webSearch: "invalid" } }] },
    { effects: [{ when: { type: "review" }, params: { webSearch: null } }] },
  ]) { assert.throws(() => defineWorkflowExecutor({ ...definition, conversation: { userInput: invalid as never } }), /Conversation userInput/); }
});

test("resolved Slash options preserve aliases and reject conflicting or invalid commands", () => {
  const aliased = [{ ...params[0], defaultValue: "planning", options: [{ value: "planning", command: "plan" }] }, params[1]] as ParamDeclaration[];
  const result = { params: { agent: { resolvedOptions: [{ value: "planning", label: "Planning" }] } } };
  assert.deepEqual(validateWorkflowParamResolveResult(aliased, result), result);
  for (const option of [{ value: "search" }, { value: "other", command: "search" }, { value: "other", command: "/bad" }, { value: "other", command: 123 }]) {
    assert.throws(() => validateWorkflowParamResolveResult(params, { params: { agent: { resolvedOptions: [option] } } } as never), /[Cc]ommand/);
  }
});

test("static inspection carries Slash commands and conditional plain-text footers to hosts", async t => {
  const workflowDir = await mkdtemp(path.join(os.tmpdir(), "workflow-composer-contract-"));
  t.after(() => rm(workflowDir, { recursive: true, force: true }));
  await writeFile(path.join(workflowDir, "package.json"), JSON.stringify({ name: "composer", type: "module" }));
  const footer = [{ text: "Plan mode", localizedText: { "zh-CN": "Plan 模式" }, when: { param: "agent", value: "plan" } }, { param: "webSearch" }];
  const userInput = { hideComposer: true, effects: [{ when: { type: "review", values: { accepted: true } }, params: { webSearch: "false" } }] };
  const source = (footerSource: string, inputSource = JSON.stringify(userInput)) => `
    const task = workflow.defineWorkflow({ name: "composer", run(input) { return input; } });
    export const executor = workflow.defineExecutor({ projectType: "conversation", workflow: task,
      params: ${JSON.stringify(params)}, conversation: { commands: ${JSON.stringify(commands)}, footer: ${footerSource}, userInput: ${inputSource} }, createInput: context => context.paramValues });`;
  await writeFile(path.join(workflowDir, "index.ts"), source(JSON.stringify(footer)));
  const report = inspectLocalWorkflowStructure({ workflowDir });
  assert.deepEqual(report.diagnostics.violations, []);
  assert.deepEqual(report.conversation?.footer, footer);
  assert.deepEqual(report.conversation?.commands, commands);
  assert.deepEqual(report.conversation?.userInput, userInput);
  assert.equal(report.params?.find(param => param.name === "webSearch")?.command, "search");
  assert.deepEqual(report.paramLayout?.actions, [{ kind: "slash", name: "agent" }, { kind: "slash", name: "webSearch" }]);
  for (const invalid of ['[{ param: "missing" }]', '[{ text: getFooterText() }]', '[{ text: "Plan", when: { param: "agent", value: true } }]']) {
    await writeFile(path.join(workflowDir, "index.ts"), source(invalid));
    assert.throws(() => inspectLocalWorkflowStructure({ workflowDir }), error => {
      const violations = (error as { metadata?: { violations?: { message: string }[] } }).metadata?.violations;
      return violations?.some(violation => /footer/.test(violation.message)) === true;
    });
  }
  for (const invalid of ['{ hideComposer: getVisibility() }', '{ effects: [{ when: { type: "review" }, params: { missing: "false" } }] }']) {
    await writeFile(path.join(workflowDir, "index.ts"), source(JSON.stringify(footer), invalid));
    assert.throws(() => inspectLocalWorkflowStructure({ workflowDir }), error =>
      (error as { metadata?: { violations?: { message: string }[] } }).metadata?.violations?.some(violation => /userInput/.test(violation.message)) === true);
  }
});
