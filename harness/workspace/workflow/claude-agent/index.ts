import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeAgentInput,
  ClaudeAgentOutputPayload,
  ClaudeAgentParsedInput,
  ClaudeAgentSessionInput,
  PermissionMode,
} from "./interface";
import {
  createAssistantTextChunks,
  createToolApprovalDecisionChunks,
  createToolResultChunks,
  createToolUseChunks,
  summarizeToolInputForDisplay,
  type ToolDisplayStart,
} from "./output-items";
import {
  KNOWLEDGE_DOCUMENTS_MCP_SERVER_NAME,
  createKnowledgeDocumentsMcpServer,
} from "./knowledge-documents-tool";

const SESSION_ID_STATE_KEY = "claude-agent.sessionId";
const DEFAULT_ALLOWED_TOOLS = ["Read", "Edit", "Glob", "Grep", "Bash"];
const DEFAULT_PERMISSION_MODE: PermissionMode = "acceptEdits";
const PERMISSION_MODES: PermissionMode[] = ["acceptEdits", "dontAsk", "bypassPermissions", "default"];
const KNOWLEDGE_DOCUMENTS_ALLOWED_TOOL = "mcp__steamharness-knowledge-documents__knowledge_documents";
// keeps Claude Agent built-in tools visible in the shared permission
// panel and lets canUseTool enforce host overrides at call time.
const REGISTERED_CLAUDE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "LS",
  "Bash",
  "BashOutput",
  "KillBash",
  "WebFetch",
  "WebSearch",
  "Task",
  "ExitPlanMode",
  "ListMcpResources",
  "ReadMcpResource",
  "NotebookEdit",
  "NotebookRead",
  "TodoRead",
  "TodoWrite",
  "AskUserQuestion",
  "EnterWorktree",
  "ExitWorktree",
  KNOWLEDGE_DOCUMENTS_ALLOWED_TOOL,
];
const toolApproval = steamharness.createToolApprovalGate();

const inputNode = steamharness.createInputNode<ClaudeAgentInput, ClaudeAgentParsedInput>({
  name: "claude-agent-input",
  parse(input, context) {
    const rawDir = input.workdir ?? "~";
    const expandedWorkdir =
      rawDir === "~"
        ? os.homedir()
        : rawDir.startsWith("~/")
          ? path.join(os.homedir(), rawDir.slice(2))
          : rawDir;
    const tools = resolveEnabledClaudeTools(withKnowledgeDocumentsAllowedTool(
      input.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
      input.knowledgeTools !== false,
    ), context);
    return {
      prompt: input.prompt.trim(),
      systemPrompt: input.systemPrompt,
      tools,
      allowedTools: resolveAutoApprovedClaudeTools(tools, context),
      permissionMode: resolveClaudePermissionMode(
        input.permissionMode ?? DEFAULT_PERMISSION_MODE,
        context,
      ),
      workdir: path.resolve(expandedWorkdir),
      model: readOptionalString(input.model),
      knowledgeTools: input.knowledgeTools !== false,
    };
  },
});

