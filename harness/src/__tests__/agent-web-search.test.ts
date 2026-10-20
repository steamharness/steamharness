import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createPiRuntime, type AgentApiKind } from "../agent/pi";
import { createAgentRuntime, parseAgentInput } from "../agent/runtime";
import { parseAgentModelAttributes } from "../agent/model-attributes";
import { toAgentModelAttributes } from "../agent/system-llm";
import { DEFAULT_AGENT_COMPACTION_SETTINGS } from "../agent/compaction";
import { type AgentSearchMessage, resolveAgentWebSearch } from "../agent/web-search";
import type { AgentStreamEvent } from "../agent/types";

type Json = Record<string, any>;
const SOURCE = "https://example.test/source";
const ANSWER = "A sourced answer.";
const apis = ["openai-responses", "anthropic-messages"] as const;
const attributes = { reasoning: false, input: ["text"] as const, contextWindow: 100_000, maxTokens: 1024, webSearch: true };
const input = (prompt: string, requestId: string) => ({ prompt, requestId, errCode: 0, errMessage: "" });

function events(api: AgentApiKind, id = "first", search = true, failed = false): Json[] {
  if (api === "openai-responses") {
    const native = { id: `ws_${id}`, type: "web_search_call", status: failed ? "failed" : "completed",
      action: { type: "search", query: "Latest release", sources: [{ type: "url", url: SOURCE, title: "Release notes" }] } };
    const message = { id: `msg_${id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: ANSWER,
      annotations: search ? [{ type: "url_citation", url: SOURCE, title: "Release notes", start_index: 0, end_index: ANSWER.length }] : [] }] };
    const output = [...(search ? [native] : []), message];
    return [{ type: "response.created", response: { id: `resp_${id}`, status: "in_progress" } },
      ...(search ? [{ type: "response.output_item.added", output_index: 0, item: { ...native, status: "in_progress" } },
        { type: "response.output_item.done", output_index: 0, item: native }] : []),
      { type: "response.output_item.added", output_index: search ? 1 : 0, item: { ...message, content: [] } },
      { type: "response.output_text.delta", output_index: search ? 1 : 0, content_index: 0, delta: ANSWER },
      { type: "response.output_item.done", output_index: search ? 1 : 0, item: message },
      { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output,
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } }];
  }
  return [{ type: "message_start", message: { id: `msg_${id}`, type: "message", role: "assistant", model: "search-model", content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
  ...(search ? [
    { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: `srv_${id}`, name: "web_search", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"Latest release"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: `srv_${id}`,
      content: failed ? { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" }
        : [{ type: "web_search_result", url: SOURCE, title: "Release notes", encrypted_content: "opaque-provider-search-data", page_age: null }] } },
    { type: "content_block_stop", index: 1 },
  ] : []),
  { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: ANSWER } },
  ...(search && !failed ? [{ type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: {
    type: "web_search_result_location", url: SOURCE, title: "Release notes", cited_text: "release", encrypted_index: "opaque-index" } } }] : []),
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
  { type: "message_stop" }];
}

function sse(stream: Json[]): string {
  return stream.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
async function runtime(api: AgentApiKind, webSearch?: boolean) {
  return createPiRuntime({ provider: "search-test", model: "search-model", apiKey: "offline-key",
    baseUrl: "http://127.0.0.1:9", apiKind: api, modelAttributes: attributes, webSearch });
}

test("catalogue search capabilities reach agent attributes, with validated per-run overrides", () => {
  assert.equal(toAgentModelAttributes({ id: "search-model", name: "Search", capabilities: {
    vision: false, reasoning: false, toolCalling: true, webSearch: true } })?.webSearch, true);
  assert.deepEqual(parseAgentModelAttributes({ webSearch: true }), { webSearch: true });
  assert.throws(() => parseAgentModelAttributes({ webSearch: "yes" }), /webSearch/);
  assert.equal(resolveAgentWebSearch("openai-responses", undefined, true), true);
  assert.equal(resolveAgentWebSearch("anthropic-messages", false, true), false);
  assert.equal(resolveAgentWebSearch("openai-responses", undefined, undefined), false);
  assert.equal(resolveAgentWebSearch("openai-responses", true, undefined), true);
  assert.throws(() => resolveAgentWebSearch("openai-completions", true, true), /Responses or Anthropic/);
  assert.throws(() => resolveAgentWebSearch("openai-responses", true, false), /does not support/);
  assert.throws(() => parseAgentInput({ ...input("Hi", "input"), webSearch: "true" as never }, {}), /boolean/);
  assert.equal(parseAgentInput({ ...input("Hi", "input"), webSearch: false }, { webSearch: true }).webSearch, false);
});

test("custom Anthropic endpoints infer their actual protocol when search is enabled", async () => {
  const pi = await createPiRuntime({ provider: "anthropic", model: "search-model", apiKey: "offline-key",
    baseUrl: "http://127.0.0.1:9", modelAttributes: attributes });
  let body: Json | undefined;
  await pi.models.streamSimple(pi.model, { messages: [{ role: "user", content: "Search", timestamp: 0 }] }, {
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(sse(events("anthropic-messages")), { headers: { "content-type": "text/event-stream" } });
    },
  }).result();
  assert.ok(body?.tools.some((tool: Json) => tool.type === "web_search_20250305"));
});

for (const api of apis) {
  test(`${api} adds native search beside local tools, preserves citations, and replays it when search is disabled`, async () => {
    const pi = await runtime(api);
    const requests: Json[] = [];
    const updates: Json[] = [];
    let rawEvents = 0;
    const options = {
      maxRetries: 0,
      onPayload: (payload: unknown) => ({ ...(payload as Json), metadata: { test: "kept" } }),
      onProviderStreamEvent: () => { rawEvents++; },
      onAgentWebSearch: (search: Json) => { updates.push(search); },
      fetch: async (_url: unknown, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(sse(events(api, requests.length === 1 ? "first" : "second", requests.length === 1)), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    };
    const first = await pi.models.streamSimple(pi.model, { messages: [{ role: "user", content: "Search", timestamp: 0 }],
      tools: [{ name: "read", description: "Read local file", parameters: { type: "object", properties: {} } }] }, options).result() as AgentSearchMessage;
    assert.equal(first.stopReason, "stop", first.errorMessage);
    assert.equal(first.content.filter(block => block.type === "text").map(block => block.text).join(""), ANSWER);
    assert.equal(requests[0]!.tools.filter((tool: Json) => tool.type?.startsWith("web_search")).length, 1);
    assert.ok(requests[0]!.tools.some((tool: Json) => tool.name === "read"));
    assert.deepEqual(requests[0]!.metadata, { test: "kept" });
    assert.ok(rawEvents > 0);
    assert.equal(updates[0]?.status, "running");
    assert.equal(updates.at(-1)?.status, "success");
    assert.equal(updates.at(-1)?.query, "Latest release");
    assert.equal(first.projectWebSearch?.sources[0]?.url, SOURCE);
    assert.equal(first.content.some(block => block.type === "toolCall"), false, "Provider search is not a local tool call");
    const disabled = await runtime(api, false);
    await disabled.models.streamSimple(disabled.model, { messages: [{ role: "user", content: "Search", timestamp: 0 }, first,
      { role: "user", content: "Follow up", timestamp: 1 }] }, options).result();
    assert.equal((requests[1]!.tools ?? []).some((tool: Json) => tool.type?.startsWith("web_search")), false);
    if (api === "openai-responses") {
      assert.ok(requests[0]!.include.includes("web_search_call.action.sources"));
      assert.equal(requests[1]!.input.filter((item: Json) => item.type === "web_search_call").length, 1);
      assert.equal(requests[1]!.input.find((item: Json) => item.id === "msg_first").content[0].annotations[0].url, SOURCE);
    } else {
      const saved = requests[1]!.messages.find((message: Json) => message.role === "assistant").content;
      assert.deepEqual(saved.map((block: Json) => block.type), ["server_tool_use", "web_search_tool_result", "text"]);
      assert.deepEqual(saved[0].input, { query: "Latest release" });
      assert.equal(saved[1].content[0].encrypted_content, "opaque-provider-search-data");
      assert.equal(saved[2].citations[0].url, SOURCE);
    }
  });

  test(`${api} reports native search failures without executing a local tool`, async () => {
    const pi = await runtime(api);
    const result = await pi.models.streamSimple(pi.model, { messages: [{ role: "user", content: "Search", timestamp: 0 }] }, {
      fetch: async () => new Response(sse(events(api, "failed", true, true)), { headers: { "content-type": "text/event-stream" } }),
    }).result() as AgentSearchMessage;
    assert.equal(result.projectWebSearch?.searches[0]?.status, "failed");
    assert.ok(result.projectWebSearch?.searches[0]?.error);
    assert.equal(result.content.some(block => block.type === "toolCall"), false);
  });

  test(`${api} durable runtime emits search and sources and restores provider history from SQLite`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-search-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const requests: Json[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(events(api, String(requests.length), requests.length === 1)));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const options = { provider: "search-test", model: "search-model", apiKey: "offline-key", apiKind: api,
      baseUrl: `http://127.0.0.1:${address.port}`, modelAttributes: attributes, effort: "off" as const,
      workdir: directory, databasePath: path.join(directory, "agent.sqlite"), compaction: { ...DEFAULT_AGENT_COMPACTION_SETTINGS, enabled: false } };
    const first = await createAgentRuntime(options);
    t.after(() => first.close());
    const emitted: AgentStreamEvent[] = [];
    for await (const event of first.run(input("Search", "first"))) emitted.push(event);
    assert.ok(emitted.some(event => event.type === "web_search" && event.search.status === "running"));
    assert.ok(emitted.some(event => event.type === "web_search" && event.search.status === "success"));
    assert.ok(emitted.some(event => event.type === "sources" && event.sources[0]?.url === SOURCE));
    assert.equal(emitted.filter(event => event.type === "text_delta").map(event => event.delta).join(""), ANSWER);
    await first.close();
    const reopened = await createAgentRuntime({ ...options, webSearch: false });
    t.after(() => reopened.close());
    for await (const _event of reopened.run(input("Follow up", "second"))) { /* drain */ }
    assert.equal(requests.length, 2);
    assert.equal((requests[1]!.tools ?? []).some((tool: Json) => tool.type?.startsWith("web_search")), false);
    assert.match(JSON.stringify(api === "openai-responses" ? requests[1]!.input : requests[1]!.messages), /web_search_call|web_search_tool_result/);
    assert.ok(reopened.readTranscript?.().some(message => message.role === "assistant" && (message as AgentSearchMessage).projectWebSearch?.sources[0]?.url === SOURCE));
    for await (const _event of reopened.run({ ...input("Search again", "third"), webSearch: true })) { /* drain */ }
    assert.ok(requests[2]!.tools.some((tool: Json) => tool.type?.startsWith("web_search")), "Per-run changes enable search without losing history");
  });
}

