import type {
  NodeExecutionHookChunkEvent,
  NodeExecutionHookFinishEvent,
  NodeExecutionHookStartEvent,
  NodeExecutionKind,
  NodeContext,
  NodeDefinition,
  StreamNodeDefinition,
  RunContext,
  Definition,
  NodeMetadata,
} from "../types/index";
import type { ConversationContext, ConversationState } from "../conversation/index";
import type { KVContext, KVNamespace } from "../kv/index";
import {
  createWorkflowFailure,
  toWorkflowError,
  HarnessError,
  type RunResult,
} from "./errors";

interface NodeExecutionRuntime {
  executionId: string;
  nodeName: string;
  kind: NodeExecutionKind;
  metadata?: NodeMetadata;
  startedAt: Date;
}

interface NodeExecutionInfoProvider {
  getExecutionInfo(): unknown;
}

interface StandardNodeNameProvider {
  standardName?: string;
}

interface NodeMetadataProvider {
  metadata?: NodeMetadata;
}

let nodeExecutionId = 0;

export function defineWorkflow<Input, Output>(
  workflow: Definition<Input, Output>,
): Definition<Input, Output> {
  return workflow;
}

export interface RunIfBranch<Input, Output> {
  label: string;
  description?: string;
  condition(input: Input, context: RunContext): Promise<boolean> | boolean;
  run(input: Input, context: RunContext): Promise<Output> | Output;
}

export interface RunIfElseBranch<Input, Output> {
  label?: string;
  description?: string;
  run(input: Input, context: RunContext): Promise<Output> | Output;
}

export interface RunIfOptions<Input, Output> {
  name?: string;
  branches: Array<RunIfBranch<Input, Output>>;
  else?: RunIfElseBranch<Input, Output>;
  metadata?: Partial<NodeMetadata>;
}

export interface RunForOptions<State, Item> {
  name?: string;
  items(input: State, context: RunContext): Iterable<Item> | AsyncIterable<Item> | Promise<Iterable<Item> | AsyncIterable<Item>>;
  run(input: State, item: Item, index: number, context: RunContext): Promise<State> | State;
  maxIterations?: number;
  metadata?: Partial<NodeMetadata>;
}

export interface RunWhileOptions<State> {
  name?: string;
  condition(input: State, context: RunContext, iteration: number): Promise<boolean> | boolean;
  run(input: State, context: RunContext, iteration: number): Promise<State> | State;
  maxIterations?: number;
  metadata?: Partial<NodeMetadata>;
}

export type RunWorkflowConversationMode = "shared" | "shared-readonly";
export type RunWorkflowKVMode = "shared" | "isolated";

export interface RunWorkflowOptions<Output = unknown> {
  name?: string;
  metadata?: Partial<NodeMetadata>;
  conversationMode?: RunWorkflowConversationMode;
  kvMode?: RunWorkflowKVMode;
  outputVisibility?: "visible" | "hidden";
  emitNode?: boolean;
  maxDepth?: number;
  onOutputChunk?(
    chunk: unknown,
    event: NodeExecutionHookChunkEvent,
  ): Promise<void> | void;
  onOutput?(
    output: Output,
    event?: NodeExecutionHookFinishEvent,
  ): Promise<void> | void;
}

const DEFAULT_RUN_FOR_MAX_ITERATIONS = 1000;
const DEFAULT_RUN_WHILE_MAX_ITERATIONS = 100;
const DEFAULT_RUN_STEAMHARNESS_MAX_DEPTH = 16;
const RUN_STEAMHARNESS_DEPTH_METADATA_KEY = "__steamHarnessRunWorkflowDepth";
const RUN_STEAMHARNESS_OUTPUT_BRIDGE_ERROR = Symbol("runWorkflowOutputBridgeError");

