import type {
  NodeExecutionHookFinishEvent,
  NodeExecutionHooks,
  NodeExecutionKind,
  NodeMetadata,
  RunPayload,
  UserInputRequest,
  UserInputResolved,
} from "../types/index";
import type {
  ConversationDefinition,
  NodeRegistryItem,
  ParamDefinition,
  ParamLayout,
} from "./types";
import type { ProjectKind } from "../project-types";
import type { KanbanManifest } from "@steamharness/kanban-project";
import type {
  SchedulePreset,
  ScheduleSourceMetadata,
} from "@steamharness/workflow-schedules";
import type { ToolPermissionDefinition } from "../tool-permissions/index";
import type {
  TokenUsageAggregate,
  TokenUsageDefinition,
} from "../token-usage/index";
import type {
  TimerRecord,
} from "../timer/index";
import type {
  DefinedNode,
  StructureDefinitions,
  StructureDiagnostics,
  StructureEntrypoint,
  StructureExecution,
  StructureWorkflow,
} from "./rules";
import {
  serializeWorkflowError,
  type SerializedWorkflowError,
  type ErrorType,
  type RunResult,
} from "../workflow/index";
import {
  createOutputItem,
  createOutputPayload,
  isOutputContentType,
  isWorkflowOutputPayload,
  type OutputItem,
  type RunOutputPayload,
} from "../node/output/index";

export type ExecutorNodeExecutionStatus = "running" | "success" | "failed";
export type RunStatus = "running" | "waiting_for_input" | "success" | "failed" | "aborted" | "timed_out";

export type RuntimeEvent =
  | {
      type: "workflow_started";
      runId: string;
      projectName: string;
      entrypointId?: string;
      entrypointTitle?: string;
      startedAt: Date;
    }
  | {
      type: "workflow_succeeded";
      runId: string;
      projectName: string;
      entrypointId?: string;
      entrypointTitle?: string;
      endedAt: Date;
      durationMs: number;
    }
  | {
      type: "project_failed";
      runId: string;
      projectName: string;
      entrypointId?: string;
      entrypointTitle?: string;
      endedAt: Date;
      durationMs: number;
      error?: SerializedWorkflowError;
    }
  | {
      type: "workflow_aborted";
      runId: string;
      projectName: string;
      entrypointId?: string;
      entrypointTitle?: string;
      endedAt: Date;
      durationMs: number;
      reason: string;
    }
  | {
      type: "workflow_timed_out";
      runId: string;
      projectName: string;
      entrypointId?: string;
      entrypointTitle?: string;
      endedAt: Date;
      durationMs: number;
      timeoutMs: number;
    }
  | {
      type: "conversation_title_updated";
      runId: string;
      projectName: string;
      conversationId: string;
      title?: string;
      updatedAt: Date;
    }
  | {
      type: "token_usage_updated";
      runId: string;
      projectName: string;
      conversationId?: string;
      usage: TokenUsageAggregate;
      updatedAt: Date;
    }
  | ({
      type: "user_input_requested";
      runId: string;
      projectName: string;
    } & UserInputRequest)
  | ({
      type: "user_input_resolved";
      runId: string;
      projectName: string;
    } & UserInputResolved)
  | {
      type: "timer_started";
      runId: string;
      projectName: string;
      timer: TimerRecord;
    }
  | {
      type: "timer_finished";
      runId: string;
      projectName: string;
      timer: TimerRecord;
    }
  | {
      type: "node_started";
      runId: string;
      projectName: string;
      executionId: string;
      nodeName: string;
      kind: NodeExecutionKind;
      metadata?: NodeMetadata;
      startedAt: Date;
    }
  | {
      type: "node_chunk";
      runId: string;
      projectName: string;
      executionId: string;
      nodeName: string;
      kind: NodeExecutionKind;
      metadata?: NodeMetadata;
      chunk: unknown;
      chunkOrder: number;
      timestamp: Date;
    }
  | {
      type: "node_finished";
      runId: string;
      projectName: string;
      executionId: string;
      nodeName: string;
      kind: NodeExecutionKind;
      metadata?: NodeMetadata;
      status: ExecutorNodeExecutionStatus;
      startedAt: Date;
      endedAt: Date;
      durationMs: number;
      input?: unknown;
      output?: unknown;
      error?: SerializedWorkflowError;
      executionInfo?: unknown;
    };