async function localAgent(t: TestContext, respond: (attempt: number) => Json[]) {
  const requests: Json[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse(respond(requests.length)));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const agent = await createAgentRuntime({ provider: "search-test", model: "search-model", apiKey: "offline-key",
    apiKind: "anthropic-messages", baseUrl: `http://127.0.0.1:${address.port}`, modelAttributes: attributes,
    effort: "off", compaction: { ...DEFAULT_AGENT_COMPACTION_SETTINGS, enabled: false } });
  t.after(() => agent.close());
  return { agent, requests };
}

function paused(id: string): Json[] {
  return events("anthropic-messages", id).filter(event => event.index !== 2).map(event => event.type === "message_delta"
    ? { ...event, delta: { stop_reason: "pause_turn" } } : event);
}

test("Anthropic search-only pause turns resume with the original native blocks and no synthetic user prompt", async t => {
  const { agent, requests } = await localAgent(t, attempt => attempt === 1 ? paused("pause") : events("anthropic-messages", "answer", false));
  const output: AgentStreamEvent[] = [];
  for await (const event of agent.run(input("Search", "pause"))) output.push(event);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.messages.at(-1).role, "assistant");
  assert.deepEqual(requests[1]!.messages.at(-1).content.map((block: Json) => block.type), ["server_tool_use", "web_search_tool_result"]);
  assert.doesNotMatch(JSON.stringify(requests[1]!.messages), /provider-search:|Continue the paused/);
  assert.equal(output.filter(event => event.type === "text_delta").map(event => event.delta).join(""), ANSWER);
});