// Make workflow branches first-class runtime nodes so App Trace and Diagram
// can show selected if / else-if / else paths instead of hiding them in plain TS control flow.
export async function runIf<Input, Output>(
  input: Input,
  context: RunContext,
  options: RunIfOptions<Input, Output>,
): Promise<Output> {
  const nodeName = "run-if";
  const displayName = options.name?.trim() || "Run if";
  const metadata = createBranchMetadata(displayName, options.metadata);
  throwIfContextAborted(context, displayName);
  const execution = await beginBranchExecution(context, nodeName, metadata);

  try {
    let selectedBranch: RunIfBranch<Input, Output> | RunIfElseBranch<Input, Output> | undefined;
    let selectedIndex = -1;

    for (const [index, branch] of options.branches.entries()) {
      throwIfContextAborted(context, displayName);
      if (await branch.condition(input, context)) {
        selectedBranch = branch;
        selectedIndex = index;
        break;
      }
    }

    if (selectedBranch === undefined) {
      selectedBranch = options.else;
      selectedIndex = -1;
    }

    if (selectedBranch === undefined) {
      throw new HarnessError({
        type: "node_execution",
        message: `Run-if node "${displayName}" did not match any branch.`,
        nodeName: displayName,
      });
    }

    const selectedBranchInfo = createSelectedBranchInfo(selectedBranch, selectedIndex);
    const output = await selectedBranch.run(input, context);
    await finishNodeExecution(context, execution, "success", createBranchInfoNode(metadata), {
      input,
      output: selectedBranchInfo,
      executionInfo: selectedBranchInfo,
    });

    return output;
  } catch (error) {
    const workflowError = toWorkflowError(error, {
      type: "node_execution",
      message: `Run-if node "${displayName}" failed.`,
      nodeName: displayName,
    });

    await finishNodeExecution(context, execution, "failed", createBranchInfoNode(metadata), {
      input,
      error: workflowError,
      executionInfo: {
        selectedBranch: undefined,
      },
    });

    throw workflowError;
  }
}

// Loop nodes are first-class runtime nodes so App Diagram can wrap
// repeated body work in a visible loop container instead of hiding it in plain TS loops.
export async function runFor<State, Item>(
  input: State,
  context: RunContext,
  options: RunForOptions<State, Item>,
): Promise<State> {
  const nodeName = "run-for";
  const displayName = options.name?.trim() || "Run for";
  const metadata = createControlFlowMetadata("run-for", displayName, options.metadata);
  const maxIterations = normalizeMaxIterations(options.maxIterations, DEFAULT_RUN_FOR_MAX_ITERATIONS);
  throwIfContextAborted(context, displayName);
  const execution = await beginBranchExecution(context, nodeName, metadata);

  let iteration = 0;
  let current = input;

  try {
    const items = await options.items(input, context);

    for await (const item of toAsyncIterable(items)) {
      throwIfContextAborted(context, displayName);
      if (iteration >= maxIterations) {
        throw new HarnessError({
          type: "node_execution",
          message: `Run-for node "${displayName}" exceeded maxIterations (${maxIterations}).`,
          nodeName: displayName,
        });
      }

      current = await options.run(current, item, iteration, context);
      iteration += 1;
    }

    const executionInfo = createLoopExecutionInfo({
      loopType: "for",
      iterations: iteration,
      maxIterations,
      completed: true,
    });

    await finishNodeExecution(context, execution, "success", createControlFlowInfoNode("run-for", metadata), {
      input,
      output: current,
      executionInfo,
    });

    return current;
  } catch (error) {
    const workflowError = toWorkflowError(error, {
      type: "node_execution",
      message: `Run-for node "${displayName}" failed.`,
      nodeName: displayName,
    });

    await finishNodeExecution(context, execution, "failed", createControlFlowInfoNode("run-for", metadata), {
      input,
      output: current,
      error: workflowError,
      executionInfo: createLoopExecutionInfo({
        loopType: "for",
        iterations: iteration,
        maxIterations,
        completed: false,
      }),
    });

    throw workflowError;
  }
}

