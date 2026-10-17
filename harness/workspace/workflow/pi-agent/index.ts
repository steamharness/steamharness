import os from "node:os";
import path from "node:path";
import type {
  PiAgentInput,
  PiAgentOutputPayload,
  PiAgentParsedInput,
  PiAgentProvider,
  PiAgentRunInput,
} from "./interface";
import { KNOWLEDGE_DOCUMENTS_TOOL_NAME } from "./knowledge-documents-tool";
import { createPiAgentSessionFactory, createPiAgentTokenUsageReport } from "./pi-sdk";
import { runPiAgentStream } from "./stream-output";

const DEFAULT_PROMPT = "Summarize this steamharness repository without changing files.";
const DEFAULT_WORKDIR = ".";
const DEFAULT_PROVIDER: PiAgentProvider = "anthropic";
const DEFAULT_PI_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];
const REGISTERED_PI_TOOLS = [...DEFAULT_PI_TOOLS, KNOWLEDGE_DOCUMENTS_TOOL_NAME];

const inputNode = workflow.createInputNode<PiAgentInput, PiAgentParsedInput>({
  name: "pi-agent-input",
  parse(input, context) {
    const prompt = (input.prompt || DEFAULT_PROMPT).trim();
    if (prompt === "") {
      throw new workflow.WorkflowError({
        type: "input_validation",
        message: "Prompt is required.",
        nodeName: "pi-agent-input",
      });
    }

    const provider = normalizeProvider(input.provider ?? workflow.getEnv("PI_AGENT_PROVIDER"));
    const knowledgeTools = input.knowledgeTools !== false;

    return {
      prompt,
      workdir: resolveWorkdir(input.workdir ?? DEFAULT_WORKDIR),
      model: normalizeOptionalString(input.model) ?? readProviderModelEnv(provider),
      provider,
      baseUrl: normalizeOptionalString(input.baseUrl) ?? readProviderBaseUrlEnv(provider),
      knowledgeTools,
      // applies registered tool policies before the Pi SDK receives
      // its allowlist, so disabled tools disappear even before model planning.
      explicitTools: true,
      tools: resolveEnabledPiTools(
        input.tools === undefined ? DEFAULT_PI_TOOLS : readTools(input.tools),
        knowledgeTools,
        context,
      ),
      dryRun: input.dryRun === true,
    };
  },
});

const outputNode = workflow.createOutputNode<PiAgentRunInput, PiAgentOutputPayload>({
  name: "pi-agent-output",
  async *stream(input, context) {
    let pendingToolApprovalError: workflow.WorkflowError | undefined;
    const sessionFactory = input.sessionFactory ?? createPiAgentSessionFactory({
      getEnv(name) {
        return workflow.getEnv(name);
      },
      context,
      onPendingApproval(error) {
        pendingToolApprovalError = error;
      },
    });
    const session = await sessionFactory(input, {
      onPendingApproval(error) {
        pendingToolApprovalError = error;
      },
    });

    try {
      for await (const chunk of runPiAgentStream(session.prompt(input.prompt))) {
        throwPendingToolApprovalError(pendingToolApprovalError);
        yield workflow.createOutputItemChunk(chunk);
      }
      throwPendingToolApprovalError(pendingToolApprovalError);

      input.__snapshot = session.getSnapshot();
      const usageReport = createPiAgentTokenUsageReport(input.__snapshot);
      if (usageReport !== undefined) {
        await context.tokenUsage.report(usageReport);
      }
    } finally {
      session.dispose();
    }
  },
  async format(stream, input, context) {
    const snapshot = input.__snapshot ?? { activeTools: input.tools };
    const assistantContent = readAssistantContent(stream.items);
    await context.conversation.appendMessage({ role: "user", content: input.prompt });
    await context.conversation.appendMessage({
      role: "assistant",
      content: assistantContent,
      metadata: {
        sessionId: snapshot.sessionId,
        dryRun: input.dryRun,
      },
    });

    return {
      ...workflow.createOutputPayload({ items: stream.items }),
      prompt: input.prompt,
      workdir: input.workdir,
      model: input.model,
      provider: input.provider,
      baseUrl: input.baseUrl,
      dryRun: input.dryRun,
      sessionId: snapshot.sessionId,
      toolCount: stream.items.filter((item) => item.metadata?.kind === "pi-agent-tool").length,
      messageCount: snapshot.messages?.length ?? 0,
      conversationMessages: snapshot.messages?.length ?? 0,
      activeTools: snapshot.activeTools ?? input.tools,
    };
  },
});

