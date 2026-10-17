import { describe, expect, it } from "vitest";
import {
  OpenAIProtocolError,
  assertOpenAIStatusTransition,
  assertUniqueOpenAIMessageItemIds,
  createOpenAIConversationResource,
  createOpenAIErrorBody,
  createOpenAIProjectKey,
  createOpenAIResponseResource,
  createOpenAITextStreamEventFactory,
  extractOpenAIBearerToken,
  extractOpenAIOutputText,
  formatOpenAISseEvent,
  hashOpenAIProjectKey,
  isOpenAIConversationHostInput,
  mapOpenAIFinishReasonToIncompleteReason,
  paginateOpenAIResources,
  parseOpenAIConversationCreateRequest,
  parseOpenAIConversationItemsRequest,
  parseOpenAIConversationUpdateRequest,
  parseOpenAIPageQuery,
  parseOpenAIResponseCreateRequest,
} from "@workflow-code/openai-responses";

describe("openai-responses package", () => {
  it("parses the supported Responses request subset", () => {
    const request = parseOpenAIResponseCreateRequest({
      model: "gpt-test",
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "  Describe this  " },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      }],
      instructions: "  Be concise  ",
      temperature: 0.2,
      top_p: 0.9,
      max_output_tokens: 256,
      text: { format: { type: "text" }, verbosity: "high" },
      include: ["reasoning.encrypted_content"],
      metadata: { trace: "demo" },
    });
    expect(request).toMatchObject({
      model: "gpt-test",
      store: true,
      stream: false,
      background: false,
      instructions: "  Be concise  ",
      text: { format: { type: "text" }, verbosity: "high" },
      include: ["reasoning.encrypted_content"],
    });
    expect(responseInputText(request.input)).toBe("  Describe this  ");
  });

  it("accepts the standard Cherry Studio text request shape", () => {
    const request = parseOpenAIResponseCreateRequest({
      model: "gpt-5.6-sol",
      input: [
        { role: "developer", content: "默认用中文回复" },
        { role: "user", content: [{ type: "input_text", text: "你好" }] },
      ],
      text: { verbosity: "high" },
      include: ["reasoning.encrypted_content"],
      store: false,
      stream: true,
    });

    expect(request).toMatchObject({
      text: { format: { type: "text" }, verbosity: "high" },
      include: ["reasoning.encrypted_content"],
      input: [
        { role: "developer", content: [{ type: "input_text", text: "默认用中文回复" }] },
        { role: "user", content: [{ type: "input_text", text: "你好" }] },
      ],
    });
  });

  it("rejects unsupported fields, invalid state combinations, and unsafe input shapes", () => {
    expect(() => parseOpenAIResponseCreateRequest({ model: "gpt-test", input: "hello", tools: [] }))
      .toThrowError(/Unknown parameter/u);
    expect(() => parseOpenAIResponseCreateRequest({ model: "gpt-test", input: "hello", stream: true, background: true }))
      .toThrowError(/background streaming/u);
    expect(() => parseOpenAIResponseCreateRequest({
      model: "gpt-test",
      input: [{ role: "assistant", content: "hello" }],
    })).toThrowError(/user text or an image/u);
    expect(() => parseOpenAIResponseCreateRequest({
      model: "gpt-test",
      input: [{ role: "user", content: [{ type: "input_image", image_url: "file:///tmp/a.png" }] }],
    })).toThrowError(/HTTP or HTTPS/u);
    expect(() => parseOpenAIResponseCreateRequest({
      model: "gpt-test",
      input: "hello",
      conversation: {},
    })).toThrowError(expect.objectContaining({
      code: "missing_required_parameter",
      param: "conversation.id",
    }));
    expect(() => parseOpenAIResponseCreateRequest({
      model: "gpt-test",
      input: "hello",
      text: { format: { type: "json_schema" } },
    })).toThrowError(expect.objectContaining({
      code: "unsupported_text_format",
      param: "text.format.type",
    }));
    expect(() => parseOpenAIResponseCreateRequest({
      model: "gpt-test",
      input: "hello",
      include: ["message.output_text.logprobs"],
    })).toThrowError(expect.objectContaining({
      code: "unsupported_include",
      param: "include[0]",
    }));
  });

  it("accepts response input with user content before a trailing assistant message", () => {
    expect(parseOpenAIResponseCreateRequest({
      model: "gpt-test",
      input: [
        { role: "user", content: "question" },
        { role: "assistant", content: "draft answer" },
      ],
    }).input).toMatchObject([
      { role: "user" },
      { role: "assistant" },
    ]);
  });

  it("rejects duplicate message item ids within requests and against reserved history", () => {
    expect(() => parseOpenAIResponseCreateRequest({
      model: "gpt-test",
      input: [
        { id: "msg_duplicate", role: "user", content: "first" },
        { id: "msg_duplicate", role: "assistant", content: "second" },
      ],
    })).toThrowError(expect.objectContaining({
      code: "duplicate_item_id",
      param: "input[1].id",
    }));

    expect(() => assertUniqueOpenAIMessageItemIds(
      [{
        id: "msg_existing",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "next" }],
      }],
      "input",
      ["msg_existing"],
    )).toThrowError(expect.objectContaining({
      code: "duplicate_item_id",
      param: "input[0].id",
    }));
  });

  it("creates SDK-shaped resources, project keys, and SSE frames", () => {
    const request = parseOpenAIResponseCreateRequest({ model: "gpt-test", input: "hello" });
    const response = createOpenAIResponseResource({
      id: "resp_demo",
      request,
      status: "completed",
      outputText: "world",
      outputItemId: "msg_demo",
      usage: { input_tokens: 2, output_tokens: 1 },
    });
    expect(response.object).toBe("response");
    expect(response.completed_at).toEqual(expect.any(Number));
    expect(response.output[0]).toMatchObject({ id: "msg_demo", role: "assistant", status: "completed" });
    expect(response.usage?.total_tokens).toBe(3);
    expect(response.text).toEqual({ format: { type: "text" } });
    expect(extractOpenAIOutputText(response)).toBe("world");
    expect(createOpenAIConversationResource({ id: "conv_demo" })).toMatchObject({ id: "conv_demo", object: "conversation" });
    expect(createOpenAIProjectKey()).toMatchObject({ token: expect.stringMatching(/^wfpk_/u), prefix: expect.stringMatching(/^wfpk_/u) });
    expect(formatOpenAISseEvent({ type: "response.output_text.delta", delta: "x" }))
      .toBe("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\n\n");
  });

  it("parses conversation requests without imposing response input ordering", () => {
    expect(parseOpenAIConversationCreateRequest(undefined)).toEqual({ items: [], metadata: {} });
    expect(parseOpenAIConversationCreateRequest(null)).toEqual({ items: [], metadata: {} });
    expect(parseOpenAIConversationCreateRequest({ items: null })).toEqual({ items: [], metadata: {} });
    expect(parseOpenAIConversationCreateRequest({
      items: [{ role: "assistant", content: "prior answer" }],
      metadata: { topic: "demo" },
    })).toMatchObject({ metadata: { topic: "demo" }, items: [{ role: "assistant" }] });
    expect(parseOpenAIConversationItemsRequest({
      items: [{ role: "user", content: "follow up" }],
    }).items).toHaveLength(1);
    expect(parseOpenAIConversationUpdateRequest({ metadata: {} })).toEqual({ metadata: {} });
    expect(() => parseOpenAIConversationUpdateRequest({})).toThrow(/metadata is required/u);
  });

  it("limits Conversation create and append requests to 20 items", () => {
    const items = Array.from({ length: 21 }, () => ({ role: "user" as const, content: "message" }));
    expect(() => parseOpenAIConversationCreateRequest({ items })).toThrow(/at most 20 items/u);
    expect(() => parseOpenAIConversationItemsRequest({ items })).toThrow(/at most 20 items/u);
  });

  it("hashes and extracts project-scoped bearer keys", async () => {
    const key = createOpenAIProjectKey();
    expect(extractOpenAIBearerToken(`Bearer ${key.token}`)).toBe(key.token);
    expect(await hashOpenAIProjectKey(key.token)).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => extractOpenAIBearerToken("Basic abc")).toThrowError(OpenAIProtocolError);
  });

  it("accepts OpenAI host input used for full run persistence", () => {
    const hostInput = {
      kind: "openai.responses",
      requestId: "req_test",
      responseId: "resp_test",
      projectId: "project-test",
      model: "gpt-test",
      messages: [],
      settings: {},
    };
    expect(isOpenAIConversationHostInput(hostInput)).toBe(true);
    expect(isOpenAIConversationHostInput({
      ...hostInput,
      settings: null,
    })).toBe(false);
  });

  it("creates the standard text streaming event sequence", () => {
    const request = parseOpenAIResponseCreateRequest({ model: "gpt-test", input: "hello", stream: true });
    const pending = createOpenAIResponseResource({ id: "resp_stream", request, status: "in_progress" });
    const events = createOpenAITextStreamEventFactory({ response: pending, outputItemId: "msg_stream" });
    expect(events.created().map((event) => event.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
    ]);
    expect(events.delta("hi")).toMatchObject({ type: "response.output_text.delta", sequence_number: 4, delta: "hi" });
    const completed = createOpenAIResponseResource({
      id: pending.id,
      request,
      status: "completed",
      outputText: "hi",
      outputItemId: "msg_stream",
    });
    expect(events.completed(completed, "hi").map((event) => event.type)).toEqual([
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
  });

  it("maps truncated output to an incomplete resource and terminal SSE event", () => {
    const request = parseOpenAIResponseCreateRequest({
      model: "gpt-test",
      input: "hello",
      max_output_tokens: 1,
      stream: true,
    });
    const pending = createOpenAIResponseResource({ id: "resp_incomplete", request, status: "in_progress" });
    const events = createOpenAITextStreamEventFactory({ response: pending, outputItemId: "msg_incomplete" });
    const incomplete = createOpenAIResponseResource({
      id: pending.id,
      request,
      status: "incomplete",
      outputText: "partial",
      outputItemId: "msg_incomplete",
      incompleteReason: mapOpenAIFinishReasonToIncompleteReason("length"),
    });

    expect(incomplete).toMatchObject({
      status: "incomplete",
      completed_at: null,
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ status: "incomplete" }],
    });
    expect(events.incomplete(incomplete, "partial").map((event) => event.type)).toEqual([
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.incomplete",
    ]);
    expect(mapOpenAIFinishReasonToIncompleteReason("content-filter")).toBe("content_filter");
    expect(mapOpenAIFinishReasonToIncompleteReason("stop")).toBeUndefined();
  });

  it("paginates resources and validates query values", () => {
    const values = [{ id: "msg_1" }, { id: "msg_2" }, { id: "msg_3" }];
    expect(paginateOpenAIResources(values, { order: "asc", after: "msg_1", limit: 1 })).toEqual({
      object: "list",
      data: [{ id: "msg_2" }],
      first_id: "msg_2",
      last_id: "msg_2",
      has_more: true,
    });
    expect(parseOpenAIPageQuery({ limit: "10", order: "asc" })).toEqual({ limit: 10, order: "asc", after: undefined });
    try {
      paginateOpenAIResources(values, { after: "msg_missing" });
      throw new Error("Expected invalid cursor error.");
    } catch (error) {
      expect(error).toMatchObject({
        status: 400,
        type: "invalid_request_error",
        param: "after",
        code: "invalid_cursor",
      });
    }
  });

  it("only assigns completed_at to completed responses", () => {
    const request = parseOpenAIResponseCreateRequest({ model: "gpt-test", input: "hello" });
    for (const status of ["queued", "in_progress", "failed", "cancelled", "incomplete"] as const) {
      expect(createOpenAIResponseResource({ request, status }).completed_at).toBeNull();
    }
    expect(createOpenAIResponseResource({ request, status: "completed" }).completed_at)
      .toEqual(expect.any(Number));
  });

  it("enforces response state transitions and serializes errors", () => {
    expect(() => assertOpenAIStatusTransition("queued", "in_progress")).not.toThrow();
    expect(() => assertOpenAIStatusTransition("completed", "in_progress")).toThrow(/Invalid OpenAI response status/u);
    const error = new OpenAIProtocolError({ message: "bad", param: "input", code: "invalid_value" });
    expect(createOpenAIErrorBody(error)).toEqual({
      error: { message: "bad", type: "invalid_request_error", param: "input", code: "invalid_value" },
    });
  });
});

function responseInputText(input: ReturnType<typeof parseOpenAIResponseCreateRequest>["input"]): string | undefined {
  if (typeof input === "string") return input;
  const part = input[0]?.content[0];
  return part && "text" in part ? part.text : undefined;
}