export async function runWhile<State>(
  input: State,
  context: RunContext,
  options: RunWhileOptions<State>,
): Promise<State> {
  const nodeName = "run-while";
  const displayName = options.name?.trim() || "Run while";
  const metadata = createControlFlowMetadata("run-while", displayName, options.metadata);
  const maxIterations = normalizeMaxIterations(options.maxIterations, DEFAULT_RUN_WHILE_MAX_ITERATIONS);
  throwIfContextAborted(context, displayName);
  const execution = await beginBranchExecution(context, nodeName, metadata);

  let iteration = 0;
  let current = input;

  try {
    while (await options.condition(current, context, iteration)) {
      throwIfContextAborted(context, displayName);
      if (iteration >= maxIterations) {
        throw new HarnessError({
          type: "node_execution",
          message: `Run-while node "${displayName}" exceeded maxIterations (${maxIterations}).`,
          nodeName: displayName,
        });
      }

      current = await options.run(current, context, iteration);
      iteration += 1;
    }

    const executionInfo = createLoopExecutionInfo({
      loopType: "while",
      iterations: iteration,
      maxIterations,
      completed: true,
    });

    await finishNodeExecution(context, execution, "success", createControlFlowInfoNode("run-while", metadata), {
      input,
      output: current,
      executionInfo,
    });

    return current;
  } catch (error) {
    const workflowError = toWorkflowError(error, {
      type: "node_execution",
      message: `Run-while node "${displayName}" failed.`,
      nodeName: displayName,
    });

    await finishNodeExecution(context, execution, "failed", createControlFlowInfoNode("run-while", metadata), {
      input,
      output: current,
      error: workflowError,
      executionInfo: createLoopExecutionInfo({
        loopType: "while",
        iterations: iteration,
        maxIterations,
        completed: false,
      }),
    });

    throw workflowError;
  }
}

function createSelectedBranchInfo<Input, Output>(
  branch: RunIfBranch<Input, Output> | RunIfElseBranch<Input, Output>,
  index: number,
): {
  branch: string;
  branchIndex: number;
  selectedBranch: string;
  selectedBranchIndex: number;
  description?: string;
} {
  const label = branch.label ?? "else";

  return {
    branch: label,
    branchIndex: index,
    selectedBranch: label,
    selectedBranchIndex: index,
    description: branch.description,
  };
}

export async function runWorkflow<Input, Output>(
  workflow: Definition<Input, Output>,
  input: Input,
  context: RunContext,
  options?: RunWorkflowOptions<Output>,
): Promise<Output> {
  const conversationMode = resolveRunWorkflowConversationMode(options);
  const kvMode = resolveRunWorkflowKVMode(options);
  const outputVisibility = resolveRunWorkflowOutputVisibility(options);
  const outputBridge = createRunWorkflowOutputBridge(options);
  const maxDepth = normalizeMaxIterations(options?.maxDepth, DEFAULT_RUN_STEAMHARNESS_MAX_DEPTH);
  const depth = readRunWorkflowDepth(context);
  if (depth >= maxDepth) {
    throw new HarnessError({
      type: "execution",
      message: `runWorkflow exceeded maxDepth (${maxDepth}) while calling "${workflow.name}".`,
      metadata: {
        workflow: workflow.name,
        maxDepth,
        depth,
      },
    });
  }
  const childContext = createRunWorkflowContext(context, {
    workflow,
    conversationMode,
    kvMode,
    outputVisibility,
    outputBridge,
    depth: depth + 1,
  });
  const displayName = options?.name?.trim() || workflow.name;
  const emitNode = options?.emitNode !== false;
  const execution = emitNode
    ? await beginBranchExecution(context, "run-workflow", createWorkflowCallMetadata(displayName, options?.metadata))
    : undefined;

  try {
    throwIfContextAborted(context, workflow.name);
    const output = await workflow.run(input, childContext);
    await outputBridge?.emitReturnedOutputIfNeeded(output);
    outputBridge?.throwIfFailed();
    if (execution !== undefined) {
      await finishNodeExecution(context, execution, "success", createWorkflowCallInfoNode(execution.metadata), {
        input,
        output,
        executionInfo: createWorkflowCallExecutionInfo({
          workflow,
          conversationMode,
          kvMode,
          outputVisibility,
          outputBridge,
        }),
      });
    }
    return output;
  } catch (error) {
    const bridgeError = outputBridge?.readError();
    const cause = bridgeError === undefined ? error : createRunWorkflowCombinedError(error, bridgeError);
    const workflowError = toWorkflowError(error, {
      type: "execution",
      message: `Workflow "${workflow.name}" failed.`,
      cause,
      metadata: {
        workflow: workflow.name,
        ...(bridgeError === undefined ? {} : { outputBridgeFailed: true }),
      },
    });

    if (execution !== undefined) {
      await finishNodeExecution(context, execution, "failed", createWorkflowCallInfoNode(execution.metadata), {
        input,
        error: workflowError,
        executionInfo: createWorkflowCallExecutionInfo({
          workflow,
          conversationMode,
          kvMode,
          outputVisibility,
          outputBridge,
        }),
      });
    }

    throw workflowError;
  }
}

