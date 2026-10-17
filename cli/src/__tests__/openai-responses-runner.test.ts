import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { OpenAIInternalRunnerFrame } from "@workflow-code/openai-responses";
import {
  parseOpenAIInternalRunnerRequest,
  runOpenAIResponsesRunner,
} from "../openai-responses-runner";
import { isolateOpenAIRunnerStdout, type OpenAIRunnerWritable } from "../openai-runner-stdio";

const request = {
  protocolVersion: 1 as const,
  action: "run" as const,
  executionId: "run_test",
  projectPath: "/tmp/conversation",
  hostInput: {
    kind: "openai.responses" as const,
    requestId: "req_test",
    responseId: "resp_test",
    projectId: "11111111-1111-4111-8111-111111111111",
    model: "gpt-test",
    messages: [{
      type: "message" as const,
      role: "user" as const,
      content: [{ type: "input_text" as const, text: "hello" }],
    }],
    settings: {},
  },
};

describe("OpenAI Responses internal runner", () => {
  it("reserves stdout for protocol frames and redirects arbitrary writes to stderr", () => {
    const stdoutChunks: unknown[][] = [];
    const stderrChunks: unknown[][] = [];
    const stdout: OpenAIRunnerWritable = { write: (...args) => stdoutChunks.push(args) };
    const stderr: OpenAIRunnerWritable = { write: (...args) => stderrChunks.push(args) };
    const writeProtocolLine = isolateOpenAIRunnerStdout(stdout, stderr);

    stdout.write("project output", "utf8");
    writeProtocolLine('{"type":"ready"}\n');

    assert.deepEqual(stdoutChunks, [['{"type":"ready"}\n']]);
    assert.deepEqual(stderrChunks, [["project output", "utf8"]]);
  });

  it("validates the single JSON stdin request", () => {
    assert.deepEqual(parseOpenAIInternalRunnerRequest(JSON.stringify(request)), request);
    assert.throws(
      () => parseOpenAIInternalRunnerRequest(JSON.stringify({ ...request, protocolVersion: 2 })),
      /Unsupported OpenAI runner protocol/u,
    );
    assert.throws(
      () => parseOpenAIInternalRunnerRequest(JSON.stringify({ ...request, hostInput: {} })),
      /request is invalid/u,
    );
  });

  it("emits ready, UTF-8 text deltas, and a metadata-only completed frame", async () => {
    const frames: OpenAIInternalRunnerFrame[] = [];
    const report = {
      status: "success",
      outputs: [{
        output: {
          items: [{
            id: "conversation-answer",
            title: "Output",
            content: "你好",
            metadata: {
              finishReason: "stop",
              providerMetadata: { provider: "fake" },
            },
          }],
        },
      }],
      nodes: [],
      result: { ok: true, data: {} },
      tokenUsage: {
        enabled: true,
        display: true,
        run: {
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5,
          reasoningTokens: 0,
          cachedInputTokens: 1,
          cacheCreationTokens: 0,
          calls: 1,
        },
      },
    };
    const exitCode = await runOpenAIResponsesRunner({
      readInput: () => JSON.stringify(request),
      writeFrame: (frame) => frames.push(frame),
      inspectProject: (() => ({
        projectType: "conversation",
        conversation: { openai: { enabled: true, outputItemId: "conversation-answer" } },
      })) as never,
      runWorkflow: (async (options: { nodeHooks: { onNodeChunk?: (event: unknown) => void } }) => {
        options.nodeHooks.onNodeChunk?.({
          nodeName: "conversation-answer",
          executionId: "node_test",
          kind: "stream-node",
          startedAt: new Date(),
          chunkOrder: 1,
          timestamp: new Date(),
          chunk: {
            type: "output_item_delta",
            itemId: "conversation-answer",
            delta: "你好",
          },
        });
        return report;
      }) as never,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(frames, [
      { type: "ready", executionId: "run_test" },
      { type: "text-delta", executionId: "run_test", delta: "你好" },
      {
        type: "completed",
        executionId: "run_test",
        outputText: "你好",
        outputItemId: "conversation-answer",
        usage: {
          input_tokens: 3,
          input_tokens_details: { cached_tokens: 1 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 5,
        },
        report,
        finishReason: "stop",
        providerMetadata: { provider: "fake" },
      },
    ]);
  });

  it("rejects projects without an enabled adapter before execution", async () => {
    const frames: OpenAIInternalRunnerFrame[] = [];
    const exitCode = await runOpenAIResponsesRunner({
      readInput: () => JSON.stringify(request),
      writeFrame: (frame) => frames.push(frame),
      inspectProject: (() => ({ projectType: "conversation", conversation: {} })) as never,
      runWorkflow: (async () => {
        throw new Error("must not run");
      }) as never,
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(frames, [{
      type: "failed",
      executionId: "run_test",
      error: { message: "The project does not expose an OpenAI Responses adapter." },
    }]);
  });

  it("returns the deepest safe provider cause for failed executions", async () => {
    const frames: OpenAIInternalRunnerFrame[] = [];
    const report = {
      status: "failed",
      outputs: [],
      nodes: [],
      result: {
        ok: false,
        error: {
          type: "provider_call",
          message: "LLM provider chat call failed.",
          cause: {
            message: "Provider request failed.",
            cause: { message: "temperature is not supported by model-a." },
          },
        },
      },
    };
    const exitCode = await runOpenAIResponsesRunner({
      readInput: () => JSON.stringify(request),
      writeFrame: (frame) => frames.push(frame),
      inspectProject: (() => ({
        projectType: "conversation",
        conversation: { openai: { enabled: true, outputItemId: "conversation-answer" } },
      })) as never,
      runWorkflow: (async () => report) as never,
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(frames, [
      { type: "ready", executionId: "run_test" },
      {
        type: "failed",
        executionId: "run_test",
        error: { message: "temperature is not supported by model-a." },
        report,
      },
    ]);
  });
});
