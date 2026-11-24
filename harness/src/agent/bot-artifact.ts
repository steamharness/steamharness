import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BotArtifact } from "../runtime-storage/bot-artifacts";
import type { RuntimePersistence } from "../runtime-storage/history";
import type { NodeContext } from "../types/context";
import type { OutputItemStreamChunk, RunOutputItemInput } from "../node/output";
import { currentBotRequestId, currentBotToolCallId } from "./bot-lifecycle";

export const BOT_ARTIFACT_TOOL = {
  name: "bot_files_publish", label: "Deliver Bot artifact", enabled: true, autoApprove: true, approvalMode: "always" as const,
};
export const BOT_ARTIFACT_GUIDANCE = "To deliver a finished file the user requested, call bot_files_publish on its artifacts-relative path. It posts a file card and keeps that exact version in the local Bot artifact library. Deliver only the intended files, not drafts or credentials.";

export function createBotArtifactTool(context: NodeContext, fallbackRequestId?: string): AgentTool | undefined {
  const persistence = context.metadata?.runtimePersistence as RuntimePersistence | undefined;
  const conversationId = context.conversation?.enabled ? context.conversation.conversationId : undefined;
  const runId = context.metadata?.runId;
  if (!persistence?.allowBotArtifactPublish || !conversationId || typeof runId !== "string") return;
  const store = persistence.botArtifacts?.({ projectId: context.projectId, entryId: context.entryId });
  if (!store) return;
  return {
    name: BOT_ARTIFACT_TOOL.name,
    label: BOT_ARTIFACT_TOOL.label,
    description: "Deliver a finished file from artifacts/YYYY-MM-DD/ in this Bot workspace to the current user. Saves an independent snapshot and posts a file card. No temporary, workspace, or absolute paths.",
    parameters: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 1024 }, title: { type: "string", minLength: 1, maxLength: 160 } }, required: ["path"], additionalProperties: false },
    replay: "never",
    async execute(toolCallId: string, args: unknown, signal?: AbortSignal) {
      signal?.throwIfAborted();
      try {
        const input = args as Record<string, unknown> | undefined;
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "path" && key !== "title")
          || typeof input.path !== "string" || (input.title !== undefined && typeof input.title !== "string")) throw new Error("Invalid Bot artifact arguments.");
        const requestId = currentBotRequestId(context.projectId, context.entryId) ?? fallbackRequestId ?? runId;
        const result = await store.publish({ path: input.path, title: input.title as string | undefined },
          { conversationId, runId, requestId, outputId: toolCallId }, currentBotToolCallId() ?? toolCallId, signal);
        return { content: [{ type: "text" as const, text: `Delivered ${JSON.stringify(result.name)} as ${result.id}. The host displays a download card.` }],
          details: { botArtifact: result } };
      } catch (error) {
        signal?.throwIfAborted();
        // Filesystem exceptions can include the absolute runtime directory.
        const text = error instanceof Error && !("code" in error) ? error.message : "The delivery could not be saved.";
        return { content: [{ type: "text" as const, text }], details: {}, isError: true };
      }
    },
  } as unknown as AgentTool;
}

export function botArtifactChunks(details: unknown): OutputItemStreamChunk[] {
  const item = botArtifactItem(details);
  return item ? [{ type: "output_item_start", item }, { type: "output_item_end", itemId: item.id }] : [];
}

export function botArtifactItem(details: unknown): (RunOutputItemInput & { id: string }) | undefined {
  const artifact = (details as { botArtifact?: BotArtifact } | undefined)?.botArtifact;
  if (!artifact || typeof artifact.id !== "string" || !/^ba_[a-f0-9]{32}$/u.test(artifact.id)
    || typeof artifact.title !== "string" || typeof artifact.name !== "string" || !Number.isSafeInteger(artifact.size) || artifact.size < 0) return;
  return { id: artifact.id, title: artifact.title, icon: "file", contentType: "json",
    content: { id: artifact.id, name: artifact.name, size: artifact.size }, metadata: { kind: "bot-artifact" } };
}