export interface ExecutorNodeExecutionReport {
  order: number;
  executionId: string;
  name: string;
  kind: NodeExecutionKind;
  metadata?: NodeMetadata;
  status: ExecutorNodeExecutionStatus;
  startedAt: Date;
  endedAt?: Date;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: SerializedWorkflowError;
  executionInfo?: unknown;
}

export interface OutputReport {
  order: number;
  nodeOrder: number;
  nodeName: string;
  output: RunOutputPayload;
}

export interface ExecutorOutput extends RunOutputPayload {
  [key: string]: unknown;
}

export interface ExecutorResult<
  Output extends RunPayload = ExecutorOutput,
> {
  errCode: number;
  errMessage: string;
  output: Output | null;
}

export interface ExecutionReport<Output = unknown> {
  runId: string;
  projectName: string;
  entrypointId?: string;
  entrypointTitle?: string;
  source?: ScheduleSourceMetadata["source"];
  scheduleId?: string;
  scheduleName?: string;
  fireId?: string;
  scheduledFor?: string;
  triggerKind?: ScheduleSourceMetadata["triggerKind"];
  conversationId?: string;
  conversationTitle?: string;
  status: RunStatus;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  definedNodes: DefinedNode[];
  registry: NodeRegistryItem[];
  result: RunResult<Output>;
  nodes: ExecutorNodeExecutionReport[];
  outputs: OutputReport[];
  pendingUserInput?: UserInputRequest;
  resolvedUserInputs?: UserInputResolved[];
  timers?: TimerRecord[];
  tokenUsage?: ExecutionReportTokenUsage;
}

export interface ExecutionReportTokenUsage {
  enabled: true;
  display: boolean;
  run: TokenUsageAggregate;
}

export interface DefinitionEvent {
  projectName: string;
  projectDir: string;
  nodes: DefinedNode[];
}

export interface StructureReport {
  projectType: ProjectKind;
  workflow: StructureWorkflow;
  definitions: StructureDefinitions;
  defaultEntrypoint?: string;
  entrypoints?: StructureEntrypoint[];
  schedulePresets?: SchedulePreset[];
  execution?: StructureExecution;
  diagnostics: StructureDiagnostics;
  params?: ParamDefinition[];
  paramLayout?: ParamLayout;
  paramResolver?: { enabled: true };
  tools?: ToolPermissionDefinition[];
  conversation?: ConversationDefinition;
  tokenUsage?: TokenUsageDefinition;
  registry?: NodeRegistryItem[];
  kanban?: {
    artifactDir: string;
    entry: string;
    manifest?: KanbanManifest;
  };
}

export interface NodeExecutionReporter {
  hooks: NodeExecutionHooks;
  getReports(): ExecutorNodeExecutionReport[];
  getOutputs(): OutputReport[];
}