test("Anthropic pause continuations have a finite budget", async t => {
  const { agent, requests } = await localAgent(t, attempt => paused(String(attempt)));
  await assert.rejects(async () => { for await (const _event of agent.run(input("Search", "pause-loop"))) { /* drain */ } }, /paused web search more than 3 times/);
  assert.equal(requests.length, 4);
});

test("Anthropic native search and local tools can complete the same durable tool round", async t => {
  const { agent, requests } = await localAgent(t, attempt => attempt === 1 ? [
    ...events("anthropic-messages", "tools").filter(event => event.type !== "message_delta" && event.type !== "message_stop"),
    { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "local_ls", name: "ls", input: {} } },
    { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: '{"path":"."}' } },
    { type: "content_block_stop", index: 3 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } },
    { type: "message_stop" },
  ] : events("anthropic-messages", "finished", false));
  const output: AgentStreamEvent[] = [];
  for await (const event of agent.run(input("Search and inspect the directory", "tools"))) output.push(event);
  assert.equal(requests.length, 2);
  assert.ok(output.some(event => event.type === "tool" && event.toolName === "ls" && event.phase === "end" && !event.isError));
  const history = requests[1]!.messages;
  assert.ok(history.some((message: Json) => message.role === "assistant" && Array.isArray(message.content) && message.content.some((block: Json) => block.type === "tool_use" && block.id === "local_ls")));
  assert.ok(history.some((message: Json) => message.role === "user" && Array.isArray(message.content) && message.content.some((block: Json) => block.type === "tool_result" && block.tool_use_id === "local_ls")));
  assert.match(JSON.stringify(history), /opaque-provider-search-data/);
});

