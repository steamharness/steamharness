import assert from "node:assert/strict";
import test from "node:test";
import { defineBot } from "../agent/bot";
import { createAgentProjectInput, createAgentProjectParams } from "../agent/project";
import { normalizeProjectParamDeclarations } from "../executor/param-definition";
import { parseProjectParamValues, validateProjectParamResolveResult } from "../executor/params";
import { analyzeProjectScriptSource } from "../executor/rules";
import { withUserSettings } from "../user-settings";
import type { ParamResolverContext, ParamValues } from "../executor/types";

const resolverContext = (values: ParamValues = {}): ParamResolverContext => ({ projectName: "test", projectDir: ".", draftText: "", inputMode: "form", args: [], paramValues: values, config: {}, trigger: { kind: "init" }, abortSignal: new AbortController().signal });
const customized = { modelSource: "project" as const, paramOptions: { fields: {
  effort: { defaultValue: "medium" }, plan: false as const, permissionPolicy: { visible: false, fixedValue: "auto" },
} } };

test("Bot inherits the Core parameter contract, independent model and effort controls, and resolver", async () => {
  const bot = defineBot();
  assert.equal(bot.projectType, "bot");
  const normalized = normalizeProjectParamDeclarations(bot.params);
  assert.deepEqual(normalized.params.map(p => p.name), ["provider", "model", "effort", "plan", "permissionPolicy"]);
  assert.deepEqual(normalized.layout?.actions.map(a => a.kind), ["quick", "quick", "slash", "quick"]);
  const values = withUserSettings({ agent: { permissionPolicy: "read-only" } }, () => parseProjectParamValues(bot.params, []));
  assert.equal(values.effort, "high"); assert.equal(values.plan, "false"); assert.equal(values.permissionPolicy, "read-only");
  const result = await bot.resolveParams!(resolverContext());
  assert.deepEqual(result.params?.provider, { visible: false, disabled: true, value: null, resolvedOptions: [] });
  assert.doesNotThrow(() => validateProjectParamResolveResult(bot.params, result));
});

test("Bot parameter customization remains isolated and enforces fixed values", async () => {
  const bot = defineBot({ agent: customized });
  defineBot({ agent: { effort: "max" } });
  const fields = normalizeProjectParamDeclarations(bot.params).params;
  assert.equal(fields.some(p => p.name === "plan"), false);
  for (const permissionPolicy of ["read-only", "workspace", "auto"] as const) {
    await withUserSettings({ agent: { permissionPolicy } }, async () => {
      const input = await bot.createInput({ ...resolverContext(), args: ["--message", "Question"], paramValues: { permissionPolicy: "read-only" } });
      assert.equal(input.permissionPolicy, "auto"); assert.equal(input.effort, "medium");
      assert.deepEqual((await bot.resolveParams!(resolverContext())).params?.permissionPolicy, { value: "auto", visible: false, disabled: true });
    });
  }
});

test("business params append to Core fields and cannot replace reserved fields", async () => {
  const bot = defineBot({ params: [{ kind: "auxiliary", id: "business", label: "Business", fields: [{ name: "topic", flag: "--topic", type: "string" }] }],
    resolveParams: () => ({ params: { topic: { value: "approved" } } }) });
  assert.equal(normalizeProjectParamDeclarations(bot.params).params.length, 6);
  assert.equal((await bot.resolveParams!(resolverContext())).params?.topic?.value, "approved");
  assert.throws(() => defineBot({ params: [{ kind: "auxiliary", id: "bad", label: "Bad", fields: [{ name: "model", type: "string" }] }] }), /paramOptions/);
});

test("input parsing retains business defaults and ignores disabled fields", async () => {
  const input = createAgentProjectInput({ args: ["--message", "Question", "--model", "raw"], paramValues: { model: "resolved" } }, {
    ...customized, workdir: "/business", allowedDirectories: ["../linked"], systemPrompt: "Business prompt", webSearch: false,
  });
  assert.equal(input.model, "resolved"); assert.equal(input.systemPrompt, "Business prompt"); assert.equal(input.workdir, "/business");
  const bot = defineBot({ agent: { paramOptions: { fields: { plan: false, effort: false } } } });
  await withUserSettings({ agent: { permissionPolicy: "read-only" } }, async () => {
    const parsed = await bot.createInput({ ...resolverContext(), args: ["--message", "Question", "--agent", "plan"], paramValues: { plan: "true", effort: "max", permissionPolicy: "auto" } });
    assert.equal(parsed.agent, undefined); assert.equal(parsed.effort, undefined); assert.equal(parsed.permissionPolicy, "read-only");
  });
});

test("static Bot inspection expands the same contract without executing hooks", () => {
  const report = analyzeProjectScriptSource(`throw new Error("never execute"); export const executor = steamharness.defineBot({
    agent: ${JSON.stringify(customized)}, prepareInput() { throw new Error("never execute"); } });`);
  assert.deepEqual(report.executorConfigurationViolations, []);
  const normalized = normalizeProjectParamDeclarations(createAgentProjectParams(customized));
  assert.deepEqual(report.executorParams, normalized.params);
  assert.deepEqual(report.executorParamLayout, normalized.layout);
  assert.deepEqual(report.executorParamResolver, { enabled: true });
});

test("static inspection reports unresolved Bot configuration and forbidden execution overrides", () => {
  for (const agent of ['{ paramOptions: readOptions() }', '{ effort: readEffort() }', '{ ...readOptions() }', '{ outputItemId: "custom" }']) {
    const report = analyzeProjectScriptSource(`export const executor = steamharness.defineBot({ agent: ${agent} });`);
    assert.ok(report.executorConfigurationViolations.length > 0);
  }
  for (const key of ["workflow", "coreAgent", "createInput", "tokenUsage", "projectType"]) {
    assert.ok(analyzeProjectScriptSource(`export const executor = steamharness.defineBot({ ${key}: {} });`).executorConfigurationViolations.length > 0);
  }
});

test("fixed positional and multiple parameters cannot be overridden", () => {
  assert.deepEqual(parseProjectParamValues([{ name: "target", type: "positional", fixedValue: "project" },
    { name: "models", type: "string", flag: "--models", multiple: true, fixedValue: '["first","second"]' }],
    ["external", "--models", '["third"]']), { target: "project", models: ["first", "second"] });
});

test("an empty defineBot call has the same static defaults as an empty object", () => {
  const empty = analyzeProjectScriptSource("export const executor = steamharness.defineBot();");
  const object = analyzeProjectScriptSource("export const executor = steamharness.defineBot({});");
  assert.equal(empty.executorProjectType, "bot");
  assert.deepEqual(empty.executorParams, object.executorParams);
  assert.deepEqual(empty.executorConversation, object.executorConversation);
});
