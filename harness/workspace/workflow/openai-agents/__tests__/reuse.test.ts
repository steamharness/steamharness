import { beforeAll, describe, expect, it } from "vitest";
import { installWorkflowRuntimeGlobal } from "steamharness/runtime-api";
import {
  createDisabledWorkflowTokenUsageContext,
  createWorkflowRelatedProjectsContext,
  createWorkflowToolPermissionContext,
  createWorkflowTokenUsageContext,
  createWorkflowConversationContext,
  type WorkflowKVContext,
} from "steamharness";
import type {
  AgentFact,
  AgentToolCallSummary,
  ConversationSnapshot,
  OpenAIAgentsRunInput,
} from "../interface";
import type { NodeExecutionHookChunkEvent, WorkflowContext } from "steamharness/types/context";
import { tool } from "@openai/agents";
import { z } from "zod";

installWorkflowRuntimeGlobal();

let openaiAgentsWorkflow: typeof import("../index").openaiAgentsWorkflow;
let createOpenAIAgentTools: typeof import("../index").createOpenAIAgentTools;
let approveOpenAIAgentsRunTools: typeof import("../index").approveOpenAIAgentsRunTools;
let runAgentWithStreamingFallback: typeof import("../index").runAgentWithStreamingFallback;
let isKnownAgentsResponsesStreamOutputError: typeof import("../index").isKnownAgentsResponsesStreamOutputError;
let normalizeStreamingTextDelta: typeof import("../index").normalizeStreamingTextDelta;
let runAgentStream: typeof import("../index").runAgentStream;

beforeAll(async () => {
  const module = await import("../index");
  openaiAgentsWorkflow = module.openaiAgentsWorkflow;
  createOpenAIAgentTools = module.createOpenAIAgentTools;
  approveOpenAIAgentsRunTools = module.approveOpenAIAgentsRunTools;
  runAgentWithStreamingFallback = module.runAgentWithStreamingFallback;
  isKnownAgentsResponsesStreamOutputError = module.isKnownAgentsResponsesStreamOutputError;
  normalizeStreamingTextDelta = module.normalizeStreamingTextDelta;
  runAgentStream = module.runAgentStream;
});

