import type {
  GitlabWebhookEventSummary,
  GitlabWebhookInput,
  GitlabWebhookOutputPayload,
} from "./interface";

type JsonRecord = Record<string, unknown>;
const GITLAB_WEBHOOK_SUMMARY_ITEM_ID = "gitlab-webhook-summary";

const inputNode = workflow.createInputNode<GitlabWebhookInput, GitlabWebhookInput>({
  name: "gitlab-webhook-input",
  parse(input) {
    return {
      payload: input.payload.trim(),
      message: input.message.trim(),
    };
  },
});

const outputNode = workflow.createOutputNode<GitlabWebhookEventSummary, GitlabWebhookOutputPayload>({
  name: "gitlab-webhook-output",
  async *stream(summary) {
    // Keep the live summary item id aligned with the final report so
    // conversation rendering does not keep both copies.
    yield workflow.createOutputItemChunk({
      type: "output_item_start",
      item: {
        id: GITLAB_WEBHOOK_SUMMARY_ITEM_ID,
        title: "Output",
        content: "",
        contentType: "markdown",
        collapsed: false,
      },
    });
    yield workflow.createOutputItemChunk({
      type: "output_item_delta",
      itemId: GITLAB_WEBHOOK_SUMMARY_ITEM_ID,
      delta: formatSummaryLines(summary),
    });
    yield workflow.createOutputItemChunk({
      type: "output_item_end",
      itemId: GITLAB_WEBHOOK_SUMMARY_ITEM_ID,
    });
  },
  async format(stream, summary, context) {
    const content = readOutputItemText(stream.items, GITLAB_WEBHOOK_SUMMARY_ITEM_ID);
    await context.conversation.appendMessage({
      role: "user",
      content: summary.content || summary.rawEvent,
      metadata: {
        event: summary.event,
        action: summary.action,
        id: summary.id,
        url: summary.url,
      },
    });
    await context.conversation.appendMessage({
      role: "assistant",
      content,
      metadata: {
        project: summary.project,
        author: summary.author,
      },
    });
    const state = await context.conversation.getValue();

    return {
      ...workflow.createOutputPayload({
        items: stream.items,
      }),
      event: summary.event,
      action: summary.action,
      id: summary.id,
      url: summary.url,
      summary,
      conversationId: context.conversation.conversationId,
      historyLength: state.messages.length,
      success: true,
    };
  },
});

export const gitlabWebhookWorkflow = workflow.defineWorkflow<GitlabWebhookInput, GitlabWebhookOutputPayload>({
  name: "gitlab-webhook",
  async run(input, context) {
    const parsed = await workflow.runNode(inputNode, input, context);
    const summary = summarizeGitLabPayload(parsed.payload, parsed.message);
    const result = await workflow.runStreamNode(outputNode, summary, context);

    return requireOutput(result.output);
  },
});

export const executor = workflow.defineExecutor<GitlabWebhookInput, GitlabWebhookOutputPayload>({
  projectType: "conversation",
  workflow: gitlabWebhookWorkflow,
  params: [
    {
      kind: "auxiliary",
      id: "webhook",
      label: "Webhook",
      fields: [{
        name: "payload",
        flag: "--payload",
        type: "string",
        required: false,
        description: "GitLab webhook payload JSON.",
      }],
    },
  ],
  createInput({ args }) {
    const defaults = workflow.parseConversationDefaultInputArgs(args);
    let payload = "";

    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--payload") {
        const value = args[++i];
        if (value !== undefined) {
          payload = value;
        }
      }
    }

    return {
      payload,
      message: defaults.message,
    };
  },
});

export { gitlabWebhookWorkflow as workflow };
export default gitlabWebhookWorkflow;

function readOutputItemText(
  items: Array<{ id: string; content: unknown }>,
  itemId: string,
): string {
  const item = items.find((candidate) => candidate.id === itemId);
  return typeof item?.content === "string" ? item.content.trim() : "";
}

function requireOutput(output: GitlabWebhookOutputPayload | undefined): GitlabWebhookOutputPayload {
  if (output === undefined) {
    throw new Error("Output node did not produce output.");
  }

  return output;
}

function summarizeGitLabPayload(payloadText: string, message: string): GitlabWebhookEventSummary {
  const payload = parsePayload(payloadText);
  const rawEvent = readString(payload, "object_kind") || readString(payload, "event_name");

  // Keep GitLab event parsing local to this workflow so webhook
  // smoke runs do not depend on any GitLab client package or network call.
  if (rawEvent === "issue") {
    return summarizeIssue(payload, message, rawEvent);
  }
  if (rawEvent === "note") {
    return summarizeNote(payload, message, rawEvent);
  }
  if (rawEvent === "push") {
    return summarizePush(payload, message, rawEvent);
  }
  if (rawEvent === "project_create" || rawEvent === "fork") {
    return summarizeProject(payload, message, rawEvent);
  }

  return {
    event: normalizeEvent(rawEvent || "unknown"),
    action: readString(payload, "event_name") || "received",
    id: readAnyId(payload) || "",
    url: readString(payload, "url") || readProjectUrl(payload),
    content: message || readString(payload, "message") || readString(payload, "description"),
    project: readProjectName(payload),
    author: readUserName(payload),
    rawEvent,
  };
}

