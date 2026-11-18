import type { LLMProviderType } from "../../provider/llm/factory";

const sse = (value: Record<string, unknown>) => `${value.type ? `event: ${value.type}\n` : ""}data: ${JSON.stringify(value)}\n\n`;

export function llmFrames(type: LLMProviderType, text = "hello", complete = true): string[] {
  if (type === "openai-completion") {
    const base = { id: "chatcmpl_test", model: "test-model", object: "chat.completion.chunk" };
    const choices = (delta: object, finish_reason: string | null = null) => [{ index: 0, delta, finish_reason }];
    return [sse({ ...base, choices: choices({ role: "assistant", content: text }) }),
      ...(complete ? [sse({ ...base, choices: choices({}, "stop") }),
        sse({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 2 } } }), "data: [DONE]\n\n"] : [])];
  }
  if (type === "openai-responses") {
    const item = { id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    return [
      { type: "response.created", response: { id: "resp_test", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
      ...(complete ? [{ type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_test", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 2 } } } }] : []),
    ].map(sse);
  }
  return [
    { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "test-model", content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, cache_read_input_tokens: 2, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ...(complete ? [{ type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: "message_stop" }] : []),
  ].map(sse);
}

export function llmSSE(type: LLMProviderType, text?: string, complete?: boolean): Response {
  return new Response(llmFrames(type, text, complete).join(""), { headers: { "content-type": "text/event-stream" } });
}

export function llmToolSSE(type: LLMProviderType, name: string, args = {}, id = "call_1", complete = true): Response {
  const argumentsJson = JSON.stringify(args);
  const itemId = `fc_${id}`;
  const item = { id: itemId, type: "function_call", call_id: id, name, arguments: argumentsJson, status: "completed" };
  const frames = type === "openai-responses" ? [
    { type: "response.created", response: { id: "resp_tool", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: itemId, output_index: 0, delta: argumentsJson },
    ...(complete ? [
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_tool", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } },
    ] : []),
  ].map(sse) : type === "anthropic" ? [
    { type: "message_start", message: { id: "msg_tool", type: "message", role: "assistant", model: "test-model", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: argumentsJson } },
    ...(complete ? [
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ] : []),
  ].map(sse) : [
    sse({ id: "chatcmpl_tool", model: "test-model", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: argumentsJson } }] }, finish_reason: null }] }),
    ...(complete ? [
      sse({ id: "chatcmpl_tool", model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      sse({ id: "chatcmpl_tool", model: "test-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }),
      "data: [DONE]\n\n",
    ] : []),
  ];
  return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
}