describe("openai-agents reusable mode", () => {
  it("registers default tools in normal mode", () => {
    const toolEvents: AgentToolCallSummary[] = [];
    const tools = createOpenAIAgentTools({
      input: createRunInput(),
      context: createToolContext(toolEvents),
      sdkContext: createSdkContext(),
      toolEvents,
    });

    expect(tools.map(readToolName)).toEqual(expect.arrayContaining([
      "web_search",
      "image_generation",
      "test_tool",
      "knowledge_documents",
      "remember_fact",
      "read_context",
    ]));
  });

  it("can disable default tools and keep only custom tools", () => {
    const customTool = {
      type: "function",
      name: "delta_force_lookup",
      description: "Lookup Delta Force data.",
    };
    const tools = createOpenAIAgentTools({
      input: createRunInput({
        defaultTools: false,
        memoryTools: false,
        knowledgeTools: false,
        testTool: false,
        customTools: [customTool],
      }),
      context: createToolContext([]),
      sdkContext: createSdkContext(),
    });

    expect(tools.map(readToolName)).toEqual(["delta_force_lookup"]);
  });

  it("does not write openai-agents KV or append messages when reuse flags are disabled", async () => {
    const kv = createMemoryKVContext();
    const context = {
      providers: {},
      storage: {
        local: {
          kv,
          persistentValue: kv,
          relatedProjects: createWorkflowRelatedProjectsContext(),
        },
      },
      conversation: createWorkflowConversationContext({
        enabled: true,
        conversationId: "reuse-thread",
        workflowName: "openai-agents",
        kv,
      }),
      tokenUsage: createDisabledWorkflowTokenUsageContext(),
    };
    await context.conversation.appendMessage({ role: "user", content: "existing" });

    const result = await openaiAgentsWorkflow.run({
      message: "Use the custom tool",
      model: "fake-model",
      defaultTools: false,
      memoryTools: false,
      knowledgeTools: false,
      testTool: false,
      writeConversation: false,
      writeAgentState: false,
      customTools: [{ type: "function", name: "delta_force_lookup", description: "Lookup Delta Force data." }],
      agentRunner({ tools }) {
        return {
          finalOutput: `custom tools: ${tools.map(readToolName).join(", ")}`,
          history: [{ role: "user" }, { role: "assistant" }],
          newItems: [
            {
              rawItem: {
                type: "function_call",
                name: "delta_force_lookup",
                status: "completed",
              },
            },
          ],
          usage: {
            requests: 1,
            inputTokens: 3,
            outputTokens: 4,
            totalTokens: 7,
          },
        };
      },
    }, context);
    const state = await context.conversation.getValue();

    expect(result.items[0]?.content).toContain("delta_force_lookup");
    expect(state.messages).toHaveLength(1);
    expect(await kv.conversation.getValue("openaiAgents.runCount")).toBeUndefined();
    expect(await kv.conversation.getValue("openaiAgents.facts")).toBeUndefined();
    expect(await kv.conversation.getValue("openaiAgents.history")).toBeUndefined();
  });

  it("streams answer chunks before finalize side effects complete", async () => {
    const chunks: NodeExecutionHookChunkEvent[] = [];
    const context = createOpenAIAgentsContext({
      onChunk(event) {
        chunks.push(event);
      },
    });
    const result = await openaiAgentsWorkflow.run({
      message: "stream please",
      model: "fake-model",
      defaultTools: false,
      memoryTools: false,
      knowledgeTools: false,
      testTool: false,
      agentRunner() {
        return {
          finalOutput: "Hello streaming world",
          outputChunks: createDelayedChunks(["Hello ", "streaming ", "world"], 2),
          history: [{ role: "user" }, { role: "assistant" }],
          newItems: [],
          usage: {
            requests: 1,
            inputTokens: 3,
            outputTokens: 4,
            totalTokens: 7,
          },
        };
      },
    }, context);

    expect(result.items[0]?.content).toBe("Hello streaming world");
    expect(chunks.filter((event) => isOutputDelta(event.chunk)).map((event) => event.chunk.delta)).toEqual([
      "Hello ",
      "streaming ",
      "world",
    ]);
    expect(await context.storage.local.kv.conversation.getValue("openaiAgents.history")).toMatchObject({
      historyLength: 2,
    });
  });

  it("reports cache read and write token details from SDK usage aliases", async () => {
    const context = createOpenAIAgentsContext({ tokenUsageEnabled: true });

    const result = await openaiAgentsWorkflow.run({
      message: "report cache usage",
      model: "fake-model",
      defaultTools: false,
      memoryTools: false,
      knowledgeTools: false,
      testTool: false,
      writeConversation: false,
      writeAgentState: false,
      agentRunner() {
        return {
          finalOutput: "cache usage reported",
          history: [{ role: "user" }, { role: "assistant" }],
          newItems: [],
          usage: {
            requests: 1,
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_token_details: {
              cache_read_tokens: 2,
              cache_write_tokens: 4,
            },
          },
        };
      },
    }, context);

    expect(result.items[0]?.content).toBe("cache usage reported");
    expect(context.tokenUsage.getRunUsage()).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedInputTokens: 2,
      cacheCreationTokens: 4,
      calls: 1,
    });
  });

  it("streams function tool calls as output items before the final answer", async () => {
    const chunks: NodeExecutionHookChunkEvent[] = [];
    const context = createOpenAIAgentsContext({
      onChunk(event) {
        chunks.push(event);
      },
    });
    const customTool = tool({
      name: "delta_force_lookup",
      description: "Lookup Delta Force data.",
      parameters: z.object({
        q: z.string(),
        limit: z.number().optional(),
      }),
      execute(args) {
        return {
          ok: true,
          summary: `found ${args.q}`,
          data: [{ name: "M7 战斗步枪" }],
        };
      },
    });

    const result = await openaiAgentsWorkflow.run({
      message: "Use the custom tool",
      model: "fake-model",
      defaultTools: false,
      memoryTools: false,
      knowledgeTools: false,
      testTool: false,
      writeConversation: false,
      writeAgentState: false,
      customTools: [customTool],
      async agentRunner({ tools }) {
        const lookup = tools.find((candidate): candidate is typeof customTool =>
          typeof candidate === "object" &&
          candidate !== null &&
          "type" in candidate &&
          candidate.type === "function" &&
          "name" in candidate &&
          candidate.name === "delta_force_lookup" &&
          "invoke" in candidate &&
          typeof candidate.invoke === "function",
        );
        if (lookup === undefined) {
          throw new Error("delta_force_lookup was not registered");
        }
        await lookup.invoke({ context: {} } as Parameters<typeof lookup.invoke>[0], JSON.stringify({ q: "M7", limit: 3 }));
        return {
          finalOutput: "M7 工具查询完成",
          outputChunks: createDelayedChunks(["M7 ", "工具查询完成"], 1),
          history: [{ role: "user" }, { role: "assistant" }],
          newItems: [
            {
              rawItem: {
                type: "function_call",
                name: "delta_force_lookup",
                status: "completed",
              },
            },
          ],
          usage: {
            requests: 1,
            inputTokens: 3,
            outputTokens: 4,
            totalTokens: 7,
          },
        };
      },
    }, context);

    expect(result.items.map((item) => item.id)).toEqual([
      "openai-agents-tool-1-delta_force_lookup",
      "openai-agents-answer",
    ]);
    expect(result.items[1]).toMatchObject({
      id: "openai-agents-answer",
      title: "Output",
      contentType: "markdown",
      collapsed: false,
    });
    expect(result.items[1]?.content).toBe("M7 工具查询完成");
    expect(result.items[0]).toMatchObject({
      title: "Tool: delta_force_lookup",
      contentType: "markdown",
      iconPreset: "success",
      collapsed: true,
      metadata: {
        kind: "openai-agents-tool-call",
        toolName: "delta_force_lookup",
        status: "success",
        outcome: "completed",
      },
    });
    expect(String(result.items[0]?.content)).toContain("**工具调用** `delta_force_lookup`");
    expect(String(result.items[0]?.content)).toContain("\"q\": \"M7\"");
    expect(String(result.items[0]?.content)).toContain("M7 战斗步枪");

    const startIds = chunks
      .filter((event) => isOutputStart(event.chunk))
      .map((event) => event.chunk.item.id);
    expect(startIds).toEqual([
      "openai-agents-tool-1-delta_force_lookup",
      "openai-agents-answer",
    ]);
  });

  it("emits each tool start chunk as soon as that tool invocation begins", async () => {
    const chunks: Array<NodeExecutionHookChunkEvent & { observedAt: number }> = [];
    const context = createOpenAIAgentsContext({
      onChunk(event) {
        chunks.push({ ...event, observedAt: Date.now() });
      },
    });
    const startedAt = Date.now();

    function createDelayedTool(name: string, delayMs: number) {
      return tool({
        name,
        description: `Delayed ${name} tool.`,
        parameters: z.object({
          value: z.string(),
        }),
        async execute(args) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return { ok: true, name, value: args.value };
        },
      });
    }

    const delayedTools = [
      createDelayedTool("first_delayed_tool", 80),
      createDelayedTool("second_delayed_tool", 120),
      createDelayedTool("third_delayed_tool", 160),
    ];

    await openaiAgentsWorkflow.run({
      message: "Use delayed tools",
      model: "fake-model",
      defaultTools: false,
      memoryTools: false,
      knowledgeTools: false,
      testTool: false,
      writeConversation: false,
      writeAgentState: false,
      customTools: delayedTools,
      async agentRunner({ tools }) {
        const invokableTools = tools
          .filter((candidate): candidate is typeof delayedTools[number] =>
            typeof candidate === "object" &&
            candidate !== null &&
            "type" in candidate &&
            candidate.type === "function" &&
            "invoke" in candidate &&
            typeof candidate.invoke === "function",
          );

        await Promise.all(invokableTools.map((agentTool, index) =>
          agentTool.invoke(
            { context: {} } as Parameters<typeof agentTool.invoke>[0],
            JSON.stringify({ value: `value-${index}` }),
          )
        ));

        return {
          finalOutput: "delayed tools complete",
          history: [{ role: "user" }, { role: "assistant" }],
          newItems: invokableTools.map((agentTool) => ({
            rawItem: {
              type: "function_call",
              name: agentTool.name,
              status: "completed",
            },
          })),
          usage: {
            requests: 1,
            inputTokens: 3,
            outputTokens: 4,
            totalTokens: 7,
          },
        };
      },
    }, context);

    const startChunks = chunks
      .filter((event) => isOutputStart(event.chunk))
      .filter((event) => event.chunk.item.id?.startsWith("openai-agents-tool-"));
    const endChunks = chunks
      .filter((event) => isOutputEnd(event.chunk))
      .filter((event) => event.chunk.itemId.startsWith("openai-agents-tool-"));

    expect(startChunks).toHaveLength(3);
    expect(endChunks).toHaveLength(3);
    expect(startChunks.map((event) => event.chunk.item.id)).toEqual([
      "openai-agents-tool-1-first_delayed_tool",
      "openai-agents-tool-2-second_delayed_tool",
      "openai-agents-tool-3-third_delayed_tool",
    ]);
    expect(Math.max(...startChunks.map((event) => event.observedAt - startedAt))).toBeLessThan(50);
    expect(Math.min(...endChunks.map((event) => event.observedAt - startedAt))).toBeGreaterThanOrEqual(70);
  });

  it("forwards SDK tool_called stream events before post-tool text deltas", async () => {
    const observed: string[] = [];
    const result = await runAgentStream(createFakeRunner([
      createRawModelStreamEvent("response_started"),
      createRunItemStreamEvent("tool_called", {
        type: "tool_call_item",
        rawItem: {
          type: "function_call",
          callId: "call_1",
          name: "knowledge_documents",
          arguments: JSON.stringify({ action: "get", id: "article" }),
          status: "in_progress",
        },
      }),
      createRawModelStreamEvent("response_done", { response: { output: [{ type: "function_call", name: "knowledge_documents" }] } }),
      createRawModelStreamEvent("response_started"),
      createRawModelStreamEvent("output_text_delta", { delta: "已读取文档。" }),
      createRawModelStreamEvent("response_done", { response: { output: [{ type: "message" }] } }),
    ]), {
      agent: {} as Agent<any, any>,
      message: "read article",
      context: {},
      signal: undefined,
    }, {
      async onTextDelta(delta) {
        observed.push(`text:${delta}`);
      },
      async onStreamEvent(event) {
        if (isRunItemToolCalledEvent(event)) {
          observed.push("tool_called:knowledge_documents");
        }
      },
    });

    expect(observed).toEqual([
      "tool_called:knowledge_documents",
      "text:已读取文档。",
    ]);
    expect(result.finalOutput).toBe("已读取文档。");
  });

  it("runs the knowledge_documents tool through a full workflow execution", async () => {
    const chunks: NodeExecutionHookChunkEvent[] = [];
    const context = createOpenAIAgentsContext({
      onChunk(event) {
        chunks.push(event);
      },
    });
    const result = await openaiAgentsWorkflow.run({
      message: "Create and search a knowledge document",
      model: "fake-model",
      defaultTools: false,
      memoryTools: false,
      testTool: false,
      writeConversation: false,
      writeAgentState: false,
      async agentRunner({ tools }) {
        const knowledgeTool = findInvokableTool(tools, "knowledge_documents");
        await knowledgeTool.invoke({ context: {} } as Parameters<typeof knowledgeTool.invoke>[0], JSON.stringify({
          action: "create",
          documentId: "agent-runbook",
          title: "Agent Runbook",
          markdown: "# Agent Runbook\n\nUse PersistentValue for knowledge documents.\n\nSearchable line.",
        }));
        const searchResult = parseToolOutput(await knowledgeTool.invoke(
          { context: {} } as Parameters<typeof knowledgeTool.invoke>[0],
          JSON.stringify({
            action: "search",
            query: "PersistentValue",
            documentId: "agent-runbook",
            beforeLines: 1,
            afterLines: 1,
            pageSize: 5,
          }),
        ));
        const linesResult = parseToolOutput(await knowledgeTool.invoke(
          { context: {} } as Parameters<typeof knowledgeTool.invoke>[0],
          JSON.stringify({
            action: "read_lines",
            documentId: "agent-runbook",
            startLine: 1,
            endLine: 2,
          }),
        ));

        expect(searchResult).toMatchObject({
          action: "search",
          totalMatches: 1,
          matches: [
            {
              documentId: "agent-runbook",
              lineNumber: 3,
              line: "Use PersistentValue for knowledge documents.",
            },
          ],
        });
        expect(linesResult).toMatchObject({
          action: "read_lines",
          documentId: "agent-runbook",
          lines: [
            { lineNumber: 1, content: "# Agent Runbook" },
            { lineNumber: 2, content: "" },
          ],
        });

        return {
          finalOutput: `knowledge tool ok: ${String((searchResult as { totalMatches?: unknown }).totalMatches)}`,
          history: [{ role: "user" }, { role: "assistant" }],
          newItems: [
            {
              rawItem: {
                type: "function_call",
                name: "knowledge_documents",
                status: "completed",
              },
            },
          ],
          usage: {
            requests: 1,
            inputTokens: 3,
            outputTokens: 4,
            totalTokens: 7,
          },
        };
      },
    }, context);

    expect(result.items.find((item) => item.id === "openai-agents-answer")?.content).toBe("knowledge tool ok: 1");
    expect(result.toolCalls).toEqual([
      { name: "knowledge_documents", status: "completed" },
      { name: "knowledge_documents", status: "completed" },
      { name: "knowledge_documents", status: "completed" },
    ]);
    const startIds = chunks
      .filter((event) => isOutputStart(event.chunk))
      .map((event) => event.chunk.item.id);
    expect(startIds).toEqual([
      "openai-agents-tool-1-knowledge_documents",
      "openai-agents-tool-2-knowledge_documents",
      "openai-agents-tool-3-knowledge_documents",
      "openai-agents-answer",
    ]);
    expect(await context.storage.local.persistentValue.getValue("knowledge.document.agent-runbook")).toMatchObject({
      id: "agent-runbook",
      title: "Agent Runbook",
    });
  });

  it("can disable knowledge document tools for reusable isolated agents", () => {
    const tools = createOpenAIAgentTools({
      input: createRunInput({
        defaultTools: false,
        memoryTools: false,
        knowledgeTools: false,
        testTool: false,
      }),
      context: createToolContext([]),
      sdkContext: createSdkContext(),
    });

    expect(tools.map(readToolName)).not.toContain("knowledge_documents");
  });

  it("filters tools disabled by registered tool policy", () => {
    const tools = createOpenAIAgentTools({
      input: createRunInput(),
      context: createToolContext([], {
        web_search: { enabled: false },
        knowledge_documents: { enabled: false },
        remember_fact: { enabled: false },
      }),
      sdkContext: createSdkContext(),
    });

    expect(tools.map(readToolName)).not.toEqual(expect.arrayContaining([
      "web_search",
      "knowledge_documents",
      "remember_fact",
    ]));
    expect(tools.map(readToolName)).toEqual(expect.arrayContaining([
      "image_generation",
      "test_tool",
      "read_context",
    ]));
  });

  it("keeps hosted tools visible when they require run-level manual approval", () => {
    const tools = createOpenAIAgentTools({
      input: createRunInput(),
      context: createToolContext([], {
        web_search: { autoApprove: false },
        image_generation: { autoApprove: false },
      }),
      sdkContext: createSdkContext(),
    });

    expect(tools.map(readToolName)).toEqual(expect.arrayContaining([
      "web_search",
      "image_generation",
    ]));
  });

  it("pauses before a run when hosted tools require manual approval", async () => {
    await expect(approveOpenAIAgentsRunTools({
      input: createRunInput(),
      context: createToolContext([], {
        web_search: { autoApprove: false },
      }),
    })).rejects.toMatchObject({
      name: "WorkflowError",
      type: "user_input_required",
    });
  });

  it("reports approved hosted tool permission decisions for output items", async () => {
    const approvals: Array<{ name: string; status: string; requestId?: string; values?: Record<string, unknown> }> = [];
    const requestId = "openai-agents:openai-agents-test-run:tool-approval:web_search";
    await expect(approveOpenAIAgentsRunTools({
      input: createRunInput(),
      context: createToolContext([], {
        web_search: { autoApprove: false },
      }, {
        requestId,
        nodeName: "tool-approval",
        values: { approved: true },
        submittedAt: new Date("2026-06-16T00:00:00.000Z"),
      }),
      toolReporter: {
        async start() {
          throw new Error("start should not run for hosted pre-run approval");
        },
        async startFromSdkToolCall() {},
        async finish() {},
        async approval(input) {
          approvals.push(input);
        },
      },
    })).resolves.toBeUndefined();

    expect(approvals).toEqual([
      expect.objectContaining({
        name: "web_search",
        status: "approved",
        requestId,
        values: { approved: true },
      }),
    ]);
  });

  it("skips hosted run approval when default tools are disabled", async () => {
    await expect(approveOpenAIAgentsRunTools({
      input: createRunInput({ defaultTools: false }),
      context: createToolContext([], {
        web_search: { autoApprove: false },
        image_generation: { autoApprove: false },
      }),
    })).resolves.toBeUndefined();
  });

  it("does not include disabled hosted tools", () => {
    const tools = createOpenAIAgentTools({
      input: createRunInput(),
      context: createToolContext([], {
        web_search: { enabled: false },
        image_generation: { enabled: false },
      }),
      sdkContext: createSdkContext(),
    });

    expect(tools.map(readToolName)).not.toEqual(expect.arrayContaining([
      "web_search",
      "image_generation",
    ]));
    expect(tools.map(readToolName)).toEqual(expect.arrayContaining([
      "test_tool",
      "knowledge_documents",
      "remember_fact",
      "read_context",
    ]));
  });

  it("pauses function tool invocation when auto approval is disabled", async () => {
    const customTool = tool({
      name: "delta_force_lookup",
      description: "Lookup Delta Force data.",
      parameters: z.object({ q: z.string() }),
      execute() {
        return { ok: true };
      },
    });
    const tools = createOpenAIAgentTools({
      input: createRunInput({
        defaultTools: false,
        memoryTools: false,
        knowledgeTools: false,
        testTool: false,
        customTools: [customTool],
      }),
      context: createToolContext([], {
        custom_tools: { autoApprove: false },
      }),
      sdkContext: createSdkContext(),
    });
    const lookup = findInvokableTool(tools, "delta_force_lookup");

    await expect(lookup.invoke(
      { context: {} } as Parameters<typeof lookup.invoke>[0],
      JSON.stringify({ q: "M7" }),
    )).rejects.toMatchObject({
      name: "WorkflowError",
      type: "user_input_required",
    });
  });

  it("finishes with already streamed text when the Agents SDK response terminal event is malformed", async () => {
    const deltas: string[] = [];
    const result = await runAgentWithStreamingFallback({
      async stream(events) {
        await events.onTextDelta("你好，");
        await events.onTextDelta("世界");
        throw createResponsesStreamOutputMapError();
      },
      async nonStream() {
        throw new Error("non-stream fallback should not run after text was emitted");
      },
    }, {
      async onTextDelta(delta) {
        deltas.push(delta);
      },
    });

    expect(result.finalOutput).toBe("你好，世界");
    expect(deltas).toEqual(["你好，", "世界"]);
  });

  it("finishes with already streamed text even when the SDK throws an unknown error after streaming", async () => {
    // The Windows OpenAI Agents SDK can throw errors that do not
    // match the known Responses stream output shape (e.g. result.completed
    // rejecting after the text stream has finished). The user already saw
    // the assistant's reply in the UI, so the run must end successfully
    // with the streamed text instead of being marked failed.
    const deltas: string[] = [];
    const result = await runAgentWithStreamingFallback({
      async stream(events) {
        await events.onTextDelta("你好！我是三角洲行动数据助手。");
        await events.onTextDelta("可以帮你查装备属性、枪械配装。");
        throw new Error("Some post-stream SDK failure");
      },
      async nonStream() {
        throw new Error("non-stream fallback should not run after text was emitted");
      },
    }, {
      async onTextDelta(delta) {
        deltas.push(delta);
      },
    });

    expect(result.finalOutput).toBe("你好！我是三角洲行动数据助手。可以帮你查装备属性、枪械配装。");
    expect(deltas).toEqual([
      "你好！我是三角洲行动数据助手。",
      "可以帮你查装备属性、枪械配装。",
    ]);
  });

  it("falls back to a non-stream Agents SDK run when streaming fails before text appears", async () => {
    const deltas: string[] = [];
    const result = await runAgentWithStreamingFallback({
      async stream() {
        throw createResponsesStreamOutputMapError();
      },
      async nonStream() {
        return {
          finalOutput: "fallback answer",
          history: [{ role: "user" }, { role: "assistant" }],
          newItems: [],
          usage: {
            requests: 1,
            inputTokens: 2,
            outputTokens: 3,
            totalTokens: 5,
          },
        };
      },
    }, {
      async onTextDelta(delta) {
        deltas.push(delta);
      },
    });

    expect(result.finalOutput).toBe("fallback answer");
    expect(deltas).toEqual(["fallback answer"]);
  });

  it("falls back to non-stream for an unknown streaming error that produces no text", async () => {
    // On Windows the OpenAI Agents SDK can reject streaming for
    // reasons beyond the known Responses stream output error. The fallback
    // must try a non-stream run for ANY streaming failure when no text
    // was emitted yet, instead of throwing the error and marking the run
    // as failed.
    const deltas: string[] = [];
    const result = await runAgentWithStreamingFallback({
      async stream() {
        throw new Error("runner.run() rejected on Windows");
      },
      async nonStream() {
        return {
          finalOutput: "non-stream recovery",
          history: [],
          newItems: [],
        };
      },
    }, {
      async onTextDelta(delta) {
        deltas.push(delta);
      },
    });

    expect(result.finalOutput).toBe("non-stream recovery");
  });

  it("detects the Agents SDK Responses streaming terminal output conversion error", () => {
    expect(isKnownAgentsResponsesStreamOutputError(createResponsesStreamOutputMapError())).toBe(true);
    expect(isKnownAgentsResponsesStreamOutputError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
  });

  it("normalizes provider streams that replay the accumulated text as a delta", () => {
    const chunks = ["你好", "你好！有什么可以帮你？", "你好！有什么可以帮你？"];
    const deltas: string[] = [];
    let text = "";

    for (const chunk of chunks) {
      const normalized = normalizeStreamingTextDelta(text, chunk);
      text = normalized.text;
      if (normalized.delta !== "") {
        deltas.push(normalized.delta);
      }
    }

    expect(deltas).toEqual(["你好", "！有什么可以帮你？"]);
    expect(text).toBe("你好！有什么可以帮你？");
  });

  it("deduplicates short identical chunks (any length, not just >= 8)", () => {
    // The old >= 8 guard was too permissive. A stream that
    // sends the same short chunk twice (e.g. "Hi" then "Hi") should
    // not concatenate them into "HiHi".
    const chunks = ["Hi", "Hi", " there"];
    const deltas: string[] = [];
    let text = "";

    for (const chunk of chunks) {
      const normalized = normalizeStreamingTextDelta(text, chunk);
      text = normalized.text;
      if (normalized.delta !== "") {
        deltas.push(normalized.delta);
      }
    }

    expect(deltas).toEqual(["Hi", " there"]);
    expect(text).toBe("Hi there");
  });

  it("normalizes character-by-character SDK text stream chunks", () => {
    const chars = [..."你好！有什么可以帮你的吗？"];
    const deltas: string[] = [];
    let text = "";

    for (const ch of chars) {
      const normalized = normalizeStreamingTextDelta(text, ch);
      text = normalized.text;
      if (normalized.delta !== "") {
        deltas.push(normalized.delta);
      }
    }

    expect(text).toBe("你好！有什么可以帮你的吗？");
    expect(deltas).toEqual(chars);
  });

  it("streams SDK raw text delta events", async () => {
    const deltas: string[] = [];
    const result = await runAgentStream(createFakeRunner([
      createRawModelStreamEvent("response_started"),
      createRawModelStreamEvent("output_text_delta", { delta: "第一轮回答。" }),
      createRawModelStreamEvent("response_done", { response: { output: [{ type: "message" }] } }),
      createRawModelStreamEvent("response_started"),
      createRawModelStreamEvent("output_text_delta", { delta: "第二轮继续。" }),
      createRawModelStreamEvent("response_done", { response: { output: [{ type: "message" }] } }),
    ]), {
      agent: {} as Agent<any, any>,
      message: "hello",
      context: {},
      signal: undefined,
    }, {
      async onTextDelta(delta) {
        deltas.push(delta);
      },
    });

    expect(deltas).toEqual(["第一轮回答。", "第二轮继续。"]);
    expect(result.finalOutput).toBe("第一轮回答。第二轮继续。");
  });

  it("streams agent-authored tool preamble text from SDK raw events", async () => {
    const deltas: string[] = [];
    const result = await runAgentStream(createFakeRunner([
      createRawModelStreamEvent("response_started"),
      createRawModelStreamEvent("output_text_delta", { delta: "我将调用 knowledge_documents.get 读取刚才创建的文章。" }),
      createRawModelStreamEvent("response_done", { response: { output: [{ type: "message" }] } }),
      createRawModelStreamEvent("response_started"),
      createRawModelStreamEvent("output_text_delta", { delta: "已读取文档，下面是摘要。" }),
      createRawModelStreamEvent("response_done", { response: { output: [{ type: "message" }] } }),
    ]), {
      agent: {} as Agent<any, any>,
      message: "hello",
      context: {},
      signal: undefined,
    }, {
      async onTextDelta(delta) {
        deltas.push(delta);
      },
    });

    expect(deltas).toEqual([
      "我将调用 knowledge_documents.get 读取刚才创建的文章。",
      "已读取文档，下面是摘要。",
    ]);
    expect(result.finalOutput).toBe("我将调用 knowledge_documents.get 读取刚才创建的文章。已读取文档，下面是摘要。");
  });

  it("normalizes accumulated SDK text chunks into deltas", async () => {
    const deltas: string[] = [];
    const result = await runAgentStream(createFakeRunner([
      createRawModelStreamEvent("response_started"),
      createRawModelStreamEvent("output_text_delta", { delta: "你好" }),
      createRawModelStreamEvent("output_text_delta", { delta: "你好！有什么可以帮你？" }),
      createRawModelStreamEvent("output_text_delta", { delta: "你好！有什么可以帮你？" }),
      createRawModelStreamEvent("response_done", { response: { output: [{ type: "message" }] } }),
    ]), {
      agent: {} as Agent<any, any>,
      message: "hello",
      context: {},
      signal: undefined,
    }, {
      async onTextDelta(delta) {
        deltas.push(delta);
      },
    });

    expect(deltas).toEqual(["你好", "！有什么可以帮你？"]);
    expect(result.finalOutput).toBe("你好！有什么可以帮你？");
  });

  it("stops after a streamed text response when compatible endpoints finish with empty output", async () => {
    const deltas: string[] = [];
    const result = await runAgentStream(createFakeRunner([
      createRawModelStreamEvent("response_started"),
      createRawModelStreamEvent("output_text_delta", { delta: "你好！有什么我可以帮你的吗？" }),
      createRawModelStreamEvent("response_done", { response: { output: [] } }),
      createRawModelStreamEvent("response_started"),
      createRawModelStreamEvent("output_text_delta", { delta: "你好！有什么我可以帮你的吗？" }),
      createRawModelStreamEvent("response_done", { response: { output: [] } }),
    ]), {
      agent: {} as Agent<any, any>,
      message: "hello",
      context: {},
      signal: undefined,
    }, {
      async onTextDelta(delta) {
        deltas.push(delta);
      },
    });

    expect(deltas).toEqual(["你好！有什么我可以帮你的吗？"]);
    expect(result.finalOutput).toBe("你好！有什么我可以帮你的吗？");
  });

  it("keeps an empty-output text preamble when the next response resolves to tool output", async () => {
    const deltas: string[] = [];
    const result = await runAgentStream(createFakeRunner([
      createRawModelStreamEvent("response_started"),
      createRawModelStreamEvent("output_text_delta", { delta: "我将调用 knowledge_documents.get 读取刚才创建的文章。" }),
      createRawModelStreamEvent("response_done", { response: { output: [] } }),
      createRawModelStreamEvent("response_started"),
      createRawModelStreamEvent("response_done", { response: { output: [{ type: "function_call", name: "knowledge_documents" }] } }),
      createRawModelStreamEvent("response_started"),
      createRawModelStreamEvent("output_text_delta", { delta: "已读取文档，下面是摘要。" }),
      createRawModelStreamEvent("response_done", { response: { output: [{ type: "message" }] } }),
    ]), {
      agent: {} as Agent<any, any>,
      message: "hello",
      context: {},
      signal: undefined,
    }, {
      async onTextDelta(delta) {
        deltas.push(delta);
      },
    });

    expect(deltas).toEqual([
      "我将调用 knowledge_documents.get 读取刚才创建的文章。",
      "已读取文档，下面是摘要。",
    ]);
    expect(result.finalOutput).toBe("我将调用 knowledge_documents.get 读取刚才创建的文章。已读取文档，下面是摘要。");
  });
});