const outputNode = steamharness.createOutputNode<ClaudeAgentSessionInput, ClaudeAgentOutputPayload>({
  name: "claude-agent-output",
  async *stream(input, context) {
    const baseUrlEnv = readOptionalString(steamharness.getEnv("ANTHROPIC_BASE_URL"));
    const apiKeyEnv = readOptionalString(steamharness.getEnv("ANTHROPIC_API_KEY"));
    let pendingToolApprovalError: steamharness.HarnessError | undefined;
    const pendingToolApprovalItems: ToolApprovalOutputItemInput[] = [];
    let toolCallCount = 0;
    let toolApprovalCount = 0;
    let textBlockCount = 0;
    let currentTextItemId: string | undefined;
    let lastToolItemId: string | undefined;
    let lastToolStart: ToolDisplayStart | undefined;
    let lastToolResult: unknown;
    let activeBlockType: "text" | "tool_use" | "tool_result" | null = null;
    let activeToolName = "";

    for await (const message of query({
      prompt: input.prompt,
      options: {
        tools: input.tools,
        allowedTools: input.allowedTools,
        permissionMode: input.permissionMode,
        canUseTool: createCanUseTool(context, (error) => {
          pendingToolApprovalError = error;
        }, (item) => {
          pendingToolApprovalItems.push(item);
        }),
        systemPrompt: input.systemPrompt,
        cwd: input.workdir,
        includePartialMessages: true,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...((baseUrlEnv !== undefined || apiKeyEnv !== undefined) ? {
          env: {
            ...process.env,
            ...(baseUrlEnv !== undefined ? { ANTHROPIC_BASE_URL: baseUrlEnv } : {}),
            ...(apiKeyEnv !== undefined ? {
              ANTHROPIC_API_KEY: apiKeyEnv,
              // Force an empty Claude config dir so stored ~/.claude credentials
              // don't override the custom API key from workflow env config.
              CLAUDE_CONFIG_DIR: (() => {
                const dir = path.join(os.tmpdir(), "workflow-claude-agent-empty-config");
                mkdirSync(dir, { recursive: true });
                return dir;
              })(),
            } : {}),
          },
        } : {}),
        ...(input.knowledgeTools
          ? {
              mcpServers: {
                [KNOWLEDGE_DOCUMENTS_MCP_SERVER_NAME]: createKnowledgeDocumentsMcpServer({
                  context,
                }),
              },
            }
          : {}),
        ...(input.isResume
          ? { resume: input.sessionId }
          : { sessionId: input.sessionId }),
      },
    })) {
      while (pendingToolApprovalItems.length > 0) {
        const item = pendingToolApprovalItems.shift();
        if (item === undefined) {
          continue;
        }
        toolApprovalCount++;
        for (const chunk of createToolApprovalDecisionChunks(item, toolApprovalCount)) {
          yield steamharness.createOutputItemChunk(chunk);
        }
      }
      throwPendingToolApprovalError(pendingToolApprovalError);
      if (message.type === "stream_event") {
        const event = (message as { event: Record<string, unknown> }).event;

        if (event.type === "content_block_start") {
          const block = event.content_block as Record<string, unknown>;
          if (block.type === "text") {
            activeBlockType = "text";
            textBlockCount++;
            currentTextItemId = `claude-agent-text-${textBlockCount}`;
            yield steamharness.createOutputItemChunk({
              type: "output_item_start",
              item: { id: currentTextItemId, title: "Output", content: "", contentType: "markdown", collapsed: false },
            });
          } else if (block.type === "tool_use") {
            activeBlockType = "tool_use";
            activeToolName = (block.name as string) ?? "unknown";
            if (lastToolItemId) {
              for (const chunk of createToolResultChunks(lastToolItemId, "success", lastToolResult, {
                startInfo: lastToolStart,
              })) {
                yield steamharness.createOutputItemChunk(chunk);
              }
            }
            lastToolResult = undefined;
            lastToolStart = undefined;
            toolCallCount++;
            lastToolItemId = `claude-agent-tool-${toolCallCount}`;
            lastToolStart = summarizeToolInputForDisplay(activeToolName, block.input);
            for (const chunk of createToolUseChunks({ name: activeToolName, input: block.input }, toolCallCount)) {
              yield steamharness.createOutputItemChunk(chunk);
            }
          } else if (block.type === "tool_result") {
            activeBlockType = "tool_result";
            lastToolResult = extractToolResultContent(block.content);
          }
        } else if (event.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown>;
          if (delta.type === "text_delta" && activeBlockType === "text" && currentTextItemId) {
            const text = delta.text as string;
            if (text) {
              yield steamharness.createOutputItemChunk({ type: "output_item_delta", itemId: currentTextItemId, delta: text });
            }
          }
        } else if (event.type === "content_block_stop") {
          if (activeBlockType === "text" && currentTextItemId) {
            yield steamharness.createOutputItemChunk({ type: "output_item_end", itemId: currentTextItemId });
            currentTextItemId = undefined;
          }
          activeBlockType = null;
        }
      } else if (message.type === "result") {
        if (lastToolItemId) {
          for (const chunk of createToolResultChunks(lastToolItemId, "success", lastToolResult, {
            startInfo: lastToolStart,
          })) {
            yield steamharness.createOutputItemChunk(chunk);
          }
          lastToolItemId = undefined;
          lastToolResult = undefined;
          lastToolStart = undefined;
        }
        const resultMsg = message as Record<string, unknown>;
        const usage = resultMsg.usage as Record<string, number> | undefined;
        if (usage) {
          await context.tokenUsage.report(createTokenUsageReport(usage));
        }
      }
    }

    throwPendingToolApprovalError(pendingToolApprovalError);
    if (currentTextItemId) {
      yield steamharness.createOutputItemChunk({ type: "output_item_end", itemId: currentTextItemId });
    }
  },
  async format(stream, input, context) {
    const toolItems = stream.items.filter((item) => item.metadata?.kind === "claude-agent-tool");
    const assistantContent = readAssistantContent(stream.items);

    await context.conversation.appendMessage({ role: "user", content: input.prompt });
    await context.conversation.appendMessage({
      role: "assistant",
      content: assistantContent,
      metadata: { toolCallCount: toolItems.length },
    });

    return {
      ...steamharness.createOutputPayload({ items: stream.items }),
      prompt: input.prompt,
      toolCallCount: toolItems.length,
      resultSubtype: "success",
    };
  },
});