export async function safeRunWorkflow<Input, Output>(
  workflow: Definition<Input, Output>,
  input: Input,
  context: RunContext,
): Promise<RunResult<Output>> {
  try {
    return {
      ok: true,
      data: await workflow.run(input, context),
    };
  } catch (error) {
    return createWorkflowFailure(error);
  }
}

/**
 * The payload an entrypoint produced, unwrapped from the result it returned.
 *
 * A workflow built out of nodes returns the node's result — `{ errCode,
 * errMessage, output }`, where `output` is the payload its formatter built.
 * That is the right thing for in-process composition and the wrong thing for
 * anyone outside the project: a caller that asked another project to do
 * something wants the payload, not this package's envelope. A workflow that
 * returned something else is left alone.
 *
 * A failed entrypoint reaches the caller the same way a successful one does —
 * the envelope's `errCode` is what tells them apart, and the payload of a
 * failure is `null`. Unwrapping it silently would hand the caller a `null` it
 * cannot tell from a real empty answer, so a failure throws with the
 * entrypoint's own message instead.
 */
export function readEntrypointOutput(data: unknown): unknown {
  if (
    typeof data === "object"
    && data !== null
    && "output" in data
    && typeof (data as { errCode?: unknown }).errCode === "number"
  ) {
    const envelope = data as { errCode: number; errMessage?: unknown; output: unknown };
    if (envelope.errCode !== 0) {
      throw new HarnessError({
        type: "execution",
        message: typeof envelope.errMessage === "string" && envelope.errMessage.trim() !== ""
          ? envelope.errMessage
          : `The entrypoint failed with errCode ${envelope.errCode}.`,
        metadata: { errCode: envelope.errCode },
      });
    }
    return envelope.output;
  }
  return data;
}

export async function runNode<Input, Output>(
  node: NodeDefinition<Input, Output>,
  input: Input,
  context: NodeContext,
): Promise<Output> {
  const nodeName = readStandardNodeName(node);
  throwIfContextAborted(context, nodeName);
  const execution = await beginNodeExecution(context, node, nodeName, "node");

  try {
    throwIfContextAborted(context, nodeName);
    const output = await node.run(input, context);

    await finishNodeExecution(context, execution, "success", node, {
      input,
      output,
    });

    return output;
  } catch (error) {
    const workflowError = toWorkflowError(error, {
      type: "node_execution",
      message: `Node "${nodeName}" failed.`,
      nodeName,
    });

    if (workflowError.type === "user_input_required") {
      // A user-input pause is resumable; keep the node running in the
      // report so Diagram can show a waiting state instead of a failed route.
      throw workflowError;
    }

    if (workflowError.type === "execution_aborted") {
      // The user-input node throws execution_aborted when the
      // host cancels a paused run ("结束运行"). Propagate the abort
      // unchanged so the executor's createAbortedWorkflowResult handler
      // surfaces the run as status="aborted" instead of a failed node.
      throw workflowError;
    }

    await finishNodeExecution(context, execution, "failed", node, {
      input,
      error: workflowError,
    });

    throw workflowError;
  }
}

export async function runStreamNode<Input, Chunk, Output>(
  node: StreamNodeDefinition<Input, Chunk, Output>,
  input: Input,
  context: NodeContext,
): Promise<{
  chunks: Chunk[];
  output: Output | undefined;
}> {
  const nodeName = readStandardNodeName(node);
  throwIfContextAborted(context, nodeName);
  const execution = await beginNodeExecution(context, node, nodeName, "stream-node");

  try {
    const chunks: Chunk[] = [];
    let chunkOrder = 0;

    for await (const chunk of node.stream(input, context)) {
      throwIfContextAborted(context, nodeName);
      chunks.push(chunk);
      chunkOrder += 1;
      await notifyNodeChunk(context, {
        ...execution,
        chunk,
        chunkOrder,
        timestamp: new Date(),
      });
    }

    const result = {
      chunks,
      output: node.finalize ? await node.finalize(chunks, context, input) : undefined,
    };

    await finishNodeExecution(context, execution, "success", node, {
      input,
      output: result.output,
    });

    return result;
  } catch (error) {
    const workflowError = toWorkflowError(error, {
      type: "stream_interrupted",
      message: `Stream node "${nodeName}" failed.`,
      nodeName,
    });

    if (workflowError.type === "user_input_required") {
      // Tool approval can pause from inside streaming agent nodes.
      // Keep the stream node in its running/waiting state, matching runNode().
      throw workflowError;
    }

    if (workflowError.type === "execution_aborted") {
      throw workflowError;
    }

    await finishNodeExecution(context, execution, "failed", node, {
      input,
      error: workflowError,
    });

    throw workflowError;
  }
}

