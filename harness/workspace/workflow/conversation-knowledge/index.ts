import type {
  ConversationKnowledgeInput,
  ConversationKnowledgeOutputPayload,
} from "./interface";

interface ConversationMessage {
  role: string;
  content: string;
  createdAt?: string;
}

interface ConversationKnowledgeDraft {
  conversationId: string;
  documentId: string;
  title: string;
  markdown: string;
  messageCount: number;
}

const inputNode = steamharness.createInputNode<ConversationKnowledgeInput, ConversationKnowledgeInput>({
  name: "conversation-knowledge-input",
  parse(input) {
    return {
      message: input.message.trim() === "" ? "记录一条会话知识" : input.message.trim(),
      title: normalizeOptionalTitle(input.title),
      dryRun: input.dryRun,
    };
  },
});

const outputNode = steamharness.createOutputNode<ConversationKnowledgeDraft & { dryRun: boolean }, ConversationKnowledgeOutputPayload>({
  name: "conversation-knowledge-output",
  async *stream(input) {
    // App merges live output items with the final report by id. Use
    // a structured item here so the preview shown while running is the same
    // item that ends up in report.json.
    yield steamharness.createOutputItemChunk({
      type: "output_item_start",
      item: createKnowledgeOutputItem(input, ""),
    });
    yield steamharness.createOutputItemChunk({
      type: "output_item_delta",
      itemId: input.documentId,
      delta: input.markdown,
    });
    yield steamharness.createOutputItemChunk({
      type: "output_item_end",
      itemId: input.documentId,
    });
  },
  format(stream, input) {
    return {
      ...steamharness.createOutputPayload({
        items: stream.items.length > 0
          ? stream.items
          : [createKnowledgeOutputItem(input, input.markdown)],
      }),
      conversationId: input.conversationId,
      documentId: input.documentId,
      documentTitle: input.title,
      messageCount: input.messageCount,
      conversationMessages: input.messageCount,
      knowledgeWritten: !input.dryRun,
      dryRun: input.dryRun,
    };
  },
});

export const conversationKnowledgeProject = steamharness.defineProject<ConversationKnowledgeInput, ConversationKnowledgeOutputPayload>({
  name: "conversation-knowledge",
  async run(input, context) {
    const parsed = await steamharness.runNode(inputNode, input, context);
    const conversationId = requireConversationId(context.conversation.conversationId);
    const title = parsed.title ?? createDefaultTitle(conversationId);
    await context.conversation.setTitle(title);

    await context.conversation.appendMessage({
      role: "user",
      content: parsed.message,
      metadata: {
        knowledgeDocument: true,
      },
    });
    const assistantText = `已记录到知识库文档: ${parsed.message}`;
    const nextState = await context.conversation.appendMessage({
      role: "assistant",
      content: assistantText,
      metadata: {
        knowledgeDocument: true,
      },
    });
    const draft = createKnowledgeDraft({
      conversationId,
      title,
      messages: nextState.messages,
    });

    // Each conversation maps to one PersistentValue-backed knowledge document.
    // dry-run keeps preview-only runs from writing to either configured backend.
    if (!parsed.dryRun) {
      const existing = await context.databases.get("data").knowledge.getDocument(draft.documentId);
      if (existing === undefined) {
        await context.databases.get("data").knowledge.createDocument({
          id: draft.documentId,
          title: draft.title,
          markdown: draft.markdown,
        });
      } else {
        await context.databases.get("data").knowledge.editDocument({
          id: draft.documentId,
          title: draft.title,
          markdown: draft.markdown,
        });
      }
    }

    const result = await steamharness.runStreamNode(outputNode, {
      ...draft,
      dryRun: parsed.dryRun,
      messageCount: draft.messageCount,
    }, context);

    return requireOutput(result.output);
  },
});