function createRunInput(overrides: Partial<OpenAIAgentsRunInput> = {}): OpenAIAgentsRunInput {
  return {
    message: "hello",
    model: "gpt-5.4",
    workdir: ".",
    localShell: false,
    agentName: "steamharness-openai-agents",
    instructions: [],
    defaultTools: true,
    memoryTools: true,
    knowledgeTools: true,
    testTool: true,
    writeConversation: true,
    writeAgentState: true,
    customTools: [],
    conversation: createConversationSnapshot(),
    runCount: 1,
    facts: [],
    ...overrides,
  };
}

function createSdkContext() {
  return {
    workflowName: "openai-agents",
    conversationId: "thread",
    messages: [],
    runCount: 1,
    message: "hello",
    workdir: ".",
    facts: [] as AgentFact[],
  };
}

function createConversationSnapshot(): ConversationSnapshot {
  return {
    conversationId: "thread",
    messages: [],
  };
}

function createToolContext(
  toolEvents: AgentToolCallSummary[],
  policies: Record<string, { enabled?: boolean; autoApprove?: boolean }> = {},
  resolvedInput?: {
    requestId: string;
    nodeName: string;
    values: Record<string, unknown>;
    submittedAt: Date;
  },
) {
  const persistentValue = createMemoryKVContext();
  return {
    storage: {
      local: {
        kv: {
          conversation: {
            async getValue() {
              return undefined;
            },
            async setValue() {},
          },
        },
        persistentValue,
        relatedProjects: createWorkflowRelatedProjectsContext(),
      },
    },
    conversation: {
      async getValue() {
        return {
          conversationId: "thread",
          messages: [],
        };
      },
      async appendMessage() {},
      async setTitle() {},
    },
    tokenUsage: {
      async report() {},
    },
    userInput: {
      async getResolvedInput() {
        return resolvedInput;
      },
      async requestInput() {},
    },
    toolPermissions: createWorkflowToolPermissionContext({
      workflowName: "openai-agents",
      runId: "openai-agents-test-run",
      definitions: [
        { name: "web_search", enabled: true, autoApprove: true },
        { name: "image_generation", enabled: true, autoApprove: true },
        { name: "local_shell", enabled: true, autoApprove: true },
        { name: "test_tool", enabled: true, autoApprove: true },
        { name: "knowledge_documents", enabled: true, autoApprove: true },
        { name: "remember_fact", enabled: true, autoApprove: true },
        { name: "read_context", enabled: true, autoApprove: true },
        { name: "custom_tools", enabled: true, autoApprove: true },
      ],
      policies,
    }),
    toolEvents,
  };
}