export * from "./errors";

async function beginNodeExecution(
  context: NodeContext,
  node: unknown,
  nodeName: string,
  kind: NodeExecutionKind,
): Promise<NodeExecutionRuntime> {
  const execution: NodeExecutionRuntime = {
    executionId: createNodeExecutionId(nodeName),
    nodeName,
    kind,
    metadata: readNodeMetadata(node),
    startedAt: new Date(),
  };

  await notifyNodeStart(context, execution);

  return execution;
}

async function beginBranchExecution(
  context: NodeContext,
  nodeName: string,
  metadata: NodeMetadata,
): Promise<NodeExecutionRuntime> {
  const execution: NodeExecutionRuntime = {
    executionId: createNodeExecutionId(nodeName),
    nodeName,
    kind: "branch-node",
    metadata,
    startedAt: new Date(),
  };

  await notifyNodeStart(context, execution);

  return execution;
}

function throwIfContextAborted(context: NodeContext, name: string): void {
  const signal = context.abortSignal;

  if (signal === undefined || !signal.aborted) {
    return;
  }

  throw new HarnessError({
    type: "execution_aborted",
    message: signal.reason instanceof Error
      ? signal.reason.message
      : `Execution aborted before "${name}" could continue.`,
    nodeName: name,
    cause: signal.reason,
  });
}

async function finishNodeExecution(
  context: NodeContext,
  execution: NodeExecutionRuntime,
  status: NodeExecutionHookFinishEvent["status"],
  node: unknown,
  details: {
    input?: unknown;
    output?: unknown;
    error?: unknown;
    executionInfo?: unknown;
  } = {},
): Promise<void> {
  const endedAt = new Date();
  const event: NodeExecutionHookFinishEvent = {
    ...execution,
    status,
    endedAt,
    durationMs: endedAt.getTime() - execution.startedAt.getTime(),
    input: details.input,
    output: details.output,
    error: details.error,
    executionInfo: details.executionInfo ?? readNodeExecutionInfo(node),
  };

  if (status === "success") {
    await safeCallNodeHook(context.nodeHooks?.onNodeSuccess, event);
  } else {
    await safeCallNodeHook(context.nodeHooks?.onNodeError, event);
  }

  await safeCallNodeHook(context.nodeHooks?.onNodeFinish, event);
}

function createBranchInfoNode(
  metadata: NodeMetadata,
): NodeExecutionInfoProvider & StandardNodeNameProvider & NodeMetadataProvider {
  return createControlFlowInfoNode("run-if", metadata);
}

function createControlFlowInfoNode(
  standardName: "run-if" | "run-for" | "run-while" | "run-workflow",
  metadata: NodeMetadata,
): NodeExecutionInfoProvider & StandardNodeNameProvider & NodeMetadataProvider {
  return {
    standardName,
    metadata,
    getExecutionInfo() {
      return undefined;
    },
  };
}

function createBranchMetadata(
  title: string,
  metadata: Partial<NodeMetadata> | undefined,
): NodeMetadata {
  return createControlFlowMetadata("run-if", title, metadata);
}

function createControlFlowMetadata(
  type: "run-if" | "run-for" | "run-while",
  title: string,
  metadata: Partial<NodeMetadata> | undefined,
): NodeMetadata {
  return {
    type: metadata?.type ?? type,
    title: metadata?.title ?? title,
    version: metadata?.version ?? "1.0.0",
  };
}

function resolveRunWorkflowConversationMode(
  options: RunWorkflowOptions | undefined,
): RunWorkflowConversationMode {
  return options?.conversationMode ?? "shared";
}

function resolveRunWorkflowKVMode(
  options: RunWorkflowOptions | undefined,
): RunWorkflowKVMode {
  return options?.kvMode ?? "shared";
}

