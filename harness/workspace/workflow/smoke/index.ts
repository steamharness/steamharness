import type { SmokeInput, SmokeOutputPayload } from "./interface";

const SMOKE_OUTPUT_ITEM_ID = "smoke-output";

const inputNode = workflow.createInputNode<SmokeInput>();

const outputNode = workflow.createOutputNode<SmokeInput, SmokeOutputPayload>({
  name: "smoke-output",
  metadata: {
    type: "smoke-output",
    title: "Smoke Output",
    version: "1.0.0",
  },
  async *stream(input, context) {
    const state = context.conversation.enabled
      ? await context.conversation.getValue()
      : undefined;
    const previous = state?.messages.at(-1)?.content;

    // Use a stable item id for live chunks so App can replace the
    // running output with the final report instead of appending a duplicate.
    yield workflow.createOutputItemChunk({
      type: "output_item_start",
      item: {
        id: SMOKE_OUTPUT_ITEM_ID,
        title: "Output",
        content: "",
        contentType: "markdown",
        collapsed: false,
      },
    });
    for (const part of ["smoke", ":", input.message]) {
      if (context.abortSignal?.aborted) {
        throw new workflow.WorkflowError({
          type: "execution_aborted",
          message: "Smoke workflow was aborted.",
          nodeName: "smoke-output",
          cause: context.abortSignal.reason,
        });
      }
      yield workflow.createOutputItemChunk({
        type: "output_item_delta",
        itemId: SMOKE_OUTPUT_ITEM_ID,
        delta: part,
      });
    }
    yield workflow.createOutputItemChunk({
      type: "output_item_end",
      itemId: SMOKE_OUTPUT_ITEM_ID,
    });

    if (context.conversation.enabled) {
      await context.conversation.appendMessage({
        role: "user",
        content: input.message,
        metadata: { previous },
      });
      await context.storage.local.kv.conversation.setValue("smoke.lastMessage", input.message);
    }
  },
  async format(stream, input, context) {
    const state = context.conversation.enabled
      ? await context.conversation.getValue()
      : undefined;
    const kvLastMessage = context.conversation.enabled
      ? await context.storage.local.kv.conversation.getValue("smoke.lastMessage")
      : undefined;

    return {
      ...workflow.createOutputPayload({
        errCode: input.mode === "payload-fail" ? 409 : 0,
        errMessage: input.mode === "payload-fail" ? "Smoke payload failure." : "",
        items: stream.items,
      }),
      mode: input.mode,
      conversationId: state?.conversationId,
      conversationMessages: state?.messages.length ?? 0,
      previousMessage: state?.messages.at(-2)?.content,
      kvLastMessage: typeof kvLastMessage === "string" ? kvLastMessage : undefined,
    };
  },
});

export const smokeWorkflow = workflow.defineWorkflow<SmokeInput, SmokeOutputPayload>({
  name: "smoke",
  async run(input, context) {
    const parsed = await workflow.runNode(inputNode, input, context);

    if (parsed.mode === "fail") {
      throw new workflow.WorkflowError({
        type: "workflow_execution",
        message: "Smoke fixture failure.",
        metadata: { mode: parsed.mode },
      });
    }

    if (parsed.mode === "plain-error") {
      throw new Error("Smoke plain Error failure.");
    }

    if (parsed.mode === "wait") {
      await new Promise((resolve) => setTimeout(resolve, parsed.waitMs));
    }

    const result = await workflow.runStreamNode(outputNode, parsed, context);
    if (result.output === undefined) {
      throw new workflow.WorkflowError({
        type: "workflow_execution",
        message: "Smoke output was not created.",
      });
    }

    return result.output;
  },
});

export const executor = workflow.defineExecutor<SmokeInput, SmokeOutputPayload>({
  projectType: "conversation",
  workflow: smokeWorkflow,
  registry: [
    {
      name: "smoke-output",
      node: outputNode,
      stream: true,
      createInput({ args }) {
        return parseSmokeInput(args);
      },
    },
  ],
  params: [
    {
      kind: "auxiliary",
      id: "execution",
      label: "Execution",
      fields: [
        {
          name: "mode",
          flag: "--mode",
          type: "string",
          required: false,
          defaultValue: "ok",
          description: "Smoke mode: ok, fail, plain-error, payload-fail, wait.",
        },
        {
          name: "waitMs",
          flag: "--wait-ms",
          type: "number",
          required: false,
          defaultValue: "0",
          description: "Wait duration for timeout checks.",
        },
      ],
    },
  ],
  createInput({ args }) {
    return parseSmokeInput(args);
  },
});

export { smokeWorkflow as workflow };
export default smokeWorkflow;

function parseSmokeInput(args: string[]): SmokeInput {
  const defaults = workflow.parseConversationDefaultInputArgs(args);
  let message = defaults.message.trim() === "" ? "ok" : defaults.message;
  let mode: SmokeInput["mode"] = "ok";
  let waitMs = 0;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--mode") {
      const value = args[++index];
      mode = value === "fail" || value === "plain-error" || value === "payload-fail" || value === "wait"
        ? value
        : "ok";
    } else if (arg === "--wait-ms") {
      waitMs = Number(args[++index] ?? "0");
    }
  }

  return { message, mode, waitMs };
}
