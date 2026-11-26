import assert from "node:assert/strict";
import { test } from "node:test";
import { createBotCredentialUseTool, readBotCredentialUsePolicy } from "../agent/bot-credential";
import { parseBotCredentialUse, parseBotCredentialUseOperations, parseBotCredentialUseResult } from "../types/bot-credential-use";
import type { NodeContext, UserInputContext } from "../types/context";
import { withUserSettings } from "../user-settings";
import { createProjectToolPermissionContext } from "../tool-permissions";

const input = { name: "my-dns", connector: "alibaba-cloud-dns", operation: "list-records",
  fields: { accessKeyId: "user-key-name", accessKeySecret: "my.secret", securityToken: "my_token" }, domain: "Example.COM" };

test("credential use arguments contain only an alias, field mappings and a bounded read-only operation", () => {
  const use = parseBotCredentialUse(input);
  assert.deepEqual(use, { ...input, domain: "example.com", page: 1 });
  for (const value of [{ ...input, url: "https://example.test" }, { ...input, operation: "delete" }, { ...input, domain: "user@example.test" },
    { ...input, operation: "list-domains" }, { ...input, page: 1001 }, { ...input, approval: { mode: "auto" } }, { ...input, fields: { ...input.fields, value: "fixture" } },
    { ...input, fields: { accessKeyId: "same", accessKeySecret: "same" } }, { ...input, fields: { ...input.fields, securityToken: "__proto__" } }]) {
    assert.throws(() => parseBotCredentialUse(value));
  }
  const result = { status: "ok", page: 1, total: 1, rows: [{ name: "@", type: "A", value: "192.0.2.1", ttl: 600 }] };
  assert.deepEqual(parseBotCredentialUseResult(result, use), result);
  for (const reply of [{ ...result, page: 2 }, { ...result, rows: [{ ...result.rows[0], authorization: "fixture" }] },
    { status: "denied", message: "no raw errors" }, { ...result, rows: [{ domain: "example.com" }] }]) {
    assert.equal(parseBotCredentialUseResult(reply, use), undefined);
  }
});

test("saved credential queries use the stricter user or Agent permission policy", async () => {
  const seen: unknown[] = [];
  const waitForCredentialUse: UserInputContext["waitForCredentialUse"] = async request => {
    seen.push(readBotCredentialUsePolicy(request));
    assert.equal(readBotCredentialUsePolicy({ ...request, metadata: { type: "fixture", title: "Fixture", version: "1.0.0", credentialUsePolicy: "auto" } }), undefined);
    return { status: "declined" };
  };
  const context = { userInput: { waitForCredentialUse } } as NodeContext;
  for (const [user, agent, expected] of [
    ["read-only", "auto", undefined], ["auto", "read-only", undefined], ["workspace", "auto", "workspace"],
    ["auto", "workspace", "workspace"], ["workspace", "workspace", "workspace"], ["auto", "auto", "auto"],
  ] as const) {
    await withUserSettings({ agent: { permissionPolicy: user } }, async () => {
      const tool = createBotCredentialUseTool(context, agent);
      if (!expected) { assert.equal(tool, undefined); return; }
      assert.ok(tool);
      await tool.execute("test", input);
      assert.equal(seen.at(-1), expected);
    });
  }
  assert.deepEqual(seen, ["workspace", "workspace", "workspace", "auto"]);
});

test("credential use is host-only, non-replayable, and an invalid receipt is not shown to the model", async () => {
  const context = (waitForCredentialUse?: UserInputContext["waitForCredentialUse"]) => ({ userInput: { waitForCredentialUse } } as NodeContext);
  assert.equal(createBotCredentialUseTool(context()), undefined);
  const tool = createBotCredentialUseTool(context(async request => {
    assert.deepEqual(request.params, []);
    assert.deepEqual(request.credentialUse, parseBotCredentialUse(input));
    return { status: "declined" };
  }))!;
  assert.equal((tool as unknown as { replay: string }).replay, "never");
  assert.deepEqual((await tool.execute("test", input)).content, [{ type: "text", text: '{"status":"declined"}' }]);
  const forged = createBotCredentialUseTool(context(async () => ({ status: "declined", raw: "dummy-value" as string })))!;
  await assert.rejects(forged.execute("test", input), /^Error: Invalid Bot credential use receipt\.$/);
});

