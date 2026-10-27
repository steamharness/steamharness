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
