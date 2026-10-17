import { BaseNode } from "../base";
import type {
  NodeContext,
  WorkflowNodeMetadataInput,
  WorkflowPayload,
  WorkflowUserInputRequest,
} from "../../types/index";
import type { WorkflowParamDefinition } from "../../executor/types";
import { assertWorkflowParamDefinitions, isWorkflowDateParamControl } from "../../executor/param-definition";
import { WorkflowError } from "../../workflow/errors";

export interface UserInputPayload extends WorkflowPayload {
  requestId: string;
  values: Record<string, unknown>;
  submittedAt: string;
}

export type UserInputFormatter<Input, Output extends WorkflowPayload> = (
  payload: UserInputPayload,
  input: Input,
  context: NodeContext,
) => Promise<Output> | Output;

export interface UserInputRequestDefinition {
  title?: string;
  description?: string;
  params: WorkflowParamDefinition[];
  defaultValues?: Record<string, unknown>;
}

export type UserInputRequestResolver<Input> = (
  input: Input,
  context: NodeContext,
) => Promise<UserInputRequestDefinition> | UserInputRequestDefinition;

export interface UserInputNodeOptions<Input, Output extends WorkflowPayload = UserInputPayload> {
  name?: string;
  title?: string;
  description?: string;
  params: WorkflowParamDefinition[];
  defaultValues?: Record<string, unknown>;
  resolveRequest?: UserInputRequestResolver<Input>;
  createRequestId?: (input: Input, context: NodeContext) => string;
  format?: UserInputFormatter<Input, Output>;
  historyLimit?: number;
  metadata?: WorkflowNodeMetadataInput;
}

export function createUserInputNode<
  Input = unknown,
  Output extends WorkflowPayload = UserInputPayload,
>(
  options: UserInputNodeOptions<Input, Output>,
): BaseNode<Input, Output> {
  return new UserInputNode(options);
}

class UserInputNode<Input, Output extends WorkflowPayload> extends BaseNode<Input, Output> {
  private readonly options: UserInputNodeOptions<Input, Output>;

  constructor(options: UserInputNodeOptions<Input, Output>) {
    const title = options.title?.trim() || options.name?.trim() || "User input";
    super({
      name: options.name ?? "user-input",
      standardName: "user-input",
      historyLimit: options.historyLimit,
      metadata: {
        type: "user-input",
        title,
        ...options.metadata,
      },
    });
    assertWorkflowParamDefinitions(options.params);
    this.options = options;
  }

  protected async execute(input: Input, context: NodeContext): Promise<Output> {
    const request = await this.createRequest(input, context);
    const resolved = await context.userInput?.getResolvedInput(request.requestId, request);

    if (resolved !== undefined) {
      const payload: UserInputPayload = {
        errCode: 0,
        errMessage: "",
        requestId: resolved.requestId,
        values: resolved.values,
        submittedAt: resolved.submittedAt.toISOString(),
      };

      return this.options.format === undefined
        ? payload as unknown as Output
        : this.options.format(payload, input, context);
    }

    if (context.userInput === undefined) {
      throw new WorkflowError({
        type: "user_input_required",
        message: `User input node "${request.nodeName}" requires a runtime userInput handler.`,
        nodeName: request.nodeName,
        metadata: { request },
      });
    }

    // If the local host already
    // aborted the run before we get a chance to pause, surface it as
    // execution_aborted instead of registering a new request and then
    // immediately throwing user_input_required — the run is being
    // cancelled, not paused for input. Cache the abort state in a local
    // so the post-await re-check is not narrowed away by TypeScript's
    // control-flow analysis (after this throw, aborted would otherwise
    // be read as false | undefined).
    const isAborted = context.abortSignal?.aborted === true;
    if (isAborted) {
      throw new WorkflowError({
        type: "execution_aborted",
        message: `User input node "${request.nodeName}" was cancelled before it could pause for input "${request.requestId}".`,
        nodeName: request.nodeName,
        metadata: { request, reason: "user_cancelled" },
      });
    }

    // User input nodes pause the workflow by publishing a durable
    // request instead of silently blocking inside business code.
    try {
      await context.userInput.requestInput(request);
    } catch (error) {
      // The wrapper throws user_input_required to pause the run.
      // If the abort signal fired (because the host's "结束运行" button
      // called abortController.abort()), surface execution_aborted
      // instead so the run ends with status="aborted" rather than
      // getting stuck in waiting_for_input forever.
      if (context.abortSignal?.aborted === true) {
        throw new WorkflowError({
          type: "execution_aborted",
          message: `User input node "${request.nodeName}" was cancelled while waiting for request "${request.requestId}".`,
          nodeName: request.nodeName,
          metadata: { request, reason: "user_cancelled" },
        });
      }
      throw error;
    }

    // Detect a cancellation that fired after the user input
    // context finished registering the request (fire-and-forget
    // requestInput resolves before the abort propagates). Same surface
    // as the catch path above so the executor's existing
    // createAbortedWorkflowResult handler picks it up.
    if (context.abortSignal?.aborted === true) {
      throw new WorkflowError({
        type: "execution_aborted",
        message: `User input node "${request.nodeName}" was cancelled after registering request "${request.requestId}".`,
        nodeName: request.nodeName,
        metadata: { request, reason: "user_cancelled" },
      });
    }

    throw new WorkflowError({
      type: "user_input_required",
      message: `User input node "${request.nodeName}" is waiting for request "${request.requestId}".`,
      nodeName: request.nodeName,
      metadata: { request },
    });
  }

  private async createRequest(input: Input, context: NodeContext): Promise<WorkflowUserInputRequest> {
    const nodeName = this.name;
    const definition = await this.options.resolveRequest?.(input, context);
    const requestId =
      this.options.createRequestId?.(input, context) ??
      createDefaultRequestId(context, nodeName);
    const params = definition?.params ?? this.options.params;
    assertWorkflowParamDefinitions(params);

    return {
      requestId,
      nodeName,
      title: definition?.title?.trim() || this.options.title?.trim() || nodeName,
      description: normalizeOptionalText(definition?.description ?? this.options.description),
      params: params.map(cloneParamDefinition),
      defaultValues: cloneDefaultValues(definition?.defaultValues ?? this.options.defaultValues),
      metadata: this.metadata,
      createdAt: new Date(),
    };
  }
}

function cloneParamDefinition(param: WorkflowParamDefinition): WorkflowParamDefinition {
  if (isWorkflowDateParamControl(param.control)) {
    return {
      ...param,
      ...(param.accept === undefined ? {} : { accept: [...param.accept] }),
    };
  }
  return {
    ...param,
    ...(param.options === undefined
      ? {}
      : { options: param.options.map((option) => ({ ...option })) }),
    ...(param.accept === undefined ? {} : { accept: [...param.accept] }),
  } as WorkflowParamDefinition;
}

function cloneDefaultValues(
  defaultValues: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return defaultValues === undefined ? undefined : { ...defaultValues };
}

function createDefaultRequestId(context: NodeContext, nodeName: string): string {
  const workflow = normalizeRequestIdPart(context.metadata?.["workflow"]) ?? "workflow";
  const runId = normalizeRequestIdPart(context.metadata?.["runId"]) ?? "run";
  const node = normalizeRequestIdPart(nodeName) ?? "user-input";
  return `${workflow}:${runId}:${node}`;
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
