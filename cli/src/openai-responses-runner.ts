import { readFileSync } from "node:fs";
import {
  inspectLocalWorkflowStructure,
  isOutputItemStreamChunk,
  runLocalWorkflowWithReport,
  type NodeExecutionHooks,
  type ExecutionReport,
} from "steamharness";
import {
  isOpenAIConversationHostInput,
  type OpenAIInternalRunnerFrame,
  type OpenAIInternalRunnerRequest,
  type OpenAIResponseUsage,
} from "@steamharness/openai-responses";
import {
  isolateOpenAIRunnerStdout,
  type OpenAIProtocolLineWriter,
} from "./openai-runner-stdio";

interface RunnerDependencies {
  readInput?: () => string;
  writeFrame?: (frame: OpenAIInternalRunnerFrame) => void;
  inspectProject?: typeof inspectLocalWorkflowStructure;
  runWorkflow?: typeof runLocalWorkflowWithReport;
  abortSignal?: AbortSignal;
}

interface RunnerMainOptions {
  writeProtocolLine?: OpenAIProtocolLineWriter;
}

export async function main(options: RunnerMainOptions = {}): Promise<number> {
  const writeProtocolLine = options.writeProtocolLine ?? isolateOpenAIRunnerStdout();
  redirectConsoleToStderr();
  const controller = createProcessAbortController();
  return runOpenAIResponsesRunner({
    abortSignal: controller.signal,
    writeFrame: (frame) => writeProtocolLine(`${JSON.stringify(frame)}\n`),
  });
}

export async function runOpenAIResponsesRunner(
  dependencies: RunnerDependencies = {},
): Promise<number> {
  // Provider compatibility warnings are returned in the protocol metadata;
  // keep the runner's stderr reserved for actual diagnostics even when this
  // exported function is embedded without going through main().
  disableAiSdkWarningLogs();
  const writeFrame = dependencies.writeFrame ?? writeRunnerFrame;
  let request: OpenAIInternalRunnerRequest | undefined;
  let executionReport: ExecutionReport | undefined;

  try {
    request = parseOpenAIInternalRunnerRequest(
      (dependencies.readInput ?? (() => readFileSync(0, "utf8")))(),
    );
    const inspectProject = dependencies.inspectProject ?? inspectLocalWorkflowStructure;
    const structure = inspectProject({ workflowDir: request.projectPath });
    const conversation = structure.conversation as typeof structure.conversation & {
      openai?: { enabled?: boolean; outputItemId?: string };
    };
    if (
      structure.projectType !== "conversation"
      || conversation?.openai?.enabled !== true
      || typeof conversation.openai.outputItemId !== "string"
    ) {
      throw new Error("The project does not expose an OpenAI Responses adapter.");
    }

    const outputItemId = conversation.openai.outputItemId;
    writeFrame({ type: "ready", executionId: request.executionId });

    const runWorkflow = dependencies.runWorkflow ?? runLocalWorkflowWithReport;
    executionReport = await (runWorkflow as unknown as (options: {
      workflowDir: string;
      runId: string;
      hostInput: unknown;
      abortSignal?: AbortSignal;
      nodeHooks: NodeExecutionHooks;
    }) => Promise<ExecutionReport>)({
      workflowDir: request.projectPath,
      runId: request.executionId,
      hostInput: request.hostInput,
      abortSignal: dependencies.abortSignal,
      nodeHooks: createRunnerNodeHooks(request.executionId, outputItemId, writeFrame),
    });
    const report = executionReport;

    if (dependencies.abortSignal?.aborted) {
      writeFrame({ type: "cancelled", executionId: request.executionId, report });
      return 130;
    }
    if (report.status !== "success") {
      writeFrame({
        type: "failed",
        executionId: request.executionId,
        error: { message: readReportError(report) },
        report,
      });
      return 1;
    }

    const item = findOutputItem(report, outputItemId);
    if (item === undefined || typeof item.content !== "string") {
      throw new Error(`OpenAI adapter output item "${outputItemId}" was not produced.`);
    }
    const metadata = isRecord(item.metadata) ? item.metadata : {};
    writeFrame({
      type: "completed",
      executionId: request.executionId,
      outputText: item.content,
      outputItemId,
      usage: createOpenAIUsage(report),
      report,
      ...(typeof metadata.finishReason === "string" ? { finishReason: metadata.finishReason } : {}),
      ...(metadata.providerMetadata === undefined ? {} : { providerMetadata: metadata.providerMetadata }),
    });
    return 0;
  } catch (error) {
    const executionId = request?.executionId ?? "unknown";
    if (dependencies.abortSignal?.aborted) {
      writeFrame({
        type: "cancelled",
        executionId,
        ...(executionReport === undefined ? {} : { report: executionReport }),
      });
      return 130;
    }
    writeFrame({
      type: "failed",
      executionId,
      error: { message: error instanceof Error ? error.message : "OpenAI runner failed." },
      ...(executionReport === undefined ? {} : { report: executionReport }),
    });
    return 1;
  }
}