function createOpenAIAgentsContext(options: {
  onChunk?: (event: NodeExecutionHookChunkEvent) => void;
  tokenUsageEnabled?: boolean;
} = {}): WorkflowContext {
  const kv = createMemoryKVContext();
  const persistentValue = createMemoryKVContext();
  const tokenUsage = options.tokenUsageEnabled === true
    ? createWorkflowTokenUsageContext({
      definition: { enabled: true, display: true },
      kv,
      projectId: "1e43f54c-f4eb-431f-8033-dc2bf0c19903",
      runId: "openai-agents-test-run",
      conversationId: "stream-thread",
    })
    : createDisabledWorkflowTokenUsageContext();

  return {
    providers: {},
    storage: {
      local: {
        kv,
        persistentValue,
        relatedProjects: createWorkflowRelatedProjectsContext(),
      },
      server: {
        kv: createMemoryKVContext(),
        persistentValue: createMemoryKVContext(),
        relatedProjects: createWorkflowRelatedProjectsContext(),
      },
    },
    conversation: createWorkflowConversationContext({
      enabled: true,
      conversationId: "stream-thread",
      workflowName: "openai-agents",
      kv,
    }),
    tokenUsage,
    nodeHooks: {
      onNodeChunk: options.onChunk,
    },
  };
}