function summarizeIssue(
  payload: JsonRecord,
  message: string,
  rawEvent: string,
): GitlabWebhookEventSummary {
  const attrs = readRecord(payload, "object_attributes");
  const labels = readStringArray(payload["labels"]);
  const contentParts = [
    readString(attrs, "title"),
    readString(attrs, "description"),
    labels.length > 0 ? `labels=${labels.join(",")}` : "",
    message,
  ].filter((part) => part.trim() !== "");

  return {
    event: "issue",
    action: readString(attrs, "action") || readIssueStateAction(attrs),
    id: readStringValue(attrs["iid"] ?? attrs["id"]),
    url: readString(attrs, "url"),
    content: contentParts.join(" | "),
    project: readProjectName(payload),
    author: readUserName(payload),
    rawEvent,
  };
}

function summarizeNote(
  payload: JsonRecord,
  message: string,
  rawEvent: string,
): GitlabWebhookEventSummary {
  const attrs = readRecord(payload, "object_attributes");
  const noteableType = readString(attrs, "noteable_type").toLowerCase();
  const commitId = readString(attrs, "commit_id");
  const event = noteableType === "commit" || commitId !== ""
    ? "commit_comment"
    : noteableType === "issue"
      ? "issue_comment"
      : "comment";
  const contentParts = [
    readString(attrs, "note"),
    message,
  ].filter((part) => part.trim() !== "");

  return {
    event,
    action: readString(attrs, "action") || "comment",
    id: readStringValue(attrs["id"] ?? attrs["noteable_id"] ?? commitId),
    url: readString(attrs, "url"),
    content: contentParts.join(" | "),
    project: readProjectName(payload),
    author: readUserName(payload),
    rawEvent,
  };
}

function summarizePush(
  payload: JsonRecord,
  message: string,
  rawEvent: string,
): GitlabWebhookEventSummary {
  const commits = Array.isArray(payload["commits"]) ? payload["commits"] : [];
  const firstCommit = commits.find(isRecord) ?? {};
  const checkoutSha = readString(payload, "checkout_sha");
  const contentParts = [
    readString(firstCommit, "message"),
    commits.length > 1 ? `commit_count=${commits.length}` : "",
    message,
  ].filter((part) => part.trim() !== "");

  return {
    event: "commit",
    action: checkoutSha === "" ? "delete" : "create",
    id: readString(firstCommit, "id") || checkoutSha || readString(payload, "after"),
    url: readString(firstCommit, "url") || readProjectUrl(payload),
    content: contentParts.join(" | "),
    project: readProjectName(payload),
    author: readUserName(payload),
    rawEvent,
  };
}

function summarizeProject(
  payload: JsonRecord,
  message: string,
  rawEvent: string,
): GitlabWebhookEventSummary {
  return {
    event: rawEvent === "project_create" ? "fork" : normalizeEvent(rawEvent),
    action: "create",
    id: readAnyId(payload),
    url: readString(payload, "web_url") || readString(payload, "path_with_namespace") || readProjectUrl(payload),
    content: [
      readString(payload, "name") || readString(payload, "path_with_namespace"),
      message,
    ].filter((part) => part.trim() !== "").join(" | "),
    project: readProjectName(payload),
    author: readUserName(payload),
    rawEvent,
  };
}

function parsePayload(payloadText: string): JsonRecord {
  if (payloadText === "") {
    return {};
  }

  try {
    const parsed = JSON.parse(payloadText) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {
      object_kind: "text",
      message: payloadText,
    };
  }
}

function formatSummaryLines(summary: GitlabWebhookEventSummary): string {
  return [
    ["event", summary.event],
    ["action", summary.action],
    ["id", summary.id],
    ["url", summary.url],
    ["content", normalizeLine(summary.content)],
    ["project", summary.project],
    ["author", summary.author],
    ["rawEvent", summary.rawEvent],
  ]
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function readIssueStateAction(attrs: JsonRecord): string {
  const state = readString(attrs, "state");
  if (state === "closed") {
    return "close";
  }
  if (state === "opened" || state === "reopened") {
    return "open";
  }
  return "update";
}

function normalizeEvent(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_:-]+/g, "_") || "unknown";
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function readProjectName(payload: JsonRecord): string {
  const project = readRecord(payload, "project");
  return readString(project, "path_with_namespace") ||
    readString(project, "name") ||
    readString(payload, "path_with_namespace") ||
    readString(payload, "project_name") ||
    readString(payload, "repository_name");
}

function readProjectUrl(payload: JsonRecord): string {
  const project = readRecord(payload, "project");
  const repository = readRecord(payload, "repository");
  return readString(project, "web_url") ||
    readString(project, "homepage") ||
    readString(repository, "homepage") ||
    readString(payload, "web_url");
}

function readUserName(payload: JsonRecord): string {
  const user = readRecord(payload, "user");
  return readString(user, "name") ||
    readString(user, "username") ||
    readString(payload, "user_name") ||
    readString(payload, "user_username");
}

function readAnyId(payload: JsonRecord): string {
  const attrs = readRecord(payload, "object_attributes");
  return readStringValue(attrs["iid"] ?? attrs["id"] ?? payload["id"] ?? payload["project_id"]);
}

function readString(record: JsonRecord, key: string): string {
  return readStringValue(record[key]);
}

function readStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function readRecord(record: JsonRecord, key: string): JsonRecord {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (isRecord(item)) {
        return readString(item, "title") || readString(item, "name");
      }
      return "";
    })
    .filter((item) => item.trim() !== "");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
