import { describe, expect, it } from "vitest";
import { createOutputStreamAccumulator } from "steamharness/node/output";
import {
  createAnswerItemStartChunk,
  createToolApprovalDecisionChunks,
  createToolEndChunks,
  createToolStartChunk,
} from "../output-items";
import { runPiAgentStream } from "../stream-output";

describe("pi-agent output items", () => {
  it("keeps assistant text on the default inline output item", () => {
    const stream = createOutputStreamAccumulator([
      createAnswerItemStartChunk("pi-agent-answer"),
      {
        type: "output_item_delta",
        itemId: "pi-agent-answer",
        delta: "Pi answer",
      },
      {
        type: "output_item_delta",
        itemId: "pi-agent-answer",
        delta: " without tool details.",
      },
      {
        type: "output_item_end",
        itemId: "pi-agent-answer",
      },
    ]);
    const item = stream.items[0];

    expect(stream.items).toHaveLength(1);
    expect(item).toMatchObject({
      id: "pi-agent-answer",
      title: "Output",
      content: "Pi answer without tool details.",
      contentType: "markdown",
      collapsed: false,
    });
    expect(item?.icon).toBeUndefined();
    expect(item?.iconPreset).toBeUndefined();
    expect(item?.metadata).toBeUndefined();
  });

  it("patches a completed tool item from running to success", () => {
    const chunks = [
      createToolStartChunk({
        type: "tool",
        phase: "start",
        toolCallId: "call_function_1",
        toolName: "read",
        args: { path: "README.md" },
      }),
      ...createToolEndChunks({
        type: "tool",
        phase: "end",
        toolCallId: "call_function_1",
        toolName: "read",
        result: { content: "ok" },
        isError: false,
      }),
    ];

    const stream = createOutputStreamAccumulator(chunks);
    const item = stream.items[0];

    expect(item).toMatchObject({
      id: "pi-agent-tool-call_function_1",
      title: "read success",
      contentType: "json",
      iconPreset: "success",
      metadata: {
        kind: "pi-agent-tool",
        status: "success",
        toolName: "read",
      },
    });
    expect(item?.content).toEqual({
      tool: "read",
      args: { path: "README.md" },
      status: "success",
      result: { content: "ok" },
    });
  });

  it("patches a failed tool item from running to failed", () => {
    const chunks = [
      createToolStartChunk({
        type: "tool",
        phase: "start",
        toolCallId: "call_function_2",
        toolName: "bash",
        args: { command: "exit 1" },
      }),
      ...createToolEndChunks({
        type: "tool",
        phase: "end",
        toolCallId: "call_function_2",
        toolName: "bash",
        result: { stderr: "failed" },
        isError: true,
      }),
    ];

    const stream = createOutputStreamAccumulator(chunks);
    const item = stream.items[0];

    expect(item).toMatchObject({
      title: "bash failed",
      iconPreset: "error",
      metadata: {
        kind: "pi-agent-tool",
        status: "failed",
        toolName: "bash",
      },
    });
    expect(item?.content).toMatchObject({
      tool: "bash",
      args: { command: "exit 1" },
      status: "failed",
      result: { stderr: "failed" },
    });
  });

  it("keeps tool detail items between assistant text segments", async () => {
    const chunks = await collect(runPiAgentStream(toAsyncIterable([
      { type: "text_delta", delta: "Before tool. " },
      {
        type: "tool",
        phase: "start",
        toolCallId: "call_interleaved_1",
        toolName: "read",
        args: { path: "README.md" },
      },
      {
        type: "tool",
        phase: "end",
        toolCallId: "call_interleaved_1",
        toolName: "read",
        result: { content: "ok" },
        isError: false,
      },
      { type: "text_delta", delta: "After tool." },
    ])));

    const stream = createOutputStreamAccumulator(chunks);

    expect(stream.items.map((item) => item.id)).toEqual([
      "pi-agent-answer-1",
      "pi-agent-tool-call_interleaved_1",
      "pi-agent-answer-2",
    ]);
    expect(stream.items.map((item) => item.content)).toEqual([
      "Before tool. ",
      {
        tool: "read",
        args: { path: "README.md" },
        status: "success",
        result: { content: "ok" },
      },
      "After tool.",
    ]);
    expect(stream.items[0]?.metadata).toBeUndefined();
    expect(stream.items[2]?.metadata).toBeUndefined();
    expect(stream.items[1]?.metadata).toMatchObject({
      kind: "pi-agent-tool",
      status: "success",
    });
  });

  it("keeps tool approval decisions as independent output items", async () => {
    const approvalChunks = createToolApprovalDecisionChunks({
      toolName: "bash",
      label: "Run shell commands",
      status: "approved",
      requestId: "pi-agent:run:tool-approval:bash",
      arguments: { command: "pwd" },
      values: { approved: true },
    });
    const chunks = await collect(runPiAgentStream(toAsyncIterable([
      { type: "text_delta", delta: "Before approval. " },
      ...approvalChunks.map((chunk) => ({ type: "output_chunk" as const, chunk })),
      { type: "text_delta", delta: "After approval." },
    ])));

    const stream = createOutputStreamAccumulator(chunks);
    const approval = stream.items.find((item) => item.metadata?.kind === "pi-agent-tool-approval");

    expect(approval).toMatchObject({
      title: "工具权限审批 · Run shell commands · 已批准",
      contentType: "json",
      collapsed: false,
      iconPreset: "success",
      metadata: {
        kind: "pi-agent-tool-approval",
        status: "approved",
        toolName: "bash",
        requestId: "pi-agent:run:tool-approval:bash",
      },
    });
    expect(stream.items.map((item) => item.id)).toEqual([
      "pi-agent-answer-1",
      approval?.id,
      "pi-agent-answer-2",
    ]);
  });

  it("keeps approval decisions before approved tool lifecycle rows", async () => {
    const approvalChunks = createToolApprovalDecisionChunks({
      toolName: "knowledge_documents",
      label: "Knowledge Documents",
      status: "approved",
      requestId: "pi-agent:run:tool-approval:knowledge_documents",
      arguments: { action: "list" },
      values: { approved: true },
    });
    const chunks = await collect(runPiAgentStream(toAsyncIterable([
      ...approvalChunks.map((chunk) => ({ type: "output_chunk" as const, chunk })),
      {
        type: "tool" as const,
        phase: "start" as const,
        toolCallId: "call_knowledge_documents",
        toolName: "knowledge_documents",
        args: { action: "list" },
      },
      {
        type: "tool" as const,
        phase: "end" as const,
        toolCallId: "call_knowledge_documents",
        toolName: "knowledge_documents",
        result: { action: "list", count: 0 },
        isError: false,
      },
      { type: "text_delta" as const, delta: "已执行 knowledge_documents list。" },
    ])));

    const stream = createOutputStreamAccumulator(chunks);

    expect(stream.items.map((item) => item.title)).toEqual([
      "工具权限审批 · Knowledge Documents · 已批准",
      "knowledge_documents success",
      "Output",
    ]);
  });
});

async function* toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  yield* items;
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const item of items) {
    collected.push(item);
  }
  return collected;
}
