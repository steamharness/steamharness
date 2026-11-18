import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runLocalProjectWithReport, withUserSettings } from "steamharness";
import { createMemoryRuntimePersistence } from "steamharness/runtime-storage";
import { writeProjectFixture } from "../../scripts/test-project-fixture.mjs";
import type { OpenAIInternalRunnerFrame } from "@steamharness/openai-responses";
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
        projectType: "bot",
        conversation: { openai: { enabled: true, outputItemId: "conversation-answer" } },
      })) as never,
      runProject: (async (options: { nodeHooks: { onNodeChunk?: (event: unknown) => void } }) => {
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

  it("runs a declared LLM Bot with the adapter's history and streams the answer and usage", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "responses-llm-bot-"));
    const frames: OpenAIInternalRunnerFrame[] = [];
    const settings = { agent: { permissionPolicy: "auto" as const, models: [{
      id: "fixture", name: "Fixture", model: "fixture-model", source: "third-party" as const,
      apiKind: "openai-completions" as const, baseUrl: "https://model.example.test/v1", apiKey: "fixture-key",
    }] } };
    const fetchModel = vi.fn(async () => new Response([
      { choices: [{ index: 0, delta: { role: "assistant", content: "你好" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "，项目" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } },
    ].map(event => `data: ${JSON.stringify({ id: "fixture-completion", ...event })}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchModel);
    vi.stubEnv("HOME", projectDir);
    vi.stubEnv("USERPROFILE", projectDir);
    try {
      await writeProjectFixture(path.join(projectDir, "package.json"), JSON.stringify({
        name: "responses-llm-bot", version: "1.0.0", type: "module", id: crypto.randomUUID(), defaultEntry: "main",
        entries: [{ entryId: "main", name: "Responses LLM Bot", type: "bot", root: ".", entry: "index.mjs" }],
      }));
      await writeFile(path.join(projectDir, "index.mjs"), `export const executor = steamharness.defineBot({
        engine: "llm", llm: { systemPrompt: "Project prompt" },
      });`);
      const exitCode = await withUserSettings(settings, () => runOpenAIResponsesRunner({
        readInput: () => JSON.stringify({ ...request, projectPath: projectDir, hostInput: {
          ...request.hostInput, instructions: "Host instructions", messages: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "Earlier question" }] },
            { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Earlier answer" }] },
            { type: "message", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: "Discard partial" }] },
            ...request.hostInput.messages,
          ],
        } }),
        writeFrame: frame => frames.push(frame),
        runProject: options => runLocalProjectWithReport({ ...options, storage: { host: "local", local: { runtimePersistence: createMemoryRuntimePersistence() } } }),
      }));
      assert.equal(exitCode, 0, JSON.stringify(frames.at(-1)));
      assert.equal(fetchModel.mock.calls.length, 1);
      const [url, init] = fetchModel.mock.calls[0] as unknown as [URL | string, RequestInit];
      assert.equal(String(url), "https://model.example.test/v1/chat/completions");
      const payload = String(init.body);
      assert.match(payload, /Project prompt.*Host instructions.*Earlier question.*Earlier answer.*hello/u);
      assert.doesNotMatch(payload, /Discard partial|"tools"/u);
      assert.deepEqual(frames.map(frame => frame.type), ["ready", "text-delta", "text-delta", "completed"]);
      assert.deepEqual(frames.flatMap(frame => frame.type === "text-delta" ? [frame.delta] : []), ["你好", "，项目"]);
      const completed = frames.at(-1);
      assert.ok(completed?.type === "completed");
      assert.equal(completed.outputItemId, "agent-answer");
      assert.equal(completed.outputText, "你好，项目");
      assert.equal(completed.usage.total_tokens, 12);
    } finally {
      vi.unstubAllGlobals(); vi.unstubAllEnvs();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("rejects projects without an enabled adapter before execution", async () => {
    const frames: OpenAIInternalRunnerFrame[] = [];
    const exitCode = await runOpenAIResponsesRunner({
      readInput: () => JSON.stringify(request),
      writeFrame: (frame) => frames.push(frame),
      inspectProject: (() => ({ projectType: "bot", conversation: {} })) as never,
      runProject: (async () => {
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
        projectType: "bot",
        conversation: { openai: { enabled: true, outputItemId: "conversation-answer" } },
      })) as never,
      runProject: (async () => report) as never,
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