test("a new host operation needs no Core connector, and is only offered for the advertising host", async () => {
  const use = { name: "fixture", connector: "host", operation: "fixture.inspect", args: { target: "example.test", field: "token" } };
  const receipt = { status: "ok" as const, data: { items: [1, "second"] } };
  const catalog = [{ id: use.operation, description: "Inspect the fixture. Pass args target and field name." }];
  assert.deepEqual(parseBotCredentialUseOperations(catalog), catalog);
  assert.equal(parseBotCredentialUseOperations([...catalog, ...catalog]), undefined);
  assert.equal(parseBotCredentialUseOperations([{ ...catalog[0], token: "not metadata" }]), undefined);
  assert.deepEqual(parseBotCredentialUse(use), use);
  assert.throws(() => parseBotCredentialUse({ ...use, approval: "auto" }));
  assert.throws(() => parseBotCredentialUse({ ...use, args: JSON.parse('{"__proto__":{"polluted":true}}') }));
  assert.throws(() => parseBotCredentialUse({ ...use, args: { target: "a".repeat(9000) } }));
  assert.throws(() => parseBotCredentialUse({ ...use, args: [] }));
  assert.deepEqual(parseBotCredentialUseResult(receipt, parseBotCredentialUse(use)), receipt);
  assert.equal(parseBotCredentialUseResult({ ...receipt, headers: {} }, parseBotCredentialUse(use)), undefined);
  assert.equal(parseBotCredentialUseResult({ ...receipt, data: "a".repeat(65537) }, parseBotCredentialUse(use)), undefined);
  let calls = 0;
  const waitForCredentialUse: NonNullable<UserInputContext["waitForCredentialUse"]> = async request => {
    calls++;
    assert.deepEqual(request.credentialUse, use);
    assert.deepEqual(request.params, []);
    return receipt;
  };
  const context = { userInput: { waitForCredentialUse } } as NodeContext;
  const legacy = createBotCredentialUseTool(context)!;
  assert.doesNotMatch(JSON.stringify(legacy.parameters), /fixture.inspect/);
  await assert.rejects(legacy.execute("test", use), /not supported/);
  const modern = createBotCredentialUseTool({ ...context, userInput: { ...context.userInput!, credentialUseOperations: catalog } })!;
  assert.match(JSON.stringify(modern.parameters), /fixture\.inspect/);
  await assert.rejects(modern.execute("test", { ...use, operation: "fixture.unregistered" }), /not supported/);
  assert.deepEqual((await modern.execute("test", use)).content, [{ type: "text", text: JSON.stringify(receipt) }]);
  assert.equal(calls, 1);
});

test("host operations can list metadata and cannot bypass an additional tool permission", async () => {
  const list = { connector: "host", operation: "vault.list", args: {} };
  const command = { name: "fixture", connector: "host", operation: "command.run", args: {} };
  const receipt = { status: "failed", reason: "http-error", httpStatus: 502 };
  assert.deepEqual(parseBotCredentialUse(list), list);
  assert.deepEqual(parseBotCredentialUseResult(receipt, parseBotCredentialUse(command)), receipt);
  assert.equal(parseBotCredentialUseResult({ ...receipt, reason: "raw diagnostic" }, parseBotCredentialUse(command)), undefined);
  assert.equal(parseBotCredentialUseResult({ ...receipt, httpStatus: 999 }, parseBotCredentialUse(command)), undefined);
  const userInput = { credentialUseOperations: [{ id: "vault.list", description: "List credential aliases" },
    { id: "command.run", description: "Run a command", requiresTool: "bash" }], waitForCredentialUse: async () => ({ status: "ok", data: {} }) };
  for (const [enabled, agentTools, allowed] of [[false, undefined, false], [true, [], false], [true, ["bash"], true]] as const) {
    const toolPermissions = createProjectToolPermissionContext({ definitions: [{ name: "bash", enabled }], projectName: "fixture", runId: "fixture" });
    const tool = createBotCredentialUseTool({ userInput, toolPermissions } as unknown as NodeContext, "workspace", agentTools)!;
    assert.match(JSON.stringify(tool.parameters), /vault\.list/);
    if (allowed) await tool.execute("allowed", command);
    else await assert.rejects(tool.execute("blocked", command), /not supported/);
  }
});