export const executor = steamharness.defineExecutor<ConversationKnowledgeInput, ConversationKnowledgeOutputPayload>({
  projectType: "conversation",
  workflow: conversationKnowledgeProject,
  params: [
    {
      kind: "auxiliary",
      id: "knowledge",
      label: "Knowledge",
      fields: [
        {
          name: "title",
          flag: "--title",
          type: "string",
          required: false,
          description: "Optional knowledge document title.",
        },
        {
          name: "dryRun",
          flag: "--dry-run",
          type: "boolean",
          required: false,
          defaultValue: "false",
          description: "Preview the document without calling PersistentValue-backed knowledge helpers.",
        },
      ],
    },
  ],
  createInput({ args }) {
    return parseInput(args);
  },
});

export { conversationKnowledgeProject as workflow };
export default conversationKnowledgeProject;

function createKnowledgeOutputItem(
  input: ConversationKnowledgeDraft & { dryRun: boolean },
  content: string,
) {
  return {
    id: input.documentId,
    title: input.dryRun ? "Knowledge document preview" : "Knowledge document",
    content,
    contentType: "markdown" as const,
    iconPreset: input.dryRun ? "info" as const : "success" as const,
    collapsed: false,
    metadata: {
      documentId: input.documentId,
      dryRun: input.dryRun,
    },
  };
}

function parseInput(args: string[]): ConversationKnowledgeInput {
  const defaults = steamharness.parseConversationDefaultInputArgs(args);
  const defaultMessage = defaults.message.trim();
  const messageParts: string[] = [];
  let title: string | undefined;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--message") {
      const value = args[++index];
      if (defaultMessage === "" && value !== undefined) {
        messageParts.push(value);
      }
      continue;
    }
    if (arg === "--title") {
      title = args[++index];
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
  }

  return {
    message: defaultMessage === "" ? messageParts.join(" ") : defaults.message,
    title,
    dryRun,
  };
}

function createKnowledgeDraft(input: {
  conversationId: string;
  title: string;
  messages: ConversationMessage[];
}): ConversationKnowledgeDraft {
  const documentId = createConversationDocumentId(input.conversationId);
  const markdown = [
    `# ${escapeMarkdownHeading(input.title)}`,
    "",
    `Conversation ID: \`${escapeMarkdownInline(input.conversationId)}\``,
    "",
    ...input.messages.flatMap((message, index) => formatMessage(index + 1, message)),
  ].join("\n");

  return {
    conversationId: input.conversationId,
    documentId,
    title: input.title,
    markdown,
    messageCount: input.messages.length,
  };
}

function formatMessage(index: number, message: ConversationMessage): string[] {
  const title = `## ${index}. ${formatRole(message.role)}`;
  const timestamp = message.createdAt === undefined ? [] : ["", `Time: ${escapeMarkdownInline(message.createdAt)}`];
  return [
    title,
    ...timestamp,
    "",
    message.content.trim() === "" ? "_empty message_" : message.content,
    "",
  ];
}

function createConversationDocumentId(conversationId: string): string {
  const safe = conversationId
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/g, "")
    .replace(/[^A-Za-z0-9]+$/g, "")
    .slice(0, 84);
  const suffix = hashString(conversationId);
  return `conversation.${safe === "" ? "thread" : safe}.${suffix}`.slice(0, 128);
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

function createDefaultTitle(conversationId: string): string {
  return `Conversation ${conversationId}`;
}

function normalizeOptionalTitle(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized === "" ? undefined : normalized;
}

function requireConversationId(value: string | undefined): string {
  if (value !== undefined && value.trim() !== "") {
    return value.trim();
  }

  throw new steamharness.HarnessError({
    type: "input_validation",
    message: "conversation-knowledge requires a conversation id.",
  });
}

function formatRole(role: string): string {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  if (role === "system") return "System";
  if (role === "tool") return "Tool";
  return role;
}

function escapeMarkdownHeading(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/#/g, "\\#");
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/`/g, "\\`");
}

function requireOutput(output: ConversationKnowledgeOutputPayload | undefined): ConversationKnowledgeOutputPayload {
  if (output === undefined) {
    throw new steamharness.HarnessError({
      type: "execution",
      message: "Conversation knowledge output was not created.",
    });
  }

  return output;
}