export function parseOpenAIInternalRunnerRequest(source: string): OpenAIInternalRunnerRequest {
  const value = JSON.parse(source) as unknown;
  if (!isRecord(value)) throw new Error("Runner request must be a JSON object.");
  if (value.protocolVersion !== 1 || value.action !== "run") {
    throw new Error("Unsupported OpenAI runner protocol version or action.");
  }
  if (
    typeof value.executionId !== "string" || value.executionId.trim() === ""
    || typeof value.projectPath !== "string" || value.projectPath.trim() === ""
    || !isOpenAIConversationHostInput(value.hostInput)
  ) {
    throw new Error("OpenAI runner request is invalid.");
  }
  return value as unknown as OpenAIInternalRunnerRequest;
}

function createRunnerNodeHooks(
  executionId: string,
  outputItemId: string,
  writeFrame: (frame: OpenAIInternalRunnerFrame) => void,
): NodeExecutionHooks {
  return {
    onNodeChunk(event) {
      if (!isOutputItemStreamChunk(event.chunk)) return;
      if (event.chunk.type !== "output_item_delta" || event.chunk.itemId !== outputItemId) return;
      if (typeof event.chunk.delta !== "string" || event.chunk.delta === "") return;
      writeFrame({ type: "text-delta", executionId, delta: event.chunk.delta });
    },
  };
}

function createOpenAIUsage(report: ExecutionReport): OpenAIResponseUsage {
  const usage = report.tokenUsage?.run;
  return {
    input_tokens: usage?.inputTokens ?? 0,
    input_tokens_details: { cached_tokens: usage?.cachedInputTokens ?? 0 },
    output_tokens: usage?.outputTokens ?? 0,
    output_tokens_details: { reasoning_tokens: usage?.reasoningTokens ?? 0 },
    total_tokens: usage?.totalTokens ?? 0,
  };
}

function findOutputItem(
  report: ExecutionReport,
  outputItemId: string,
): { content?: unknown; metadata?: unknown } | undefined {
  for (const output of report.outputs) {
    const item = output.output.items.find((candidate) => candidate.id === outputItemId);
    if (item !== undefined) return item;
  }
  return undefined;
}

function readReportError(report: ExecutionReport): string {
  if (!report.result.ok) {
    return readDeepestErrorMessage(report.result.error) ?? report.result.error.message;
  }
  const nodeError = report.nodes.find((node) => node.error !== undefined)?.error;
  if (nodeError !== undefined) return readDeepestErrorMessage(nodeError) ?? nodeError.message;
  return `Workflow execution ended with status ${report.status}.`;
}

function readDeepestErrorMessage(value: unknown): string | undefined {
  let current = value;
  let message: string | undefined;
  const seen = new Set<object>();
  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);
    const candidate = typeof current.message === "string" ? current.message.trim() : "";
    if (candidate !== "") message = candidate;
    current = current.cause;
  }
  return message;
}

function writeRunnerFrame(frame: OpenAIInternalRunnerFrame): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function createProcessAbortController(): AbortController {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new Error("OpenAI runner was cancelled."));
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  return controller;
}

function redirectConsoleToStderr(): void {
  const write = (...values: unknown[]) => {
    process.stderr.write(`${values.map(formatDiagnosticValue).join(" ")}\n`);
  };
  console.log = write;
  console.info = write;
  console.debug = write;
  console.warn = write;
}

function disableAiSdkWarningLogs(): void {
  (globalThis as typeof globalThis & {
    AI_SDK_LOG_WARNINGS?: false;
  }).AI_SDK_LOG_WARNINGS = false;
}

function formatDiagnosticValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
