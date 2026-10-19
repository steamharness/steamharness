import type { NodeContext, UserInputRequest, UserInputResolved } from "../types/index";
import { HarnessError } from "../workflow/errors";
import { createHash } from "node:crypto";

export interface ToolPermissionDefinition {
  name: string;
  label?: string;
  description?: string;
  enabled?: boolean;
  autoApprove?: boolean;
}

export interface ToolPermissionPolicy {
  enabled?: boolean;
  autoApprove?: boolean;
}

export type ToolPermissionPolicyMap = Record<string, ToolPermissionPolicy>;

export interface ToolPermissionResolved extends Required<ToolPermissionPolicy> {
  name: string;
  label?: string;
  description?: string;
}

export interface ToolPermissionContext {
  definitions: ToolPermissionDefinition[];
  policies: ToolPermissionPolicyMap;
  getTool(name: string): ToolPermissionResolved | undefined;
  requireToolApproval(input: ToolApprovalRequestInput): Promise<ToolApprovalDecision>;
  /**
   * Whether a tool call that is not auto-approved pauses this run to ask the
   * user. Unset means yes, which is what a run that never declares an agent
   * mode keeps doing.
   *
   * The agent runtime owns this and sets it for every turn: a plan turn asks,
   * while a build turn is running a plan the user has already approved and
   * executes its tools. This only decides whether the run stops to ask — a
   * tool the host disabled is still refused.
   */
  requiresUserApproval?: boolean;
}

export interface ToolApprovalRequestInput {
  callId?: string;
  name: string;
  label?: string;
  description?: string;
  reason?: string;
  arguments?: unknown;
}

export interface ToolApprovalDecision {
  approved: boolean;
  requestId?: string;
  values?: Record<string, unknown>;
}

export interface ToolApprovalGate {
  approve(
    input: ToolApprovalRequestInput,
    context: NodeContext,
  ): Promise<ToolApprovalDecision>;
  wrap<Args extends unknown[], Result>(
    name: string,
    fn: (...args: Args) => Promise<Result> | Result,
    options?: Omit<ToolApprovalRequestInput, "name" | "arguments"> & {
      arguments?: (...args: Args) => unknown;
    },
  ): (context: NodeContext, ...args: Args) => Promise<Result>;
}

export function createToolApprovalGate(): ToolApprovalGate {
  return {
    approve(input, context) {
      return requireWorkflowToolApproval(context, input);
    },
    wrap(name, fn, options) {
      return async (context, ...args) => {
        await requireWorkflowToolApproval(context, {
          name,
          label: options?.label,
          description: options?.description,
          reason: options?.reason,
          arguments: options?.arguments?.(...args),
        });
        return fn(...args);
      };
    },
  };
}

export function createWorkflowToolPermissionContext(options: {
  definitions?: ToolPermissionDefinition[];
  policies?: ToolPermissionPolicyMap;
  userInput?: NodeContext["userInput"];
  workflowName: string;
  runId: string;
}): ToolPermissionContext {
  const definitions = normalizeToolPermissionDefinitions(options.definitions);
  const policies = normalizeToolPermissionPolicies(options.policies, definitions);
  const resolved = new Map(
    definitions.map((definition) => [
      definition.name,
      resolveToolPermissionDefinition(definition, policies[definition.name]),
    ]),
  );
  const context: ToolPermissionContext = {
    definitions,
    policies,
    // Asking is the conservative default; the agent runtime lowers it for the
    // turns that execute rather than plan.
    requiresUserApproval: true,
    getTool(name) {
      const normalizedName = normalizeToolName(name);
      return normalizedName === undefined ? undefined : resolved.get(normalizedName);
    },
    requireToolApproval(input) {
      return requireWorkflowToolApproval({
        toolPermissions: context,
        userInput: options.userInput,
        metadata: {
          workflow: options.workflowName,
          runId: options.runId,
        },
      }, input);
    },
  };

  return context;
}

export function normalizeToolPermissionDefinitions(
  definitions: ToolPermissionDefinition[] | undefined,
): ToolPermissionDefinition[] {
  const seen = new Set<string>();
  const normalized: ToolPermissionDefinition[] = [];

  for (const definition of definitions ?? []) {
    const name = normalizeToolName(definition.name);
    if (name === undefined || seen.has(name)) {
      continue;
    }
    seen.add(name);
    normalized.push({
      name,
      label: normalizeOptionalText(definition.label),
      description: normalizeOptionalText(definition.description),
      enabled: definition.enabled === false ? false : true,
      autoApprove: definition.autoApprove === true,
    });
  }

  return normalized;
}

export function normalizeToolPermissionPolicies(
  policies: ToolPermissionPolicyMap | undefined,
  definitions: ToolPermissionDefinition[],
): ToolPermissionPolicyMap {
  const allowed = new Set(definitions.map((definition) => definition.name));
  const normalized: ToolPermissionPolicyMap = {};

  if (policies === undefined) {
    return normalized;
  }

  for (const [rawName, policy] of Object.entries(policies)) {
    const name = normalizeToolName(rawName);
    if (name === undefined || !allowed.has(name) || !isRecord(policy)) {
      continue;
    }

    normalized[name] = {
      enabled: typeof policy.enabled === "boolean" ? policy.enabled : undefined,
      autoApprove: typeof policy.autoApprove === "boolean" ? policy.autoApprove : undefined,
    };
  }

  return normalized;
}

