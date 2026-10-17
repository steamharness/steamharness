import assert from "node:assert/strict";
import test from "node:test";
import {
  createDisabledWorkflowConversationContext,
  createWorkflowConversationContext,
  createWorkflowKVContext,
  type WorkflowKVStore,
} from "../index";

test("conversation setTitle persists a normalized title and emits updates", async () => {
  const kv = createWorkflowKVContext({
    store: createMemoryKVStore(),
    projectId: "demo",
    conversationId: "conv-1",
  });
  const titleEvents: Array<{ conversationId: string; title?: string; updatedAt: string }> = [];
  const conversation = createWorkflowConversationContext({
    enabled: true,
    workflowName: "demo",
    conversationId: "conv-1",
    kv,
    onTitleChange(event) {
      titleEvents.push(event);
    },
  });

  const titledState = await conversation.setTitle("  Delta   Force  ");
  assert.equal(titledState?.title, "Delta Force");
  assert.equal(titleEvents.length, 1);
  assert.deepEqual(titleEvents[0], {
    conversationId: "conv-1",
    title: "Delta Force",
    updatedAt: titledState?.updatedAt,
  });

  const storedState = await conversation.getValue();
  assert.equal(storedState.title, "Delta Force");
});

test("stable message identities update projections without duplicates or lost state", async () => {
  const kv = createWorkflowKVContext({ store: createMemoryKVStore(), projectId: "demo", conversationId: "durable" });
  const conversation = createWorkflowConversationContext({ enabled: true, workflowName: "demo", conversationId: "durable", kv });
  await conversation.setValue("approval", "waiting");
  await conversation.appendMessage({ id: "input", role: "user", content: "Hello" });
  await conversation.appendMessage({ id: "answer", role: "assistant", content: "Partial" });
  await conversation.appendMessage({ id: "answer", role: "assistant", content: "Complete" });
  await conversation.setTitle("Durable");
  const state = await conversation.getValue();
  assert.deepEqual(state.messages.map(message => [message.id, message.content]), [["input", "Hello"], ["answer", "Complete"]]);
  assert.equal(state.values.approval, "waiting"); assert.equal(state.title, "Durable");
});

test("conversation setTitle clears blank titles without throwing", async () => {
  const kv = createWorkflowKVContext({
    store: createMemoryKVStore(),
    projectId: "demo",
    conversationId: "conv-1",
  });
  const conversation = createWorkflowConversationContext({
    enabled: true,
    workflowName: "demo",
    conversationId: "conv-1",
    kv,
  });

  await conversation.setTitle("Temporary title");
  const clearedState = await conversation.setTitle("   ");

  assert.equal(clearedState?.title, undefined);
  assert.equal("title" in await conversation.getValue(), false);
});

test("disabled conversation setTitle is a safe no-op", async () => {
  const conversation = createDisabledWorkflowConversationContext();

  await assert.doesNotReject(() => conversation.setTitle("ignored"));
  assert.equal(await conversation.setTitle("ignored"), undefined);
});

function createMemoryKVStore(): WorkflowKVStore {
  const values = new Map<string, unknown>();

  function createKey(input: {
    storageKind: string;
    scope: string;
    projectId: string;
    conversationId?: string;
    key: string;
  }): string {
    return [
      input.storageKind,
      input.scope,
      input.projectId,
      input.conversationId ?? "",
      input.key,
    ].join(":");
  }

  return {
    async getValue(input) {
      return values.get(createKey(input));
    },
    async setValue(input) {
      values.set(createKey(input), input.value);
    },
    async deleteValue(input) {
      return values.delete(createKey(input));
    },
    async updateValue(input, updater) {
      const next = updater(values.get(createKey(input)));
      values.set(createKey(input), next);
      return next;
    },
  };
}