function throwPendingToolApprovalError(error: workflow.WorkflowError | undefined): void {
  if (error !== undefined) {
    // Pi SDK custom tools can surface thrown approval waits as tool
    // errors. Re-throw from the workflow stream so the shared user-input resume
    // path owns the pause and the agent does not continue with a synthetic reply.
    throw error;
  }
}

export const piAgentWorkflow = workflow.defineWorkflow<PiAgentInput, PiAgentOutputPayload>({
  name: "pi-agent",
  async run(input, context) {
    const parsed = await workflow.runNode(inputNode, input, context);
    const result = await workflow.runStreamNode(
      outputNode,
      parsed,
      context,
    );

    return requireOutput(result.output);
  },
});

export const executor = workflow.defineExecutor<PiAgentInput, PiAgentOutputPayload>({
  projectType: "conversation",
  workflow: piAgentWorkflow,
  tokenUsage: {
    enabled: true,
    display: true,
  },
  tools: [
    {
      name: "read",
      label: "Read files",
      description: "Read file contents from the configured Pi working directory.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "write",
      label: "Write files",
      description: "Create or overwrite files in the configured Pi working directory.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "edit",
      label: "Edit files",
      description: "Apply targeted file edits in the configured Pi working directory.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "bash",
      label: "Run shell commands",
      description: "Run shell commands through Pi in the configured working directory.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "grep",
      label: "Search text",
      description: "Search file contents with Pi's grep tool.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "find",
      label: "Find paths",
      description: "Find files or directories in the configured working directory.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "ls",
      label: "List directory",
      description: "List directory entries in the configured working directory.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "knowledge_documents",
      label: "Knowledge Documents",
      description: "Manage PersistentValue-backed project markdown knowledge documents.",
      enabled: true,
      autoApprove: true,
    },
  ],
  params: [
    {
      kind: "auxiliary",
      id: "advanced",
      label: "Advanced",
      fields: [
        {
          name: "workdir",
          flag: "--workdir",
          shortFlag: "-C",
          type: "string",
          required: false,
          description: "Working directory passed to Pi.",
          defaultValue: DEFAULT_WORKDIR,
        },
        {
          name: "model",
          flag: "--model",
          shortFlag: "-m",
          type: "string",
          required: false,
          description: "Optional model id for Pi ModelRegistry lookup.",
        },
        {
          name: "provider",
          flag: "--provider",
          type: "string",
          required: false,
          description: "Pi provider.",
          defaultValue: DEFAULT_PROVIDER,
          control: "radio",
          options: [
            {
              value: "anthropic",
              label: "Anthropic",
              description: "Use ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, and ANTHROPIC_MODEL.",
            },
            {
              value: "openai",
              label: "OpenAI",
              description: "Use OPENAI_API_KEY, OPENAI_BASE_URL, and OPENAI_MODEL.",
            },
          ],
        },
        {
          name: "baseUrl",
          flag: "--base-url",
          type: "string",
          required: false,
          description: "Optional provider base URL override.",
        },
        {
          name: "tools",
          flag: "--tools",
          type: "string",
          required: false,
          description: "Comma-separated Pi tool allowlist, for example read,bash. knowledge_documents is added by default unless knowledge tools are disabled.",
        },
        {
          name: "knowledgeTools",
          flag: "--knowledge-tools",
          type: "boolean",
          required: false,
          description: "Expose the workflow's PersistentValue-backed knowledge_documents tool. Enabled by default; pass --no-knowledge-tools to disable it.",
          defaultValue: "true",
        },
        {
          name: "dryRun",
          flag: "--dry-run",
          type: "boolean",
          required: false,
          description: "Use an offline SDK-compatible session for repeatable tests.",
          defaultValue: "false",
        }
      ],
    },
  ],
  createInput({ args }) {
    const defaults = workflow.parseConversationDefaultInputArgs(args);
    const defaultMessage = defaults.message.trim();
    const input: PiAgentInput = defaults.message.trim() === ""
      ? {}
      : { prompt: defaults.message };

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--prompt" || arg === "-p") {
        const value = args[++i] ?? "";
        if (defaultMessage === "") {
          input.prompt = value;
        }
      } else if (arg === "--workdir" || arg === "-C") {
        input.workdir = args[++i] ?? DEFAULT_WORKDIR;
      } else if (arg === "--model" || arg === "-m") {
        input.model = args[++i];
      } else if (arg === "--provider") {
        input.provider = args[++i];
      } else if (arg === "--base-url") {
        input.baseUrl = args[++i];
      } else if (arg === "--tools") {
        input.tools = normalizeTools(args[++i], input.knowledgeTools !== false);
      } else if (arg === "--knowledge-tools") {
        input.knowledgeTools = true;
        if (input.tools !== undefined) {
          input.tools = normalizeTools(input.tools, true);
        }
      } else if (arg === "--no-knowledge-tools") {
        input.knowledgeTools = false;
        if (input.tools !== undefined) {
          input.tools = normalizeTools(input.tools, false);
        }
      } else if (arg === "--dry-run") {
        input.dryRun = true;
      } else if (arg === "--no-dry-run") {
        input.dryRun = false;
      } else if (defaultMessage === "" && arg.trim() !== "") {
        input.prompt = input.prompt === undefined ? arg : `${input.prompt} ${arg}`;
      }
    }

    return input;
  },
});