function createMemoryKVContext(): WorkflowKVContext {
  const values = new Map<string, unknown>();

  function createNamespace(prefix: string) {
    let pending = Promise.resolve();
    return {
      async getValue(key: string) {
        return values.get(`${prefix}:${key}`);
      },
      async setValue(key: string, value: unknown) {
        values.set(`${prefix}:${key}`, value);
      },
      async updateValue(key: string, updater: (current: unknown | undefined) => unknown) {
        const next = updater(values.get(`${prefix}:${key}`));
        values.set(`${prefix}:${key}`, next);
        return next;
      },
      async withLock<T>(operation: () => Promise<T> | T): Promise<T> {
        const previous = pending;
        let release!: () => void;
        pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await operation();
        } finally {
          release();
        }
      },
    };
  }

  const project = createNamespace("project");

  return {
    getValue: project.getValue,
    setValue: project.setValue,
    updateValue: project.updateValue,
    withLock: project.withLock,
    conversation: createNamespace("conversation"),
  };
}

function readToolName(tool: unknown): string {
  if (typeof tool === "object" && tool !== null && "name" in tool) {
    return String((tool as { name?: unknown }).name);
  }

  return "";
}

function findInvokableTool(tools: unknown[], name: string): {
  invoke(runContext: unknown, rawInput: string): Promise<unknown> | unknown;
} {
  const found = tools.find((candidate) =>
    typeof candidate === "object" &&
    candidate !== null &&
    "type" in candidate &&
    candidate.type === "function" &&
    "name" in candidate &&
    candidate.name === name &&
    "invoke" in candidate &&
    typeof candidate.invoke === "function"
  );
  if (found === undefined) {
    throw new Error(`${name} was not registered`);
  }
  return found as {
    invoke(runContext: unknown, rawInput: string): Promise<unknown> | unknown;
  };
}