export interface ExecutionReporter extends NodeExecutionReporter {
  emitWorkflowStarted(event: {
    runId: string;
    projectName: string;
    entrypointId?: string;
    entrypointTitle?: string;
    conversationId?: string;
    startedAt: Date;
  }): Promise<void>;
  emitWorkflowFinished(event: {
    runId: string;
    projectName: string;
    entrypointId?: string;
    entrypointTitle?: string;
    conversationId?: string;
    status: RunStatus;
    startedAt: Date;
    endedAt: Date;
    result: RunResult<unknown>;
    outputs?: OutputReport[];
    timeoutMs?: number;
  }): Promise<void>;
  emitConversationTitleUpdated(event: {
    runId: string;
    projectName: string;
    conversationId: string;
    title?: string;
    updatedAt: Date;
  }): Promise<void>;
  emitTokenUsageUpdated(event: {
    runId: string;
    projectName: string;
    conversationId?: string;
    usage: TokenUsageAggregate;
    updatedAt: Date;
  }): Promise<void>;
  emitUserInputRequested(event: UserInputRequest): Promise<void>;
  emitUserInputResolved(event: UserInputResolved): Promise<void>;
  getPendingUserInput(): UserInputRequest | undefined;
  getResolvedUserInputs(): UserInputResolved[];
  emitTimerStarted(event: {
    runId: string;
    projectName: string;
    timer: TimerRecord;
  }): Promise<void>;
  emitTimerFinished(event: {
    runId: string;
    projectName: string;
    timer: TimerRecord;
  }): Promise<void>;
  getConversationTitle(): string | undefined;
}