export { piAgentWorkflow as workflow };
export default piAgentWorkflow;
export const __test_inputNode = inputNode;
export const __test_outputNode = outputNode;

function readAssistantContent(items: Array<{ title: string; content: unknown; metadata?: Record<string, unknown> }>): string {
  return items
    .filter((item) => item.title === "Output" && item.metadata?.kind !== "pi-agent-tool")
    .map((item) => typeof item.content === "string" ? item.content : JSON.stringify(item.content, null, 2))
    .join("\n")
    .trim();
}

function resolveWorkdir(rawDir: string): string {
  const expanded = rawDir === "~"
    ? os.homedir()
    : rawDir.startsWith("~/")
      ? path.join(os.homedir(), rawDir.slice(2))
      : rawDir;

  return path.resolve(expanded);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function normalizeProvider(value: unknown): PiAgentProvider {
  const provider = normalizeOptionalString(value)?.toLowerCase();
  if (provider === "openai" || provider === "openapi") {
    return "openai";
  }
  if (provider === "anthropic") {
    return "anthropic";
  }

  return DEFAULT_PROVIDER;
}

function readProviderModelEnv(provider: PiAgentProvider): string | undefined {
  if (provider === "openai") {
    return normalizeOptionalString(workflow.getEnv("OPENAI_MODEL")) ??
      normalizeOptionalString(workflow.getEnv("OPENAPI_MODEL"));
  }

  return normalizeOptionalString(workflow.getEnv("ANTHROPIC_MODEL"));
}

function readProviderBaseUrlEnv(provider: PiAgentProvider): string | undefined {
  if (provider === "openai") {
    return normalizeOptionalString(workflow.getEnv("OPENAI_BASE_URL")) ??
      normalizeOptionalString(workflow.getEnv("OPENAPI_BASE_URL"));
  }

  return normalizeOptionalString(workflow.getEnv("ANTHROPIC_BASE_URL"));
}

function normalizeTools(value: unknown, knowledgeTools = true): string[] {
  const tools = readTools(value);
  if (!knowledgeTools) {
    return tools.filter((tool) => tool !== KNOWLEDGE_DOCUMENTS_TOOL_NAME);
  }
  return appendUniqueTool(tools, KNOWLEDGE_DOCUMENTS_TOOL_NAME);
}

function resolveEnabledPiTools(
  baseTools: string[],
  knowledgeTools: boolean,
  context: {
    toolPermissions?: {
      getTool(name: string): { enabled: boolean } | undefined;
    };
  },
): string[] {
  const requested = knowledgeTools
    ? appendUniqueTool(baseTools, KNOWLEDGE_DOCUMENTS_TOOL_NAME)
    : baseTools.filter((tool) => tool !== KNOWLEDGE_DOCUMENTS_TOOL_NAME);
  const seen = new Set<string>();
  const tools: string[] = [];
  for (const tool of requested) {
    if (!REGISTERED_PI_TOOLS.includes(tool) || seen.has(tool)) {
      continue;
    }
    seen.add(tool);
    if (context.toolPermissions?.getTool(tool)?.enabled === false) {
      continue;
    }
    tools.push(tool);
  }
  return tools;
}

function readTools(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeOptionalString(item)).filter((item): item is string => item !== undefined);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter((item) => item !== "");
  }

  return [];
}

function appendUniqueTool(tools: string[], toolName: string): string[] {
  return tools.includes(toolName) ? tools : [...tools, toolName];
}

function requireOutput(output: PiAgentOutputPayload | undefined): PiAgentOutputPayload {
  if (output === undefined) {
    throw new Error("Pi Agent output node did not produce output.");
  }

  return output;
}