function parseToolOutput(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function* createDelayedChunks(chunks: string[], delayMs: number): AsyncIterable<string> {
  for (const chunk of chunks) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield chunk;
  }
}

function createFakeRunner(events: unknown[]) {
  return {
    async run() {
      return createFakeStreamedRunResult(events);
    },
  };
}

function createFakeStreamedRunResult(events: unknown[]) {
  return {
    finalOutput: "",
    lastResponseId: "resp_fake",
    newItems: [],
    history: [],
    runContext: {
      usage: {
        requests: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    },
    completed: Promise.resolve(),
    toTextStream() {
      throw new Error("toTextStream should not be used in raw-event stream tests");
    },
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function createRawModelStreamEvent(
  type: string,
  data: Record<string, unknown> = {},
) {
  return {
    type: "raw_model_stream_event",
    data: {
      type,
      ...data,
    },
  };
}

function createRunItemStreamEvent(name: string, item: unknown) {
  return {
    type: "run_item_stream_event",
    name,
    item,
  };
}

function isRunItemToolCalledEvent(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    (value as { type?: unknown }).type === "run_item_stream_event" &&
    (value as { name?: unknown }).name === "tool_called" &&
    typeof (value as { item?: unknown }).item === "object" &&
    (value as { item?: unknown }).item !== null &&
    ((value as { item: { rawItem?: { name?: unknown } } }).item.rawItem?.name === "knowledge_documents");
}

function isOutputDelta(value: unknown): value is {
  type: "output_item_delta";
  itemId: string;
  delta: string;
} {
  return typeof value === "object" && value !== null &&
    (value as { type?: unknown }).type === "output_item_delta" &&
    typeof (value as { delta?: unknown }).delta === "string";
}

function isOutputStart(value: unknown): value is {
  type: "output_item_start";
  item: {
    id?: string;
  };
} {
  return typeof value === "object" && value !== null &&
    (value as { type?: unknown }).type === "output_item_start" &&
    typeof (value as { item?: unknown }).item === "object" &&
    (value as { item?: unknown }).item !== null;
}

function isOutputEnd(value: unknown): value is {
  type: "output_item_end";
  itemId: string;
} {
  return typeof value === "object" && value !== null &&
    (value as { type?: unknown }).type === "output_item_end" &&
    typeof (value as { itemId?: unknown }).itemId === "string";
}

function createResponsesStreamOutputMapError(): TypeError {
  const error = new TypeError("Cannot read properties of undefined (reading 'map')");
  error.stack = [
    "TypeError: Cannot read properties of undefined (reading 'map')",
    "    at convertToOutputItem (/mock/node_modules/@openai/agents-openai/src/openaiResponsesModel.ts:2452:16)",
    "    at OpenAIResponsesModel.getStreamedResponse (/mock/node_modules/@openai/agents-openai/src/openaiResponsesModel.ts:3176:23)",
  ].join("\n");
  return error;
}