export function createNodeExecutionReporter(options: {
  runId?: string;
  projectName?: string;
  onRuntimeEvent?(event: RuntimeEvent): Promise<void> | void;
} = {}): ExecutionReporter {
  const reports: ExecutorNodeExecutionReport[] = [];
  const reportsById = new Map<string, ExecutorNodeExecutionReport>();
  const outputs: OutputReport[] = [];
  const runId = options.runId ?? "";
  const projectName = options.projectName ?? "";
  const onRuntimeEvent = options.onRuntimeEvent;
  let conversationTitle: string | undefined;
  let pendingUserInput: UserInputRequest | undefined;
  const resolvedUserInputs: UserInputResolved[] = [];

  async function emit(event: RuntimeEvent): Promise<void> {
    if (onRuntimeEvent === undefined) {
      return;
    }

    await onRuntimeEvent(event);
  }

  return {
    emitWorkflowStarted(event) {
      return emit({
        type: "workflow_started",
        runId: event.runId,
        projectName: event.projectName,
        entrypointId: event.entrypointId,
        entrypointTitle: event.entrypointTitle,
        startedAt: event.startedAt,
      });
    },
    emitWorkflowFinished(event) {
      const durationMs = event.endedAt.getTime() - event.startedAt.getTime();

      if (event.status === "success") {
        return emit({
          type: "workflow_succeeded",
          runId: event.runId,
          projectName: event.projectName,
          entrypointId: event.entrypointId,
          entrypointTitle: event.entrypointTitle,
          endedAt: event.endedAt,
          durationMs,
        });
      }

      if (event.status === "aborted") {
        return emit({
          type: "workflow_aborted",
          runId: event.runId,
          projectName: event.projectName,
          entrypointId: event.entrypointId,
          entrypointTitle: event.entrypointTitle,
          endedAt: event.endedAt,
          durationMs,
          reason: readWorkflowResultMessage(event.result, event.outputs ?? outputs) ??
            "Workflow execution was aborted.",
        });
      }

      if (event.status === "timed_out") {
        return emit({
          type: "workflow_timed_out",
          runId: event.runId,
          projectName: event.projectName,
          entrypointId: event.entrypointId,
          entrypointTitle: event.entrypointTitle,
          endedAt: event.endedAt,
          durationMs,
          timeoutMs: event.timeoutMs ?? durationMs,
        });
      }

      if (event.status === "waiting_for_input") {
        return Promise.resolve();
      }

      return emit({
        type: "project_failed",
        runId: event.runId,
        projectName: event.projectName,
        entrypointId: event.entrypointId,
        entrypointTitle: event.entrypointTitle,
        endedAt: event.endedAt,
        durationMs,
        error: readWorkflowResultError(event.result, event.outputs ?? outputs),
      });
    },
    emitConversationTitleUpdated(event) {
      conversationTitle = event.title;
      return emit({
        type: "conversation_title_updated",
        runId: event.runId,
        projectName: event.projectName,
        conversationId: event.conversationId,
        title: event.title,
        updatedAt: event.updatedAt,
      });
    },
    emitTokenUsageUpdated(event) {
      return emit({
        type: "token_usage_updated",
        runId: event.runId,
        projectName: event.projectName,
        conversationId: event.conversationId,
        usage: event.usage,
        updatedAt: event.updatedAt,
      });
    },
    emitUserInputRequested(event) {
      pendingUserInput = cloneUserInputRequest(event);
      return emit({
        type: "user_input_requested",
        runId,
        projectName,
        ...cloneUserInputRequest(event),
      });
    },
    emitUserInputResolved(event) {
      pendingUserInput = undefined;
      resolvedUserInputs.push(cloneUserInputResolved(event));
      return emit({
        type: "user_input_resolved",
        runId,
        projectName,
        ...cloneUserInputResolved(event),
      });
    },
    emitTimerStarted(event) {
      return emit({
        type: "timer_started",
        runId: event.runId,
        projectName: event.projectName,
        timer: cloneTimerRecord(event.timer),
      });
    },
    emitTimerFinished(event) {
      return emit({
        type: "timer_finished",
        runId: event.runId,
        projectName: event.projectName,
        timer: cloneTimerRecord(event.timer),
      });
    },
    hooks: {
      onNodeStart(event) {
        const report: ExecutorNodeExecutionReport = {
          order: reports.length + 1,
          executionId: event.executionId,
          name: event.nodeName,
          kind: event.kind,
          metadata: cloneNodeMetadata(event.metadata),
          status: "running",
          startedAt: event.startedAt,
        };

        reports.push(report);
        reportsById.set(event.executionId, report);
        return emit({
          type: "node_started",
          runId,
          projectName,
          executionId: event.executionId,
          nodeName: event.nodeName,
          kind: event.kind,
          metadata: cloneNodeMetadata(event.metadata),
          startedAt: event.startedAt,
        });
      },
      onNodeChunk(event) {
        return emit({
          type: "node_chunk",
          runId,
          projectName,
          executionId: event.executionId,
          nodeName: event.nodeName,
          kind: event.kind,
          metadata: cloneNodeMetadata(event.metadata),
          chunk: event.chunk,
          chunkOrder: event.chunkOrder,
          timestamp: event.timestamp,
        });
      },
      onNodeFinish(event) {
        const report = resolveReport(event, reports, reportsById);

        report.status = event.status;
        report.endedAt = event.endedAt;
        report.durationMs = event.durationMs;
        // Keep node input/output in the runtime report so Tracing can
        // inspect conversation prompts and other node payload changes.
        report.input = event.input;
        report.output = event.output;
        report.executionInfo = event.executionInfo;

        if (
          event.status === "success" &&
          event.nodeName === "output" &&
          event.outputVisibility !== "hidden"
        ) {
          outputs.push({
            order: outputs.length + 1,
            nodeOrder: report.order,
            nodeName: event.nodeName,
            output: normalizeWorkflowOutputPayload(event.output),
          });
        }

        if (event.error !== undefined) {
          report.error = serializeWorkflowError(event.error);
        }

        return emit({
          type: "node_finished",
          runId,
          projectName,
          executionId: event.executionId,
          nodeName: event.nodeName,
          kind: event.kind,
          metadata: cloneNodeMetadata(event.metadata),
          status: event.status,
          startedAt: event.startedAt,
          endedAt: event.endedAt,
          durationMs: event.durationMs,
          input: event.input,
          output: event.output,
          error: event.error === undefined ? undefined : serializeWorkflowError(event.error),
          executionInfo: event.executionInfo,
        });
      },
    },
    getReports() {
      return reports.map(cloneNodeExecutionReport);
    },
    getOutputs() {
      return outputs.map(cloneOutputReport);
    },
    getConversationTitle() {
      return conversationTitle;
    },
    getPendingUserInput() {
      return pendingUserInput === undefined ? undefined : cloneUserInputRequest(pendingUserInput);
    },
    getResolvedUserInputs() {
      return resolvedUserInputs.map(cloneUserInputResolved);
    },
  };
}

