import assert from "node:assert/strict";
import { test } from "node:test";
import { createBotCredentialUseTool, readBotCredentialUsePolicy } from "../agent/bot-credential";
import { parseBotCredentialUse, parseBotCredentialUseResult } from "../types/bot-credential-use";
import type { NodeContext, UserInputContext } from "../types/context";
import { withUserSettings } from "../user-settings";

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