export const claudeAgentProject = steamharness.defineProject<ClaudeAgentInput, ClaudeAgentOutputPayload>({
  name: "claude-agent",
  async run(input, context) {
    const parsed = await steamharness.runNode(inputNode, input, context);
    const state = await context.conversation.getValue();
    const storedSessionId = readOptionalString(state.values[SESSION_ID_STATE_KEY]);
    const isResume = storedSessionId !== undefined;
    const sessionId = storedSessionId ?? randomUUID();
    await context.conversation.setValue(SESSION_ID_STATE_KEY, sessionId);

    const result = await steamharness.runStreamNode(
      outputNode,
      { ...parsed, sessionId, isResume },
      context,
    );
    return requireOutput(result.output);
  },
});

export const executor = steamharness.defineExecutor<ClaudeAgentInput, ClaudeAgentOutputPayload>({
  projectType: "conversation",
  workflow: claudeAgentProject,
  tokenUsage: {
    enabled: true,
    display: true,
  },
  tools: [
    {
      name: "Read",
      label: "Read files",
      description: "Read files from the configured Claude Agent working directory.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "Write",
      label: "Write files",
      description: "Write files in the configured Claude Agent working directory.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "Edit",
      label: "Edit files",
      description: "Edit files in the configured Claude Agent working directory.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "MultiEdit",
      label: "Multi-edit files",
      description: "Apply multiple edits to a file through Claude Agent.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "Glob",
      label: "Glob files",
      description: "Find files by glob pattern in the configured working directory.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "Grep",
      label: "Search text",
      description: "Search file contents in the configured working directory.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "LS",
      label: "List directory",
      description: "List directory contents in the configured working directory.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "Bash",
      label: "Run shell commands",
      description: "Run shell commands through Claude Agent in the configured working directory.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "BashOutput",
      label: "Read Bash output",
      description: "Read output from a running Claude Agent shell command.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "KillBash",
      label: "Stop Bash command",
      description: "Stop a running Claude Agent shell command.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "WebFetch",
      label: "Fetch URL",
      description: "Fetch web content through Claude Agent when network access is configured.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "WebSearch",
      label: "Web Search",
      description: "Search the web through Claude Agent when network access is configured.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "Task",
      label: "Task Agent",
      description: "Invoke Claude Agent subagents through the Task tool.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "ExitPlanMode",
      label: "Exit plan mode",
      description: "Exit Claude Agent plan mode with an implementation plan.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "ListMcpResources",
      label: "List MCP resources",
      description: "List resources exposed by configured Claude Agent MCP servers.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "ReadMcpResource",
      label: "Read MCP resource",
      description: "Read a resource exposed by a configured Claude Agent MCP server.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "NotebookRead",
      label: "Read notebooks",
      description: "Read notebook files through Claude Agent.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "NotebookEdit",
      label: "Edit notebooks",
      description: "Edit notebook files through Claude Agent.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "TodoRead",
      label: "Read todos",
      description: "Read Claude Agent todo state.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "TodoWrite",
      label: "Write todos",
      description: "Update Claude Agent todo state.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "AskUserQuestion",
      label: "Ask user question",
      description: "Ask the user a structured question through Claude Agent.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "EnterWorktree",
      label: "Enter worktree",
      description: "Enter a Claude Agent managed worktree.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "ExitWorktree",
      label: "Exit worktree",
      description: "Exit a Claude Agent managed worktree.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "mcp__steamharness-knowledge-documents__knowledge_documents",
      label: "Knowledge Documents",
      description: "Manage PersistentValue-backed project markdown knowledge documents through the Claude MCP tool.",
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
          name: "systemPrompt",
          flag: "--system-prompt",
          type: "string",
          required: false,
          description: "Custom system prompt.",
        },
        {
          name: "allowedTools",
          flag: "--tools",
          type: "string",
          required: false,
          description: "Comma-separated list of allowed tools.",
          defaultValue: "Read,Edit,Glob,Grep,Bash",
        },
        {
          name: "permissionMode",
          flag: "--permission-mode",
          type: "string",
          required: false,
          description: "Permission mode for tool execution.",
          defaultValue: "acceptEdits",
          control: "radio",
          options: [
            { value: "acceptEdits", label: "Accept edits", description: "Auto-approve file edits." },
            { value: "dontAsk", label: "Don't ask", description: "Reject tools not in allowedTools." },
            { value: "bypassPermissions", label: "Bypass", description: "Run all tools without prompting." },
            { value: "default", label: "Default", description: "Require canUseTool callback." },
          ],
        },
        {
          name: "workdir",
          flag: "--workdir",
          shortFlag: "-C",
          type: "string",
          required: false,
          description: "Working directory for the agent.",
          defaultValue: "~",
        },
        {
          name: "model",
          flag: "--model",
          shortFlag: "-m",
          type: "string",
          required: false,
          description: "Claude model id (e.g. claude-sonnet-4-6). Falls back to ANTHROPIC_MODEL env var, then the SDK default.",
        },
        {
          name: "knowledgeTools",
          flag: "--knowledge-tools",
          type: "boolean",
          required: false,
          description: "Expose the workflow's PersistentValue-backed knowledge_documents tool (list / get / create / edit / delete / search / read_lines) to the agent. Enabled by default.",
          defaultValue: "true",
        }
      ],
    },
  ],
  createInput({ args }) {
    return parseInputArgs(args);
  },
});