export function parseToolPermissionPoliciesJson(
  value: string | undefined,
  definitions?: ToolPermissionDefinition[],
): ToolPermissionPolicyMap | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Tool permission policies must be a JSON object.");
  }

  const rawPolicies = normalizeRawToolPermissionPolicies(parsed as ToolPermissionPolicyMap);

  return definitions === undefined
    ? rawPolicies
    : normalizeToolPermissionPolicies(
        rawPolicies,
        normalizeToolPermissionDefinitions(definitions),
      );
}

export async function requireWorkflowToolApproval(
  context: Pick<NodeContext, "toolPermissions" | "userInput" | "metadata">,
  input: ToolApprovalRequestInput,
): Promise<ToolApprovalDecision> {
  const name = normalizeToolName(input.name);
  if (name === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: "Tool approval requires a non-empty tool name.",
      metadata: { toolName: input.name },
    });
  }

  const tool = context.toolPermissions?.getTool(name);
  if (tool === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: `Tool "${name}" is not registered in executor.tools.`,
      metadata: { toolName: name },
    });
  }

  if (!tool.enabled) {
    throw new HarnessError({
      type: "tool_permission_denied",
      message: `Tool "${name}" is disabled by the current tool permission policy.`,
      metadata: { toolName: name, policy: tool },
    });
  }

  if (tool.autoApprove) {
    return { approved: true };
  }

  // A build turn has nothing left to confirm: the tools it reaches for are the
  // ones the plan it is running named, and that plan was already approved. The
  // tool still has to be enabled, which is checked above.
  if (context.toolPermissions?.requiresUserApproval === false) {
    return { approved: true };
  }

  const request = createToolApprovalRequest({
    tool,
    input,
    metadata: context.metadata,
  });
  const resolved = await context.userInput?.getResolvedInput(request.requestId, request);

  if (resolved !== undefined) {
    return readApprovalDecision(resolved, name);
  }

  if (context.userInput === undefined) {
    throw new HarnessError({
      type: "user_input_required",
      message: `Tool "${name}" requires approval but the runtime has no userInput handler.`,
      metadata: { request },
    });
  }

  await context.userInput.requestInput(request);
  throw new HarnessError({
    type: "user_input_required",
    message: `Tool "${name}" is waiting for approval.`,
    nodeName: request.nodeName,
    metadata: { request },
  });
}

function resolveToolPermissionDefinition(
  definition: ToolPermissionDefinition,
  policy: ToolPermissionPolicy | undefined,
): ToolPermissionResolved {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    enabled: policy?.enabled ?? definition.enabled ?? true,
    autoApprove: policy?.autoApprove ?? definition.autoApprove ?? false,
  };
}

function normalizeRawToolPermissionPolicies(
  policies: ToolPermissionPolicyMap,
): ToolPermissionPolicyMap {
  const normalized: ToolPermissionPolicyMap = {};

  for (const [rawName, policy] of Object.entries(policies)) {
    const name = normalizeToolName(rawName);
    if (name === undefined || !isRecord(policy)) {
      continue;
    }

    normalized[name] = {
      enabled: typeof policy.enabled === "boolean" ? policy.enabled : undefined,
      autoApprove: typeof policy.autoApprove === "boolean" ? policy.autoApprove : undefined,
    };
  }

  return normalized;
}

function createToolApprovalRequest(options: {
  tool: ToolPermissionResolved;
  input: ToolApprovalRequestInput;
  metadata?: Record<string, unknown>;
}): UserInputRequest {
  const workflow = normalizeRequestIdPart(options.metadata?.["workflow"]) ?? "workflow";
  const runId = normalizeRequestIdPart(options.metadata?.["runId"]) ?? "run";
  const tool = normalizeRequestIdPart(options.tool.name) ?? "tool";
  const title = `批准工具：${options.input.label ?? options.tool.label ?? options.tool.name}`;
  const description = options.input.reason ??
    options.input.description ??
    options.tool.description ??
    `工具 ${options.tool.name} 请求执行。`;

  return {
    requestId: `${workflow}:${runId}:tool-approval:${tool}:${createHash("sha256").update(JSON.stringify([
      options.input.callId, canonicalArguments(options.input.arguments), options.tool,
    ])).digest("hex")}`,
    nodeName: "tool-approval",
    title,
    description,
    params: [
      {
        name: "approved",
        flag: "--approved",
        type: "boolean",
        required: true,
        defaultValue: "false",
        label: "批准执行",
        description: "允许本次工具调用继续执行。",
      },
    ],
    defaultValues: {
      approved: false,
    },
    metadata: {
      type: "tool-approval",
      title,
      version: "1.0.0",
      toolName: options.tool.name,
      toolArguments: options.input.arguments,
    },
    createdAt: new Date(),
  };
}

function canonicalArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalArguments);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalArguments(value[key])]));
  return value;
}

function readApprovalDecision(
  resolved: UserInputResolved,
  toolName: string,
): ToolApprovalDecision {
  const approved = resolved.values["approved"] === true;
  if (!approved) {
    throw new HarnessError({
      type: "tool_permission_denied",
      message: `Tool "${toolName}" was rejected by the approval request.`,
      metadata: {
        toolName,
        requestId: resolved.requestId,
        values: resolved.values,
      },
    });
  }

  return {
    approved,
    requestId: resolved.requestId,
    values: resolved.values,
  };
}

function normalizeToolName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function normalizeRequestIdPart(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, "-");
  return normalized === "" ? undefined : normalized;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === "" ? undefined : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
