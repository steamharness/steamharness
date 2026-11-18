import path from "node:path";
import { Type, validateToolArguments, type Tool, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { createProjectToolPermissionContext, normalizeToolPermissionDefinitions, requireProjectToolApproval, type ToolPermissionDefinition } from "../tool-permissions/index";
import type { NodeContext } from "../types/index";
import { HarnessError } from "../workflow/errors";
import { currentBotRequestId } from "./bot-lifecycle";
import { readAgentToolDefinitions } from "./permission";
import { BUILTIN_AGENT_TOOL_NAMES, createBuiltinAgentTools } from "./tools";
import type { AgentTool, AgentToolSet } from "./types";

export function llmBotTools(overrides?: ToolPermissionDefinition[]): ToolPermissionDefinition[] {
  if (overrides !== undefined && !Array.isArray(overrides)) throw new HarnessError({ type: "input_validation", message: "Bot tools must be an array." });
  const tools = new Map(readAgentToolDefinitions().map(tool => [tool.name, {
    ...tool,
    ...(tool.name === "runtime_info" ? { description: "查看本轮的项目、宿主与实际运行版本。" } : {}),
    enabled: tool.name === "runtime_info", autoApprove: tool.name === "runtime_info",
  } satisfies ToolPermissionDefinition]));
  for (const override of normalizeToolPermissionDefinitions(overrides)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(override.name)) {
      throw new HarnessError({ type: "input_validation", message: `Invalid LLM Bot tool name "${override.name}".` });
    }
    const builtin = tools.get(override.name);
    tools.set(override.name, { name: override.name, label: override.label ?? builtin?.label, description: override.description ?? builtin?.description,
      enabled: override.enabled ?? builtin?.enabled ?? true, autoApprove: override.autoApprove ?? builtin?.autoApprove ?? false });
  }
  return [...tools.values()];
}

export async function createLLMBotToolRunner(
  definitions: ToolPermissionDefinition[], context: NodeContext,
  factory?: () => AgentToolSet | AgentTool[] | Promise<AgentToolSet | AgentTool[]>,
) {
  const permissions = context.toolPermissions ?? createProjectToolPermissionContext({ definitions, projectName: "bot", runId: String(context.metadata?.runId ?? "run") });
  const enabled = new Set(definitions.filter(tool => permissions.getTool(tool.name)?.enabled).map(tool => tool.name));
  const builtinNames = new Set<string>(BUILTIN_AGENT_TOOL_NAMES);
  const workdir = path.resolve(String(context.metadata?.entryRootDir ?? context.runtimeInfo?.project.directory ?? process.cwd()));
  const builtin = createBuiltinAgentTools({ Type, scope: { workdir, allowedDirectories: [workdir] }, engine: "llm", runtimeInfo: context.runtimeInfo });
  const created = factory && [...enabled].some(name => !builtinNames.has(name)) ? await factory() : undefined;
  const set: AgentToolSet | undefined = Array.isArray(created) ? { tools: created } : created;
  try {
    const active = new Map(builtin.filter(tool => enabled.has(tool.name)).map(tool => [tool.name, tool]));
    for (const tool of set?.tools ?? []) {
      if (!enabled.has(tool.name)) continue;
      if (builtinNames.has(tool.name) || active.has(tool.name)) {
        throw new HarnessError({ type: "input_validation", message: `Duplicate LLM Bot tool "${tool.name}".` });
      }
      active.set(tool.name, tool);
    }
    const tools: Tool[] = [...active.values()].map(({ name, description, parameters }) => ({ name, description, parameters }));
    const requestId = currentBotRequestId(context.projectId, context.entryId);
    const approvalContext = { ...context, toolPermissions: permissions, metadata: { ...context.metadata, botRequestId: requestId } };

    return {
      tools,
      close: () => set?.close?.(),
      async execute(call: ToolCall): Promise<{ result: ToolResultMessage; executed: boolean }> {
        context.abortSignal?.throwIfAborted();
        const error = (text: string, executed = false) => ({ result: { role: "toolResult" as const, toolCallId: call.id, toolName: call.name,
          content: [{ type: "text" as const, text }], isError: true, timestamp: Date.now() }, executed });
        const tool = active.get(call.name);
        if (!tool || call.namespace) return error("This tool is not available or is disabled.");
        let args: unknown;
        try {
          const prepared = tool.prepareArguments ? tool.prepareArguments(structuredClone(call.arguments)) : call.arguments;
          if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) return error("Tool arguments must be an object.");
          args = validateToolArguments(tool, { ...call, arguments: prepared as ToolCall["arguments"] });
        } catch {
          return error("Tool arguments do not match its schema.");
        }
        await requireProjectToolApproval(approvalContext, { name: tool.name, callId: call.id, arguments: structuredClone(args) }, "live");
        context.abortSignal?.throwIfAborted();
        try {
          const output = await tool.execute(call.id, args, context.abortSignal);
          context.abortSignal?.throwIfAborted();
          return { result: { role: "toolResult", toolCallId: call.id, toolName: tool.name, content: output.content,
            isError: output.isError === true, timestamp: Date.now() }, executed: true };
        } catch {
          context.abortSignal?.throwIfAborted();
          return error("Tool execution failed.", true);
        }
      },
    };
  } catch (error) {
    try { await set?.close?.(); } catch { /* Keep the original setup error. */ }
    throw error;
  }
}