export { claudeAgentProject as workflow };
export {
  createCanUseTool as __test_createCanUseTool,
  inputNode as __test_inputNode,
  outputNode as __test_outputNode,
};
export default claudeAgentProject;

function requireOutput(output: ClaudeAgentOutputPayload | undefined): ClaudeAgentOutputPayload {
  if (output === undefined) {
    throw new Error("Output node did not produce output.");
  }
  return output;
}

function throwPendingToolApprovalError(error: steamharness.HarnessError | undefined): void {
  if (error !== undefined) {
    // Claude Agent SDK turns canUseTool rejections into a model-visible
    // denial result. Re-throw from the workflow stream so shared user-input owns
    // the approval flow and the agent does not continue with a synthetic answer.
    throw error;
  }
}

function parseInputArgs(args: string[]): ClaudeAgentInput {
  const defaults = steamharness.parseConversationDefaultInputArgs(args);
  const defaultMessage = defaults.message.trim();
  let prompt = defaults.message;
  let systemPrompt: string | undefined;
  let allowedTools: string[] | undefined;
  let permissionMode: PermissionMode | undefined;
  let workdir: string | undefined;
  let model: string | undefined;
  let knowledgeTools: boolean | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--prompt" || args[i] === "-p") {
      const value = args[++i] ?? "";
      if (defaultMessage === "") {
        prompt = value;
      }
    } else if (args[i] === "--system-prompt") {
      systemPrompt = args[++i];
    } else if (args[i] === "--tools") {
      const raw = args[++i] ?? "";
      allowedTools = raw.split(",").map((t) => t.trim()).filter(Boolean);
    } else if (args[i] === "--permission-mode") {
      const value = args[++i];
      if (isPermissionMode(value)) permissionMode = value;
    } else if (args[i] === "--workdir" || args[i] === "-C") {
      workdir = args[++i];
    } else if (args[i] === "--model" || args[i] === "-m") {
      model = args[++i];
    } else if (args[i] === "--knowledge-tools") {
      knowledgeTools = true;
    } else if (args[i] === "--no-knowledge-tools") {
      knowledgeTools = false;
    } else if (defaultMessage === "") {
      positional.push(args[i]);
    }
  }

  if (defaultMessage === "" && prompt === "" && positional.length > 0) {
    prompt = positional[0];
  }

  return {
    prompt,
    systemPrompt,
    allowedTools,
    permissionMode,
    workdir,
    model: readOptionalString(model) ?? readOptionalString(steamharness.getEnv("ANTHROPIC_MODEL")),
    knowledgeTools: knowledgeTools ?? true,
  };
}