test("interrupted Anthropic search history keeps completed results and drops unfinished local tool calls", async t => {
  const { agent, requests } = await localAgent(t, attempt => attempt === 1 ? [
    ...events("anthropic-messages", "partial").filter(event => event.type !== "message_delta" && event.type !== "message_stop"),
    { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "orphan", name: "read", input: {} } },
    { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: '{"path":' } },
    { type: "error", error: { type: "overloaded_error", message: "Stream interrupted" } },
  ] : events("anthropic-messages", "continued", false));
  const output: AgentStreamEvent[] = [];
  for await (const event of agent.run(input("Search", "interrupted"))) output.push(event);
  assert.equal(requests.length, 2);
  assert.ok(output.some(event => event.type === "retry"));
  assert.doesNotMatch(JSON.stringify(requests[1]!.messages), /orphan|"type":"tool_use"/);
  assert.match(JSON.stringify(requests[1]!.messages), /opaque-provider-search-data/);
});

for (const api of apis) test(`${api} interrupted native searches settle their activity`, async () => {
  const pi = await runtime(api);
  const updates: Json[] = [];
  const start = events(api).slice(0, api === "openai-responses" ? 2 : 4);
  const options = {
    onAgentWebSearch: (search: Json) => { updates.push(search); },
    fetch: async () => new Response(sse(start), { headers: { "content-type": "text/event-stream" } }),
  };
  const response = await pi.models.streamSimple(pi.model, { messages: [{ role: "user", content: "Search", timestamp: 0 }] }, options).result() as AgentSearchMessage;
  assert.equal(response.stopReason, "error");
  assert.equal(updates.at(-1)?.status, "failed");
  assert.equal(response.projectWebSearch?.searches[0]?.status, "failed");
});

test("OpenAI replay retains partial answer text when the stream ended before output_item.done", async () => {
  const pi = await runtime("openai-responses");
  const requests: Json[] = [];
  const options = { fetch: async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const stream = events("openai-responses", String(requests.length));
    return new Response(sse(requests.length === 1 ? stream.slice(0, -2) : stream), { headers: { "content-type": "text/event-stream" } });
  } };
  const partial = await pi.models.streamSimple(pi.model, { messages: [{ role: "user", content: "Search", timestamp: 0 }] }, options).result();
  assert.equal(partial.stopReason, "error");
  // Durable promotes retained interrupted text before asking the model to continue.
  partial.stopReason = "stop";
  await pi.models.streamSimple(pi.model, { messages: [{ role: "user", content: "Search", timestamp: 0 }, partial,
    { role: "user", content: "Continue", timestamp: 1 }] }, options).result();
  const saved = requests[1]!.input.find((item: Json) => item.type === "message" && item.role === "assistant");
  assert.equal(saved.content[0].text, ANSWER);
  assert.ok(requests[1]!.input.some((item: Json) => item.type === "web_search_call"));
});

test("search observer failures still deliver a terminal error", { timeout: 2000 }, async () => {
  const pi = await runtime("openai-responses");
  const initial = events("openai-responses").slice(0, 2);
  const options = {
    onAgentWebSearch: (search: Json) => { if (search.status === "failed") throw new Error("Search projection failed"); },
    fetch: async () => new Response(sse([...initial,
      { type: "response.output_item.added", output_index: 1, item: { type: "web_search_call", id: "second", status: "in_progress" } },
    ]), { headers: { "content-type": "text/event-stream" } }),
  };
  const response = await pi.models.streamSimple(pi.model, { messages: [{ role: "user", content: "Search", timestamp: 0 }] }, options).result();
  assert.equal(response.stopReason, "error");
  assert.match(response.errorMessage ?? "", /Search projection failed/);
});

test("switching providers does not carry paused native search state into the new model", async () => {
  const pi = await runtime("anthropic-messages");
  const first = await pi.models.streamSimple(pi.model, { messages: [{ role: "user", content: "Search", timestamp: 0 }] }, {
    fetch: async () => new Response(sse(paused("pending").filter(event => event.index !== 1)), { headers: { "content-type": "text/event-stream" } }),
  }).result() as AgentSearchMessage;
  assert.equal(first.projectWebSearch?.searches[0]?.status, "running");
  const other = await createPiRuntime({ provider: "other-provider", model: "search-model", apiKey: "offline-key",
    baseUrl: "http://127.0.0.1:9", apiKind: "anthropic-messages", webSearch: false });
  let body: Json | undefined;
  const response = await other.models.streamSimple(other.model, { messages: [{ role: "user", content: "Search", timestamp: 0 }, first,
    { role: "user", content: "Continue", timestamp: 1 }] }, { fetch: async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(sse(events("anthropic-messages", "other", false)), { headers: { "content-type": "text/event-stream" } });
  } }).result() as AgentSearchMessage;
  assert.doesNotMatch(JSON.stringify(body?.messages), /server_tool_use|provider-search:/);
  assert.equal(response.projectWebSearch, undefined);
});
