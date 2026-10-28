import assert from "node:assert/strict";
import test from "node:test";
import { getUserSettings, parseUserSettings, withUserSettings } from "../user-settings";
import { projectRuntimeApi } from "../runtime-api";
import { parseAgentInput } from "../agent/runtime";
import type { AgentPermissionPolicy, AgentPermissionPolicySetting } from "../agent/types";

test("user settings default to auto and are exposed to project code", () => {
  assert.equal(getUserSettings().agent.permissionPolicy, "auto");
  assert.equal(projectRuntimeApi.getUserSettings, getUserSettings);
  assert.ok(Object.isFrozen(getUserSettings()));
  assert.ok(Object.isFrozen(getUserSettings().agent));
});

test("host settings are validated, copied and isolated across asynchronous executions", async () => {
  for (const value of [undefined, null, [], {}, { agent: [] }, { agent: { permissionPolicy: "inherit" } }, { agent: { permissionPolicy: "invalid" } }]) {
    assert.throws(() => parseUserSettings(value), /Invalid user settings/);
  }
  const input = { agent: { permissionPolicy: "read-only" as AgentPermissionPolicy } };
  const seen = await Promise.all([
    withUserSettings(input, async () => {
      input.agent.permissionPolicy = "auto";
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(getUserSettings().agent.permissionPolicy, "read-only");
      assert.throws(() => { (getUserSettings().agent as { permissionPolicy: string }).permissionPolicy = "auto"; });
      return withUserSettings({ agent: { permissionPolicy: "workspace" } }, () => getUserSettings().agent.permissionPolicy);
    }),
    withUserSettings({ agent: { permissionPolicy: "auto" } }, async () => {
      await Promise.resolve();
      return getUserSettings().agent.permissionPolicy;
    }),
  ]);
  assert.deepEqual(seen, ["workspace", "auto"]);
  assert.equal(getUserSettings().agent.permissionPolicy, "auto");
  assert.throws(() => withUserSettings({ agent: { permissionPolicy: "read-only" } }, () => { throw new Error("host failure"); }), /host failure/);
  assert.equal(getUserSettings().agent.permissionPolicy, "auto");
});

test("permission inheritance preserves input precedence and the existing omitted default", () => {
  const input = { prompt: "hello", errCode: 0, errMessage: "" };
  const policies: (AgentPermissionPolicySetting | undefined)[] = [undefined, "read-only", "workspace", "auto", "inherit"];
  for (const user of ["read-only", "workspace", "auto"] as const) {
    withUserSettings({ agent: { permissionPolicy: user } }, () => {
      for (const defaults of policies) for (const run of policies) {
        const selected = run ?? defaults ?? "workspace";
        assert.equal(parseAgentInput({ ...input, permissionPolicy: run }, { permissionPolicy: defaults }).permissionPolicy,
          selected === "inherit" ? user : selected);
      }
    });
  }
  assert.equal(parseAgentInput({ ...input, permissionPolicy: "inherit" }, {}).permissionPolicy, "auto");
});

test("parameter bindings resolve user defaults, optional overrides and fixed values in the execution scope", async () => {
  const { parseProjectParamValues, createAgentProjectInput, createAgentProjectParams, normalizeProjectParamDeclarations } = await import("../index");
  const params = (mode: "fixed" | "default") => [{ name: "access", flag: "--access", type: "string" as const,
    userSetting: { key: "agent.permissionPolicy" as const, mode } }];
  for (const policy of ["read-only", "workspace", "auto"] as const) {
    withUserSettings({ agent: { permissionPolicy: policy } }, () => {
      assert.equal(parseProjectParamValues(params("default"), []).access, policy);
      assert.equal(parseProjectParamValues(params("default"), ["--access", "workspace"]).access, "workspace");
      assert.equal(parseProjectParamValues(params("default"), ["--access", ""]).access, policy);
      assert.equal(parseProjectParamValues(params("default"), ["--access", "inherit"]).access, policy);
      assert.equal(parseProjectParamValues(params("fixed"), ["--access", "workspace"]).access, policy);
      assert.equal(createAgentProjectInput(["--message", "hello"], { permissionPolicy: "inherit" }).permissionPolicy, policy);
      assert.equal(createAgentProjectInput(["--permission-policy", "workspace"], { permissionPolicy: "inherit" }).permissionPolicy, policy);
      assert.equal(createAgentProjectInput(["--permission-policy", "workspace"], { paramOptions: { fields: { permissionPolicy: { userSetting: { key: "agent.permissionPolicy", mode: "default" } } } } }).permissionPolicy, "workspace");
      const fixed = params("fixed").map(field => ({ ...field, name: "permissionPolicy", flag: "--permission-policy" }));
      assert.equal(createAgentProjectInput(["--permission-policy", "workspace"], { params: [{ kind: "auxiliary", id: "access", label: "Access", fields: fixed }] }).permissionPolicy, policy);
    });
  }
  assert.equal(parseProjectParamValues(params("default"), []).access, "auto");
  const field = normalizeProjectParamDeclarations(createAgentProjectParams({ permissionPolicy: "inherit" })).params.find(field => field.name === "permissionPolicy")!;
  assert.deepEqual(field.userSetting, { key: "agent.permissionPolicy", mode: "fixed" });
  assert.deepEqual(field.options?.map(option => option.value), ["read-only", "workspace", "auto"]);
});

test("user setting parameter declarations reject invalid bindings and ambiguous defaults", async () => {
  const { readProjectParamDefinitionError, validateProjectScriptSource } = await import("../index");
  for (const patch of [
    { userSetting: null }, { userSetting: { key: "invalid" } }, { userSetting: { key: "agent.permissionPolicy", mode: "other" } },
    { defaultValue: "auto" }, { type: "number" }, { multiple: true }, { panel: "mode" },
  ]) {
    assert.match(readProjectParamDefinitionError({ name: "access", flag: "--access", type: "string",
      userSetting: { key: "agent.permissionPolicy" }, ...patch } as never) ?? "", /[Uu]ser setting/);
  }
  for (const binding of ['{ key: "invalid" }', '{ key: "agent.permissionPolicy", mode: unknownMode }', 'bindingVariable']) {
    const violations = validateProjectScriptSource(`
      const flow = steamharness.defineProject({ name: 'binding', run(input) { return input; } });
      export const executor = steamharness.defineExecutor({ projectType: 'conversation', workflow: flow,
        params: [{ kind: 'quick', id: 'access', label: 'Access', summary: ['access'], fields: [
          { name: 'access', flag: '--access', type: 'string', control: 'select', userSetting: ${binding} }
        ] }], createInput({ paramValues }) { return paramValues; }
      });`);
    assert.ok(violations.some(violation => /user setting/.test(violation.message)));
  }
});
