import assert from "node:assert/strict";
import test from "node:test";
import { PRESENTATION_CARD_MCP_TOOL_ID, runPresentationCardAction } from "../agent/capabilities/index";
import type { NodeContext } from "../types/context";

const context = {projectId:"11111111-1111-4111-8111-111111111111",entryId:"main"} as NodeContext;

test("Kanban cards accept an independent named configuration target", async () => {
  const args = { action: "upsert" as const, cardId: "configuration-one", kind: "kanban" as const,
    target: { projectId:context.projectId,entryId:context.entryId,source: "current", configurationId: "configuration-one" }, preview: true };
  assert.deepEqual(await runPresentationCardAction(context, args), args);
  await assert.rejects(() => runPresentationCardAction(context, {
    ...args, kind: "kv", target: { ...args.target, scope: "project", key: "map" },
  }), /invalid field/u);
});

test("presentation card upserts and removes by stable card id", async () => {
  assert.equal(PRESENTATION_CARD_MCP_TOOL_ID, "workflow-ui_present_card");
  assert.deepEqual(await runPresentationCardAction(context, {
    action: "upsert",
    cardId: "board:active",
    kind: "kanban",
    target: { projectId:context.projectId,entryId:context.entryId,source: "current" },
    pinned: true,
    preview: true,
    kanban: { mode: "preview", values: { title: "Roadmap", columns: 3 } },
  }), {
    action: "upsert",
    cardId: "board:active",
    kind: "kanban",
    target: { projectId:context.projectId,entryId:context.entryId,source: "current" },
    pinned: true,
    preview: true,
    kanban: { mode: "preview", values: { title: "Roadmap", columns: 3 } },
  });
  assert.deepEqual(await runPresentationCardAction(context, {
    action: "remove",
    cardId: "board:active",
  }), { action: "remove", cardId: "board:active" });
  await assert.rejects(() => runPresentationCardAction(context, {
    action: "remove", cardId: "board:active", pinned: true,
  }), /only its card id/u);
});

test("presentation card rejects unsafe targets and malformed preview parameters", async () => {
  assert.deepEqual(await runPresentationCardAction(context, {
    action: "upsert", cardId: "browser", kind: "browser", target: { url: "https://example.com" }, preview: false,
  }), {
    action: "upsert", cardId: "browser", kind: "browser", target: { url: "https://example.com/" }, preview: false,
  });
  await assert.rejects(() => runPresentationCardAction(context, {
    action: "upsert", cardId: "x", kind: "file", target: { projectId:context.projectId,entryId:context.entryId,source: "current", filePath: "src/index.ts" }, preview: true,
  }), /preview requires/u);
  await assert.rejects(() => runPresentationCardAction(context, {
    action: "upsert", cardId: "x", kind: "file", target: { projectId:context.projectId,entryId:context.entryId,source: "current", filePath: "src/index.ts" }, preview: false,
  }), /preview requires/u);
  await assert.rejects(() => runPresentationCardAction(context, {
    action: "upsert", cardId: "x", kind: "project", target: { projectId:context.projectId,entryId:context.entryId,source: "current" }, preview: "true" as unknown as boolean,
  }), /preview must be a boolean/u);
  await assert.rejects(() => runPresentationCardAction(context, {
    action: "upsert", cardId: "x", kind: "browser", target: { url: "javascript:alert(1)" },
  }), /HTTP\(S\)/u);
  await assert.rejects(() => runPresentationCardAction(context, {
    action: "upsert", cardId: "x", kind: "file", target: { source: "local", projectId: "p", entryId:"main", filePath: "../secret" },
  }), /workspace-relative/u);
  await assert.rejects(() => runPresentationCardAction(context, {
    action: "upsert", cardId: "x", kind: "file", target: { source: "local", projectId: "p", entryId:"main", filePath: "C:\\secret" },
  }), /workspace-relative/u);
  await assert.rejects(() => runPresentationCardAction(context, {
    action: "upsert", cardId: "bad id", kind: "project", target: { projectId:context.projectId,entryId:context.entryId,source: "current" },
  }), /Card id/u);
});

test("saving configurations requires the explicit Studio Control target and revision", async () => {
  await assert.rejects(() => runPresentationCardAction(context, {
    action: "upsert", cardId: "board", kind: "kanban", target: { projectId:context.projectId,entryId:context.entryId,source: "current" },
    kanban: { mode: "save" as "preview", values: { title: "Saved" } },
  }), /Studio Control/u);
});
