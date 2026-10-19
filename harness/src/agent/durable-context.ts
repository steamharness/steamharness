import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ContextView } from "@earendil-works/pi-durable";

/** Model-visible history, with obsolete pre-compaction measurements invalidated. */
export function durableContextMessages(view: ContextView, streaming?: AssistantMessage): readonly AgentMessage[] {
  const compaction = [...view.entries].reverse().find(entry => entry.kind === "pi.compaction");
  const obsolete = new Set(compaction ? view.contributions.flatMap((messages, index) =>
    view.entries[index]!.id <= compaction.id ? messages : []) : []);
  const messages = view.messages.map(message => message.role === "assistant" && obsolete.has(message)
    ? { ...message, projectContextUsageInvalid: true } : message) as AgentMessage[];
  return withStreamingMessage(messages, streaming);
}

export function withStreamingMessage(messages: readonly AgentMessage[], streaming?: AssistantMessage): readonly AgentMessage[] {
  if (!streaming) return messages;
  const content = JSON.stringify(streaming.content);
  const committed = messages.some(message => message.role === "assistant" && message.timestamp === streaming.timestamp &&
    message.provider === streaming.provider && message.model === streaming.model && JSON.stringify(message.content) === content);
  return committed ? messages : [...messages, { ...streaming, stopReason: "pending" }];
}