export function combineNodeExecutionHooks(
  ...hooksList: Array<NodeExecutionHooks | undefined>
): NodeExecutionHooks | undefined {
  const hooks = hooksList.filter((hooksItem): hooksItem is NodeExecutionHooks => {
    return hooksItem !== undefined;
  });

  if (hooks.length === 0) {
    return undefined;
  }

  return {
    onNodeStart(event) {
      return callHooks(hooks, "onNodeStart", event);
    },
    onNodeChunk(event) {
      return callHooks(hooks, "onNodeChunk", event);
    },
    onNodeSuccess(event) {
      return callHooks(hooks, "onNodeSuccess", event);
    },
    onNodeError(event) {
      return callHooks(hooks, "onNodeError", event);
    },
    onNodeFinish(event) {
      return callHooks(hooks, "onNodeFinish", event);
    },
  };
}

export function createWorkflowExecutionReport<Output>(
  options: {
    runId: string;
    projectName: string;
    entrypointId?: string;
    entrypointTitle?: string;
    startedAt: Date;
    endedAt: Date;
    status?: RunStatus;
    definedNodes?: DefinedNode[];
    registry?: NodeRegistryItem[];
    conversationId?: string;
    conversationTitle?: string;
    result: RunResult<Output>;
    nodes: ExecutorNodeExecutionReport[];
    outputs?: OutputReport[];
    pendingUserInput?: UserInputRequest;
    resolvedUserInputs?: UserInputResolved[];
    timers?: TimerRecord[];
    tokenUsage?: ExecutionReportTokenUsage;
  },
): ExecutionReport<Output> {
  const outputs = options.outputs ?? [];

  return {
    runId: options.runId,
    projectName: options.projectName,
    entrypointId: options.entrypointId,
    entrypointTitle: options.entrypointTitle,
    conversationId: options.conversationId,
    conversationTitle: options.conversationTitle,
    status: options.status ?? resolveWorkflowResultStatus(options.result, outputs),
    startedAt: options.startedAt,
    endedAt: options.endedAt,
    durationMs: options.endedAt.getTime() - options.startedAt.getTime(),
    definedNodes: options.definedNodes ?? [],
    registry: options.registry ?? [],
    result: createReportedWorkflowResult(options.result, outputs),
    nodes: options.nodes,
    outputs,
    pendingUserInput: options.pendingUserInput,
    resolvedUserInputs: options.resolvedUserInputs,
    timers: options.timers,
    tokenUsage: options.tokenUsage,
  };
}

function createReportedWorkflowResult<Output>(
  result: RunResult<Output>,
  outputs: OutputReport[],
): RunResult<Output> {
  if (!result.ok) {
    return {
      ok: true,
      data: {
        errCode: mapErrorTypeToCode(result.error.type),
        errMessage: readWorkflowErrorMessage(result.error),
        output: null,
      } as Output,
    };
  }

  const output = createWorkflowExecutorOutput(
    outputs.length === 0
      ? [result.data]
      : outputs.map((item) => item.output),
  );
  const resultErrCode = readPayloadErrCode(result.data);
  const outputErrCode = readPayloadErrCode(output);
  const errCode = resultErrCode !== undefined && resultErrCode !== 0
    ? resultErrCode
    : outputErrCode ?? resultErrCode ?? 0;
  const errMessage = errCode === 0
    ? ""
    : readPayloadErrMessage(output) ??
      readPayloadErrMessage(result.data) ??
      `Workflow returned errCode ${errCode}.`;

  return {
    ok: true,
    data: {
      errCode,
      errMessage,
      output,
    } as Output,
  };
}

