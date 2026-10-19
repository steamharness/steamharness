import type {
  NodeContext,
  NodeDefinition,
  StreamNodeDefinition,
  NodeMetadata,
  NodeMetadataInput,
} from "../types/index";
import { createWorkflowNodeMetadata } from "../types/index";
import { HarnessError } from "../workflow/errors";
import { resolveLLMProvider } from "../provider/llm/resolver";
import type { LLMProvider, LLMProviderSource } from "../provider/llm/types";
import { readTokenUsageReportInput } from "../token-usage/index";

export type NodeExecutionStatus =
  | "idle"
  | "running"
  | "success"
  | "failed"
  | "cancelled";

export interface NodeExecutionLog {
  message: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface NodeExecutionErrorLog extends NodeExecutionLog {
  error?: {
    name?: string;
    message: string;
    stack?: string;
  };
}

export interface NodeExecutionInfo {
  name: string;
  status: NodeExecutionStatus;
  startedAt?: Date;
  endedAt?: Date;
  durationMs?: number;
  successLogs: NodeExecutionLog[];
  errorLogs: NodeExecutionErrorLog[];
}

export interface BaseNodeOptions {
  name: string;
  standardName?: string;
  historyLimit?: number;
  metadata?: NodeMetadataInput;
}

export abstract class NodeExecutionStore {
  readonly name: string;
  readonly standardName: string;
  readonly metadata: NodeMetadata;
  private readonly historyLimit: number;
  private currentExecution: NodeExecutionInfo;
  private readonly executionHistory: NodeExecutionInfo[] = [];

  constructor(options: BaseNodeOptions) {
    this.name = options.name;
    this.standardName = options.standardName ?? options.name;
    this.metadata = createWorkflowNodeMetadata(options.metadata, {
      type: this.standardName,
      title: this.name,
    });
    this.historyLimit = options.historyLimit ?? 50;
    this.currentExecution = createIdleExecution(this.standardName);
  }

  get status(): NodeExecutionStatus {
    return this.currentExecution.status;
  }

  get executionInfo(): NodeExecutionInfo {
    return cloneExecutionInfo(this.currentExecution);
  }

  getExecutionInfo(): NodeExecutionInfo {
    return this.executionInfo;
  }

  getExecutionHistory(): NodeExecutionInfo[] {
    return this.executionHistory.map(cloneExecutionInfo);
  }

  clearExecutionHistory(): void {
    this.executionHistory.length = 0;
  }

  protected beginExecution(): void {
    this.currentExecution = {
      name: this.standardName,
      status: "running",
      startedAt: new Date(),
      successLogs: [],
      errorLogs: [],
    };
  }

  protected completeExecution(
    message = `Node "${this.standardName}" executed successfully.`,
  ): void {
    this.finishExecution("success");
    this.logSuccess(message, {
      durationMs: this.currentExecution.durationMs,
    });
    this.rememberExecution();
  }

  protected failExecution(
    error: unknown,
    message = `Node "${this.standardName}" failed.`,
  ): void {
    this.finishExecution("failed");
    this.logError(message, error, {
      durationMs: this.currentExecution.durationMs,
    });
    this.rememberExecution();
  }

  protected cancelExecution(
    message = `Node "${this.standardName}" execution was cancelled.`,
  ): void {
    this.finishExecution("cancelled");
    this.logError(message, undefined, {
      durationMs: this.currentExecution.durationMs,
    });
    this.rememberExecution();
  }

  protected logSuccess(
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.currentExecution.successLogs.push({
      message,
      timestamp: new Date(),
      metadata,
    });
  }

  protected logError(
    message: string,
    error?: unknown,
    metadata?: Record<string, unknown>,
  ): void {
    this.currentExecution.errorLogs.push({
      message,
      timestamp: new Date(),
      metadata,
      error: error === undefined ? undefined : serializeError(error),
    });
  }

  private finishExecution(status: Exclude<NodeExecutionStatus, "idle" | "running">): void {
    const endedAt = new Date();
    const startedAt = this.currentExecution.startedAt;

    this.currentExecution = {
      ...this.currentExecution,
      status,
      endedAt,
      durationMs: startedAt === undefined ? undefined : endedAt.getTime() - startedAt.getTime(),
    };
  }