function createRunWorkflowContext<Input, Output>(
  context: RunContext,
  options: {
    workflow: Definition<Input, Output>;
    conversationMode: RunWorkflowConversationMode;
    kvMode: RunWorkflowKVMode;
    outputVisibility: "visible" | "hidden";
    outputBridge?: RunWorkflowOutputBridge;
    depth: number;
  },
): RunContext {
  if (
    options.conversationMode !== "shared-readonly" &&
    options.kvMode !== "isolated" &&
    options.outputVisibility !== "hidden" &&
    options.outputBridge === undefined &&
    options.depth === readRunWorkflowDepth(context)
  ) {
    return context;
  }

  const nextContext: RunContext = {
    ...context,
    storage: options.kvMode === "isolated"
      ? {
          local: {
            ...context.storage.local,
            kv: createRunWorkflowIsolatedKVContext(
              context.storage.local.kv,
              options.workflow.name,
            ),
          },
          server: {
            ...context.storage.server,
            kv: createRunWorkflowIsolatedKVContext(
              context.storage.server.kv,
              options.workflow.name,
            ),
          },
        }
      : context.storage,
    conversation: options.conversationMode === "shared-readonly"
      ? createReadonlyConversationContext(context.conversation)
      : context.conversation,
    metadata: {
      ...context.metadata,
      [RUN_STEAMHARNESS_DEPTH_METADATA_KEY]: options.depth,
    },
    nodeHooks: createRunWorkflowNodeHooks(context.nodeHooks, {
      outputVisibility: options.outputVisibility,
      outputBridge: options.outputBridge,
    }),
  };
  return nextContext;
}

function createReadonlyConversationContext(
  conversation: ConversationContext,
): ConversationContext {
  return {
    enabled: conversation.enabled,
    conversationId: conversation.conversationId,
    getValue: () => conversation.getValue(),
    async setValue() {
      return conversation.enabled ? conversation.getValue() : createReadonlyDisabledConversationState(conversation);
    },
    async setTitle() {
      return conversation.enabled ? conversation.getValue() : undefined;
    },
    async appendMessage() {
      return conversation.enabled ? conversation.getValue() : createReadonlyDisabledConversationState(conversation);
    },
  };
}

function createReadonlyDisabledConversationState(
  conversation: ConversationContext,
): ConversationState {
  const now = new Date().toISOString();

  return {
    conversationId: conversation.conversationId ?? "disabled",
    projectName: "disabled",
    createdAt: now,
    updatedAt: now,
    messages: [],
    values: {},
  };
}

function createRunWorkflowIsolatedKVContext(
  kv: KVContext,
  childProjectName: string,
): KVContext {
  const workflowPrefix = `runWorkflow:${childProjectName}`;
  const conversationPrefix = `${workflowPrefix}:conversation`;
  const project = createPrefixedKVNamespace(kv, workflowPrefix);

  return {
    getValue: project.getValue,
    setValue: project.setValue,
    deleteValue: project.deleteValue,
    updateValue: project.updateValue,
    conversation: createPrefixedKVNamespace(kv.conversation, conversationPrefix),
  };
}

function createPrefixedKVNamespace(
  namespace: KVNamespace,
  prefix: string,
): KVNamespace {
  const prefixedKey = (key: string) => `${prefix}:${key}`;

  return {
    getValue(key) {
      return namespace.getValue(prefixedKey(key));
    },
    setValue(key, value) {
      return namespace.setValue(prefixedKey(key), value);
    },
    deleteValue(key) {
      return namespace.deleteValue(prefixedKey(key));
    },
    updateValue(key, updater) {
      return namespace.updateValue(prefixedKey(key), updater);
    },
  };
}