export function resolveWorkflowResultStatus(
  result: RunResult<unknown>,
  outputs: OutputReport[] = [],
): RunStatus {
  return readWorkflowResultErrCode(result, outputs) === 0 ? "success" : "failed";
}

export function readWorkflowResultErrCode(
  result: RunResult<unknown>,
  outputs: OutputReport[] = [],
): number {
  if (!result.ok) {
    return mapErrorTypeToCode(result.error.type);
  }

  if (outputs.length > 0) {
    const output = createWorkflowExecutorOutput(outputs.map((item) => item.output));
    const resultErrCode = readPayloadErrCode(result.data);
    const outputErrCode = readPayloadErrCode(output);
    return resultErrCode !== undefined && resultErrCode !== 0
      ? resultErrCode
      : outputErrCode ?? resultErrCode ?? 0;
  }

  return readPayloadErrCode(result.data) ?? 0;
}

function mapErrorTypeToCode(type: ErrorType): number {
  switch (type) {
    case "input_validation":
      return 400;
    case "user_input_required":
      return 202;
    case "tool_permission_denied":
      return 403;
    case "execution_aborted":
      return 499;
    case "provider_call":
      return 502;
    case "stream_interrupted":
      return 499;
    case "node_execution":
    case "execution":
    default:
      return 500;
  }
}

function cloneUserInputRequest(event: UserInputRequest): UserInputRequest {
  return {
    ...event,
    params: event.params.map((param) => ({ ...param })),
    defaultValues: cloneRecord(event.defaultValues),
    metadata: cloneNodeMetadata(event.metadata),
    createdAt: cloneDate(event.createdAt) ?? new Date(event.createdAt),
  };
}

function cloneUserInputResolved(event: UserInputResolved): UserInputResolved {
  return {
    ...event,
    values: cloneRecord(event.values) ?? {},
    submittedAt: cloneDate(event.submittedAt) ?? new Date(event.submittedAt),
    request: event.request === undefined ? undefined : cloneUserInputRequest(event.request),
  };
}

function cloneRecord<T extends Record<string, unknown>>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : { ...value };
}

function cloneDate(value: Date | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}

function readWorkflowResultError(
  result: RunResult<unknown>,
  outputs: OutputReport[] = [],
): SerializedWorkflowError | undefined {
  if (!result.ok) {
    return result.error;
  }

  const errCode = readWorkflowResultErrCode(result, outputs);
  if (errCode === 0) {
    return undefined;
  }

  return {
    type: "execution",
    message: readWorkflowResultMessage(result, outputs) ?? `Workflow returned errCode ${errCode}.`,
    metadata: { errCode },
  };
}

function readWorkflowResultMessage(
  result: RunResult<unknown>,
  outputs: OutputReport[] = [],
): string | undefined {
  if (!result.ok) {
    return readWorkflowErrorMessage(result.error);
  }

  if (outputs.length > 0) {
    const output = createWorkflowExecutorOutput(outputs.map((item) => item.output));
    const errMessage = readPayloadErrMessage(output);
    if (errMessage !== undefined) {
      return errMessage;
    }
  }

  if (isOutputObject(result.data)) {
    return readPayloadErrMessage(result.data);
  }

  return undefined;
}

function readWorkflowErrorMessage(error: SerializedWorkflowError): string {
  const causeMessage = formatWorkflowErrorCause(error.cause);
  if (causeMessage !== undefined && causeMessage !== "") {
    return causeMessage;
  }

  return error.message;
}

function formatWorkflowErrorCause(
  cause: SerializedWorkflowError["cause"] | undefined,
): string | undefined {
  if (cause === undefined) {
    return undefined;
  }

  const nested = formatWorkflowErrorCause(cause.cause);
  const message = nested ?? cause.message?.trim();
  if (message === undefined || message === "") {
    return undefined;
  }

  const details = [
    cause.statusCode === undefined ? undefined : `status ${cause.statusCode}`,
    cause.url,
    readResponseBodyDetail(cause, nested),
  ].filter((value): value is string => value !== undefined && value !== "");

  return details.length > 0 ? `${message} (${details.join(", ")})` : message;
}