  private rememberExecution(): void {
    if (this.historyLimit <= 0) {
      return;
    }

    this.executionHistory.push(cloneExecutionInfo(this.currentExecution));

    if (this.executionHistory.length > this.historyLimit) {
      this.executionHistory.splice(
        0,
        this.executionHistory.length - this.historyLimit,
      );
    }
  }
}

export abstract class BaseNode<Input, Output>
  extends NodeExecutionStore
  implements NodeDefinition<Input, Output>
{
  async run(input: Input, context: NodeContext): Promise<Output> {
    this.beginExecution();

    try {
      const output = await this.execute(input, context);
      this.completeExecution();

      return output;
    } catch (error) {
      this.failExecution(error);
      throw error;
    }
  }

  protected abstract execute(
    input: Input,
    context: NodeContext,
  ): Promise<Output> | Output;
}

export abstract class BaseStreamNode<Input, Chunk, Output = void>
  extends NodeExecutionStore
  implements StreamNodeDefinition<Input, Chunk, Output>
{
  finalize?(
    chunks: Chunk[],
    context: NodeContext,
    input?: Input,
  ): Promise<Output> | Output;

  async *stream(input: Input, context: NodeContext): AsyncIterable<Chunk> {
    this.beginExecution();
    let completed = false;

    try {
      for await (const chunk of this.createStream(input, context)) {
        yield chunk;
      }

      completed = true;
      this.completeExecution();
    } catch (error) {
      this.failExecution(error);
      throw error;
    } finally {
      if (!completed && this.status === "running") {
        this.cancelExecution();
      }
    }
  }

  protected abstract createStream(
    input: Input,
    context: NodeContext,
  ): AsyncIterable<Chunk>;
}

function createIdleExecution(name: string): NodeExecutionInfo {
  return {
    name,
    status: "idle",
    successLogs: [],
    errorLogs: [],
  };
}

function cloneExecutionInfo(info: NodeExecutionInfo): NodeExecutionInfo {
  return {
    ...info,
    startedAt: cloneDate(info.startedAt),
    endedAt: cloneDate(info.endedAt),
    successLogs: info.successLogs.map(cloneLog),
    errorLogs: info.errorLogs.map(cloneErrorLog),
  };
}

function cloneLog(log: NodeExecutionLog): NodeExecutionLog {
  return {
    ...log,
    timestamp: new Date(log.timestamp),
    metadata: cloneMetadata(log.metadata),
  };
}

function cloneErrorLog(log: NodeExecutionErrorLog): NodeExecutionErrorLog {
  return {
    ...cloneLog(log),
    error: log.error === undefined ? undefined : { ...log.error },
  };
}

function cloneDate(date: Date | undefined): Date | undefined {
  return date === undefined ? undefined : new Date(date);
}

function cloneMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return metadata === undefined ? undefined : { ...metadata };
}

function serializeError(error: unknown): NodeExecutionErrorLog["error"] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const message = record.message;

    return {
      name: typeof record.name === "string" ? record.name : undefined,
      message: typeof message === "string" ? message : "Unknown object error.",
    };
  }

  return {
    message: String(error),
  };
}

export function getLLMProvider(
  context: NodeContext,
  nodeName: string,
  source?: LLMProviderSource,
) {
  try {
    return createTokenUsageReportingLLMProvider(
      resolveLLMProvider(source, context, nodeName),
      context,
      nodeName,
    );
  } catch (error) {
    if (error instanceof HarnessError) {
      throw error;
    }

    throw new HarnessError({
      type: "provider_call",
      message: `LLM provider is required for node "${nodeName}" but could not be resolved.`,
      nodeName,
      cause: error,
    });
  }
}

function createTokenUsageReportingLLMProvider(
  provider: LLMProvider,
  context: NodeContext,
  nodeName: string,
): LLMProvider {
  return {
    name: provider.name,
    async chat(input) {
      const output = await provider.chat(input);
      await reportLLMTokenUsage(context, nodeName, provider, output.usage);
      return output;
    },
    async *stream(input) {
      let reported = false;

      for await (const chunk of provider.stream(input)) {
        yield chunk;

        if (chunk.type === "finish" && !reported) {
          reported = await reportLLMTokenUsage(context, nodeName, provider, chunk.usage);
        }
      }
    },
  };
}

async function reportLLMTokenUsage(
  context: NodeContext,
  nodeName: string,
  provider: LLMProvider,
  usageValue: unknown,
): Promise<boolean> {
  const usage = readTokenUsageReportInput(usageValue, {
    nodeName,
    providerName: provider.name,
  });
  if (usage === undefined) {
    return false;
  }

  await context.tokenUsage.report(usage);
  return true;
}