function readRunWorkflowDepth(context: RunContext): number {
  const value = context.metadata?.[RUN_STEAMHARNESS_DEPTH_METADATA_KEY];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function createRunWorkflowCombinedError(error: unknown, bridgeError: unknown): Error {
  const combined = new Error(
    `Workflow failed after output bridge handler failed: ${readErrorMessage(bridgeError)}; workflow error: ${readErrorMessage(error)}`,
  );
  combined.name = "RunWorkflowOutputBridgeError";
  (combined as { cause?: unknown }).cause = {
    workflowError: error,
    outputBridgeError: bridgeError,
  };
  return combined;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createWorkflowCallMetadata(
  title: string,
  metadata: Partial<NodeMetadata> | undefined,
): NodeMetadata {
  return {
    type: metadata?.type ?? "workflow",
    title: metadata?.title ?? title,
    version: metadata?.version ?? "1.0.0",
  };
}

function createWorkflowCallInfoNode(
  metadata: NodeMetadata | undefined,
): NodeExecutionInfoProvider & StandardNodeNameProvider & NodeMetadataProvider {
  return createControlFlowInfoNode("run-workflow", metadata ?? createWorkflowCallMetadata("Run workflow", undefined));
}

function createWorkflowCallExecutionInfo<Input, Output>(options: {
  workflow: Definition<Input, Output>;
  conversationMode: RunWorkflowConversationMode;
  kvMode: RunWorkflowKVMode;
  outputVisibility: "visible" | "hidden";
  outputBridge?: RunWorkflowOutputBridge;
}): {
  projectName: string;
  conversationMode: RunWorkflowConversationMode;
  kvMode: RunWorkflowKVMode;
  outputVisibility: "visible" | "hidden";
  outputBridge: boolean;
} {
  return {
    projectName: options.workflow.name,
    conversationMode: options.conversationMode,
    kvMode: options.kvMode,
    outputVisibility: options.outputVisibility,
    outputBridge: options.outputBridge !== undefined,
  };
}

function resolveRunWorkflowOutputVisibility(
  options: RunWorkflowOptions<unknown> | undefined,
): "visible" | "hidden" {
  return options?.outputVisibility ?? "visible";
}

interface RunWorkflowOutputBridge {
  handleChunk(event: NodeExecutionHookChunkEvent): Promise<void>;
  handleFinish(event: NodeExecutionHookFinishEvent): Promise<void>;
  emitReturnedOutputIfNeeded(output: unknown): Promise<void>;
  throwIfFailed(): void;
  readError(): unknown | undefined;
}

function createRunWorkflowOutputBridge<Output>(
  options: RunWorkflowOptions<Output> | undefined,
): RunWorkflowOutputBridge | undefined {
  if (options?.onOutputChunk === undefined && options?.onOutput === undefined) {
    return undefined;
  }

  const streamedOutputExecutions = new Set<string>();
  let sawOutputNode = false;
  let handlerError: unknown;

  async function callHandler(handler: () => Promise<void> | void): Promise<void> {
    if (handlerError !== undefined) {
      return;
    }

    try {
      await handler();
    } catch (error) {
      handlerError = error;
      throw createRunWorkflowOutputBridgeHookError(error);
    }
  }

  return {
    async handleChunk(event) {
      if (event.nodeName !== "output") {
        return;
      }

      sawOutputNode = true;
      streamedOutputExecutions.add(event.executionId);
      await callHandler(() => options.onOutputChunk?.(event.chunk, event));
    },
    async handleFinish(event) {
      if (event.nodeName !== "output") {
        return;
      }

      sawOutputNode = true;
      if (
        event.status === "success" &&
        !streamedOutputExecutions.has(event.executionId) &&
        options.onOutput !== undefined
      ) {
        await callHandler(() => options.onOutput?.(event.output as Output, event));
      }
    },
    async emitReturnedOutputIfNeeded(output) {
      if (sawOutputNode || options.onOutput === undefined) {
        return;
      }

      await callHandler(() => options.onOutput?.(output as Output));
    },
    throwIfFailed() {
      if (handlerError !== undefined) {
        throw handlerError;
      }
    },
    readError() {
      return handlerError;
    },
  };
}

function createRunWorkflowNodeHooks(
  nodeHooks: RunContext["nodeHooks"],
  options: {
    outputVisibility: "visible" | "hidden";
    outputBridge?: RunWorkflowOutputBridge;
  },
): RunContext["nodeHooks"] {
  if (nodeHooks === undefined && options.outputBridge === undefined) {
    return undefined;
  }

  return {
    ...nodeHooks,
    onNodeSuccess(event) {
      return nodeHooks?.onNodeSuccess?.(hideOutputEventIfNeeded(event, options.outputVisibility));
    },
    async onNodeFinish(event) {
      await options.outputBridge?.handleFinish(event);
      return nodeHooks?.onNodeFinish?.(hideOutputEventIfNeeded(event, options.outputVisibility));
    },
    onNodeError(event) {
      return nodeHooks?.onNodeError?.(hideOutputEventIfNeeded(event, options.outputVisibility));
    },
    onNodeStart: nodeHooks?.onNodeStart,
    async onNodeChunk(event) {
      await options.outputBridge?.handleChunk(event);
      if (event.nodeName === "output" && options.outputVisibility === "hidden") {
        return undefined;
      }
      return nodeHooks?.onNodeChunk?.(event);
    },
  };
}

function hideOutputEventIfNeeded<Event extends NodeExecutionHookFinishEvent>(
  event: Event,
  outputVisibility: "visible" | "hidden",
): Event {
  if (outputVisibility !== "hidden" || event.nodeName !== "output") {
    return event;
  }

  return {
    ...event,
    outputVisibility: "hidden",
  };
}

function createRunWorkflowOutputBridgeHookError(error: unknown): Error {
  const bridgeError = new Error(readErrorMessage(error));
  bridgeError.name = "RunWorkflowOutputBridgeHandlerError";
  (bridgeError as { cause?: unknown }).cause = error;
  (bridgeError as { [RUN_STEAMHARNESS_OUTPUT_BRIDGE_ERROR]?: true })[RUN_STEAMHARNESS_OUTPUT_BRIDGE_ERROR] = true;
  return bridgeError;
}

function isRunWorkflowOutputBridgeHookError(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
    error !== null &&
    (error as { [RUN_STEAMHARNESS_OUTPUT_BRIDGE_ERROR]?: true })[RUN_STEAMHARNESS_OUTPUT_BRIDGE_ERROR],
  );
}

function normalizeMaxIterations(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

async function* toAsyncIterable<Item>(
  value: Iterable<Item> | AsyncIterable<Item>,
): AsyncIterable<Item> {
  if (Symbol.asyncIterator in value) {
    yield* value;
    return;
  }

  yield* value;
}

function createLoopExecutionInfo(options: {
  loopType: "for" | "while";
  iterations: number;
  maxIterations: number;
  completed: boolean;
}): {
  loopType: "for" | "while";
  iterations: number;
  iterationCount: number;
  maxIterations: number;
  completed: boolean;
} {
  return {
    loopType: options.loopType,
    iterations: options.iterations,
    iterationCount: options.iterations,
    maxIterations: options.maxIterations,
    completed: options.completed,
  };
}

async function notifyNodeStart(
  context: NodeContext,
  event: NodeExecutionHookStartEvent,
): Promise<void> {
  await safeCallNodeHook(context.nodeHooks?.onNodeStart, event);
}

async function notifyNodeChunk(
  context: NodeContext,
  event: NodeExecutionHookChunkEvent,
): Promise<void> {
  await safeCallNodeHook(context.nodeHooks?.onNodeChunk, event);
}

async function safeCallNodeHook<Event>(
  hook: ((event: Event) => Promise<void> | void) | undefined,
  event: Event,
): Promise<void> {
  if (hook === undefined) {
    return;
  }

  try {
    await hook(event);
  } catch (error) {
    if (isRunWorkflowOutputBridgeHookError(error)) {
      throw error;
    }
    return;
  }
}

function readNodeExecutionInfo(node: unknown): unknown {
  if (!hasExecutionInfo(node)) {
    return undefined;
  }

  return node.getExecutionInfo();
}

function readNodeMetadata(node: unknown): NodeMetadata | undefined {
  if (!hasNodeMetadata(node)) {
    return undefined;
  }

  return node.metadata === undefined ? undefined : { ...node.metadata };
}

function readStandardNodeName(node: { name: string; standardName?: string }): string {
  if (hasStandardNodeName(node)) {
    return node.standardName;
  }

  return node.name;
}

function hasExecutionInfo(node: unknown): node is NodeExecutionInfoProvider {
  return (
    typeof node === "object" &&
    node !== null &&
    typeof (node as NodeExecutionInfoProvider).getExecutionInfo === "function"
  );
}

function hasStandardNodeName(
  node: unknown,
): node is Required<StandardNodeNameProvider> {
  return (
    typeof node === "object" &&
    node !== null &&
    typeof (node as StandardNodeNameProvider).standardName === "string"
  );
}

function hasNodeMetadata(node: unknown): node is NodeMetadataProvider {
  return (
    typeof node === "object" &&
    node !== null &&
    (node as NodeMetadataProvider).metadata !== undefined
  );
}

function createNodeExecutionId(nodeName: string): string {
  nodeExecutionId += 1;

  return `${Date.now()}-${nodeExecutionId}-${nodeName}`;
}