/**
 * Surfaces the upstream response body when the message alone does not explain the failure.
 *
 * HTTP client errors frequently carry only the `statusText` as their message (`Unauthorized`, `Not Found`),
 * which is indistinguishable between "our credential is wrong" and "the request never reached the upstream".
 * The already redacted and truncated body excerpt is what actually names the reason.
 *
 * It is only reported when this level supplied the message: a nested cause wins the message, and pairing a
 * deeper message with this level's body would attribute the body to the wrong failure.
 */
function readResponseBodyDetail(
  cause: NonNullable<SerializedWorkflowError["cause"]>,
  nested: string | undefined,
): string | undefined {
  if (nested !== undefined) {
    return undefined;
  }

  const responseBody = cause.responseBody?.trim();
  if (responseBody === undefined || responseBody === "") {
    return undefined;
  }

  // The excerpt is whitespace-collapsed and may end in an ellipsis, so compare against the leading portion
  // rather than the whole value; a strict match would never fire for a truncated body.
  const probe = responseBody.replace(/…$/, "");
  const message = cause.message?.trim() ?? "";
  if (probe !== "" && message.replace(/\s+/g, " ").includes(probe)) {
    return undefined;
  }

  return `response ${responseBody}`;
}

function createWorkflowExecutorOutput(values: unknown[]): ExecutorOutput {
  const output = createOutputPayload();
  const items: OutputItem[] = [];

  for (const value of values) {
    if (isOutputObject(value)) {
      for (const [key, propertyValue] of Object.entries(value)) {
        if (key === "items") {
          continue;
        }

        if (key === "errCode") {
          const errCode = readPayloadErrCode(value);
          if (errCode !== undefined && (output.errCode === 0 || errCode !== 0)) {
            output.errCode = errCode;
          }
          continue;
        }

        if (key === "errMessage" && typeof propertyValue === "string") {
          if (output.errMessage === "" || output.errCode !== 0) {
            output.errMessage = propertyValue;
          }
          continue;
        }

        output[key] = propertyValue;
      }

      if (Array.isArray(value.items)) {
        items.push(...value.items.map((item) => normalizeWorkflowOutputItem(item)));
        continue;
      }
    }

    items.push(createOutputItem({
      title: "Output",
      content: value,
      contentType: inferOutputContentType(value),
      collapsed: false,
    }));
  }

  output.items = items;

  return output;
}

function normalizeWorkflowOutputPayload(value: unknown): RunOutputPayload {
  if (isWorkflowOutputPayload(value)) {
    return createOutputPayload({
      ...value,
      items: value.items.map((item) => normalizeWorkflowOutputItem(item)),
    });
  }

  if (isOutputObject(value) && Array.isArray(value.items)) {
    return createOutputPayload({
      ...value,
      items: value.items.map((item) => normalizeWorkflowOutputItem(item)),
    });
  }

  return createOutputPayload({
    items: [{
      title: "Output",
      content: value,
      contentType: inferOutputContentType(value),
      collapsed: false,
    }],
  });
}

function normalizeWorkflowOutputItem(value: unknown): OutputItem {
  if (isOutputObject(value)) {
    return createOutputItem({
      id: typeof value.id === "string" ? value.id : undefined,
      title: typeof value.title === "string" ? value.title : "Output",
      content: value.content,
      icon: typeof value.icon === "string" ? value.icon : undefined,
      iconPreset: typeof value.iconPreset === "string" ? value.iconPreset as never : undefined,
      contentType: isOutputContentType(value.contentType) ? value.contentType : inferOutputContentType(value.content),
      display: isOutputObject(value.display) && value.display.type === "ring"
        ? { type: "ring", ...(value.display.placement === "inline" || value.display.placement === "composer-right"
          ? { placement: value.display.placement } : {}) }
        : undefined,
      collapsed: typeof value.collapsed === "boolean" ? value.collapsed : undefined,
      metadata: isOutputObject(value.metadata) ? value.metadata : undefined,
    });
  }

  return createOutputItem({
    title: "Output",
    content: value,
    contentType: inferOutputContentType(value),
  });
}