function isPermissionMode(value: string | undefined): value is PermissionMode {
  return value !== undefined && PERMISSION_MODES.includes(value as PermissionMode);
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

// Claude Agent SDK names MCP tools as `mcp__<server-name>__<tool-name>`; the
// MCP server we register is `workflow-knowledge-documents` and the tool is
// `knowledge_documents`, so the allowlist entry is fixed. Append it whenever
// the user opted into knowledgeTools so the agent never gets a runtime
// permission prompt for the tool we just registered.
function withKnowledgeDocumentsAllowedTool(
  baseTools: string[],
  knowledgeToolsEnabled: boolean,
): string[] {
  if (!knowledgeToolsEnabled) {
    return baseTools;
  }
  if (baseTools.includes(KNOWLEDGE_DOCUMENTS_ALLOWED_TOOL)) {
    return baseTools;
  }
  return [...baseTools, KNOWLEDGE_DOCUMENTS_ALLOWED_TOOL];
}

function resolveEnabledClaudeTools(
  tools: string[],
  context: {
    toolPermissions?: {
      getTool(name: string): { enabled: boolean } | undefined;
    };
  },
): string[] {
  const seen = new Set<string>();
  const enabledTools: string[] = [];
  for (const tool of tools) {
    if (seen.has(tool)) {
      continue;
    }
    seen.add(tool);
    if (REGISTERED_CLAUDE_TOOLS.includes(tool)) {
      const policy = context.toolPermissions?.getTool(tool);
      if (policy?.enabled === false) {
        continue;
      }
    }
    enabledTools.push(tool);
  }
  return enabledTools;
}

function resolveAutoApprovedClaudeTools(
  tools: string[],
  context: {
    toolPermissions?: {
      getTool(name: string): { enabled: boolean; autoApprove: boolean } | undefined;
    };
  },
): string[] {
  return tools.filter((tool) => {
    if (!REGISTERED_CLAUDE_TOOLS.includes(tool)) {
      return true;
    }
    const policy = context.toolPermissions?.getTool(tool);
    return policy?.enabled !== false && policy?.autoApprove !== false;
  });
}

function resolveClaudePermissionMode(
  requestedMode: PermissionMode,
  context: {
    toolPermissions?: {
      definitions?: Array<{ name: string }>;
      getTool(name: string): { enabled: boolean; autoApprove: boolean } | undefined;
    };
  },
): PermissionMode {
  const needsProjectApproval = context.toolPermissions?.definitions?.some((definition) =>
    context.toolPermissions?.getTool(definition.name)?.autoApprove === false
  ) === true;
  if (!needsProjectApproval) {
    return requestedMode;
  }

  // Claude SDK modes such as acceptEdits/dontAsk/bypassPermissions
  // can short-circuit canUseTool. Force default mode when the host requested
  // per-call steamharness approval so the shared gate receives the callback.
  return "default";
}

function createCanUseTool(context: {
  toolPermissions?: {
    getTool(name: string): { label?: string; description?: string } | undefined;
  };
}, onPendingApproval?: (error: steamharness.HarnessError) => void, onApprovalDecision?: (item: ToolApprovalOutputItemInput) => void): CanUseTool {
  return async (toolName, toolInput, options): Promise<PermissionResult> => {
    const tool = context.toolPermissions?.getTool(toolName);
    const approvalInput = {
      name: toolName,
      label: options.displayName ?? tool?.label,
      description: options.description ?? tool?.description,
      reason: options.title ?? options.decisionReason,
      arguments: toolInput,
    };
    try {
      // maps Claude Agent SDK permission checks onto steamharness's
      // shared user-input-backed tool approval gate.
      const decision = await toolApproval.approve(approvalInput, context as never);
      if (decision.requestId !== undefined) {
        onApprovalDecision?.({
          rawToolName: toolName,
          label: approvalInput.label,
          status: "approved",
          requestId: decision.requestId,
          reason: approvalInput.reason,
          arguments: toolInput,
          values: decision.values,
        });
      }
      return { behavior: "allow", updatedInput: toolInput };
    } catch (error) {
      if (error instanceof steamharness.HarnessError && error.type === "tool_permission_denied") {
        onApprovalDecision?.({
          rawToolName: toolName,
          label: approvalInput.label,
          status: "rejected",
          requestId: readApprovalRequestId(error),
          reason: approvalInput.reason,
          message: error.message,
          arguments: toolInput,
          values: readApprovalValues(error),
        });
        return {
          behavior: "deny",
          message: error.message,
        };
      }
      if (error instanceof steamharness.HarnessError && error.type === "user_input_required") {
        onPendingApproval?.(error);
      }
      throw error;
    }
  };
}

interface ToolApprovalOutputItemInput {
  rawToolName: string;
  label?: string;
  status: "approved" | "rejected";
  requestId?: string;
  reason?: string;
  message?: string;
  arguments?: unknown;
  values?: Record<string, unknown>;
}

function readApprovalRequestId(error: steamharness.HarnessError): string | undefined {
  const requestId = error.metadata?.["requestId"];
  return typeof requestId === "string" ? requestId : undefined;
}

function readApprovalValues(error: steamharness.HarnessError): Record<string, unknown> | undefined {
  const values = error.metadata?.["values"];
  return isRecord(values) ? values : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAssistantContent(items: Array<{ id: string; content: unknown }>): string {
  const textItems = items.filter((item) => item.id.startsWith("claude-agent-text-"));
  return textItems
    .map((item) => typeof item.content === "string" ? item.content.trim() : "")
    .filter(Boolean)
    .join("\n\n");
}

function createTokenUsageReport(usage: Record<string, number>) {
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cachedInputTokens = usage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    nodeName: "claude-agent-output",
    providerName: "claude-agent-sdk",
  };
}

function extractToolResultContent(content: unknown): unknown {
  if (content === undefined || content === null) return undefined;
  if (typeof content === "string") {
    return tryParseJson(content) ?? content;
  }
  if (!Array.isArray(content)) return content;
  // MCP tool results are an array of `content` blocks (text/image/etc).
  // Concatenate the text payloads and try to parse them as JSON, falling back
  // to a plain string array when no JSON shape is present.
  const texts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") texts.push(text);
    }
  }
  if (texts.length === 0) return content;
  if (texts.length === 1) {
    return tryParseJson(texts[0]) ?? texts[0];
  }
  return texts.map((text) => tryParseJson(text) ?? text);
}

function tryParseJson(value: string): unknown {
  if (value.length === 0) return undefined;
  if (value[0] !== "{" && value[0] !== "[" && value[0] !== "\"") {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