function inferOutputContentType(value: unknown): "markdown" | "text" | "json" | "audio" | "video" {
  return typeof value === "object" && value !== null ? "json" : "markdown";
}

function isOutputObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPayloadErrCode(value: unknown): number | undefined {
  if (!isOutputObject(value)) {
    return undefined;
  }

  const errCode = value["errCode"];
  if (typeof errCode === "number" && Number.isFinite(errCode)) {
    return errCode;
  }

  if (typeof errCode === "string" && errCode.trim() !== "") {
    const parsed = Number(errCode);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function readPayloadErrMessage(value: unknown): string | undefined {
  if (!isOutputObject(value)) {
    return undefined;
  }

  const errMessage = value["errMessage"];
  return typeof errMessage === "string" && errMessage.trim() !== ""
    ? errMessage
    : undefined;
}

async function callHooks<Event>(
  hooks: NodeExecutionHooks[],
  hookName: keyof NodeExecutionHooks,
  event: Event,
): Promise<void> {
  for (const hooksItem of hooks) {
    const hook = hooksItem[hookName] as
      | ((hookEvent: Event) => Promise<void> | void)
      | undefined;

    if (hook === undefined) {
      continue;
    }

    try {
      await hook(event);
    } catch (error) {
      console.error(`[workflow] Node execution hook "${hookName}" threw an error:`, error);
    }
  }
}

function resolveReport(
  event: NodeExecutionHookFinishEvent,
  reports: ExecutorNodeExecutionReport[],
  reportsById: Map<string, ExecutorNodeExecutionReport>,
): ExecutorNodeExecutionReport {
  const existingReport = reportsById.get(event.executionId);

  if (existingReport !== undefined) {
    return existingReport;
  }

  console.error(
    `[workflow] onNodeFinish received for execution "${event.executionId}" (node: "${event.nodeName}") without a prior onNodeStart. This indicates a hook execution order bug.`,
  );

  const report: ExecutorNodeExecutionReport = {
    order: reports.length + 1,
    executionId: event.executionId,
    name: event.nodeName,
    kind: event.kind,
    metadata: cloneNodeMetadata(event.metadata),
    status: "running",
    startedAt: event.startedAt,
  };

  reports.push(report);
  reportsById.set(event.executionId, report);

  return report;
}

function cloneNodeExecutionReport(
  report: ExecutorNodeExecutionReport,
): ExecutorNodeExecutionReport {
  return {
    ...report,
    metadata: cloneNodeMetadata(report.metadata),
    startedAt: new Date(report.startedAt),
    endedAt: report.endedAt === undefined ? undefined : new Date(report.endedAt),
    error: report.error === undefined ? undefined : cloneError(report.error),
  };
}

function cloneNodeMetadata(
  metadata: NodeMetadata | undefined,
): NodeMetadata | undefined {
  return metadata === undefined ? undefined : { ...metadata };
}

function cloneError(error: SerializedWorkflowError): SerializedWorkflowError {
  return {
    ...error,
    metadata: error.metadata === undefined ? undefined : { ...error.metadata },
    cause: error.cause === undefined ? undefined : { ...error.cause },
  };
}

function cloneOutputReport(output: OutputReport): OutputReport {
  return {
    ...output,
  };
}

function cloneTimerRecord(timer: TimerRecord): TimerRecord {
  return {
    ...timer,
    metadata: timer.metadata === undefined ? undefined : { ...timer.metadata },
  };
}
