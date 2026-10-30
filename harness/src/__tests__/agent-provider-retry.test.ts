import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  MutableModels,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { AGENT_PROVIDER_MAX_RETRIES, createPiRuntime, type AgentApiKind } from "../agent/pi";

type PiAi = typeof import("@earendil-works/pi-ai");

const CONTEXT = { messages: [] } as unknown as Context;

/** The smallest assistant message the stream protocol can carry. */
function assistantMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "self-hosted",
    model: "MiniMax-M3",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  } as AssistantMessage;
}

type Step =
  | { type: "error"; message: string; reason?: "error" | "aborted" }
  | { type: "start" }
  | { type: "text"; delta: string }
  | { type: "done" };

/** Replays a scripted attempt as the provider adapters would: events, then end. */
function scriptStream(ai: PiAi, steps: readonly Step[]) {
  const stream = ai.createAssistantMessageEventStream();
  queueMicrotask(() => {
    let started = false;
    // The adapters carry the answer-so-far on every partial, which is what a
    // consumer reads when the stream dies without a terminal event.
    let text = "";
    const start = () => {
      if (started) return;
      stream.push({ type: "start", partial: assistantMessage({}) } as AssistantMessageEvent);
      started = true;
    };
    for (const step of steps) {
      if (step.type === "start") {
        start();
        continue;
      }
      if (step.type === "text") {
        start();
        text += step.delta;
        stream.push({
          type: "text_delta",
          partial: assistantMessage({ content: [{ type: "text", text }] as never }),
          delta: step.delta,
        } as unknown as AssistantMessageEvent);
        continue;
      }
      if (step.type === "error") {
        const reason = step.reason ?? "error";
        stream.push({
          type: "error",
          reason,
          error: assistantMessage({ stopReason: reason, errorMessage: step.message }),
        } as AssistantMessageEvent);
        continue;
      }
      stream.push({
        type: "done",
        reason: "stop",
        message: assistantMessage({}),
      } as AssistantMessageEvent);
    }
    stream.end();
  });
  return stream;
}

/** A models collection whose attempts follow `script`, one entry per attempt. */
function scriptedModels(ai: PiAi, script: ReadonlyArray<readonly Step[]>) {
  const state = { attempts: 0, options: [] as Array<SimpleStreamOptions | undefined> };
  const models = {
    setProvider() {},
    streamSimple(_model: unknown, _context: unknown, options?: SimpleStreamOptions) {
      state.options.push(options);
      const steps = script[Math.min(state.attempts, script.length - 1)] ?? [];
      state.attempts += 1;
      return scriptStream(ai, steps);
    },
  } as unknown as MutableModels;
  return { models, state };
}

async function createRuntime(models: MutableModels, apiKind: AgentApiKind = "openai-responses") {
  return createPiRuntime({
    provider: "self-hosted",
    model: "MiniMax-M3",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "test-key",
    apiKind,
    models,
  });
}

/** Drains a stream and reports the events the consumer saw, terminal one included. */
async function drainEvents(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/** Drains a stream and reports the event types the consumer saw. */
async function drain(stream: AsyncIterable<AssistantMessageEvent>): Promise<string[]> {
  return (await drainEvents(stream)).map((event) => event.type);
}

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
for (const boundary of ["create", "iterate", "result"] as const) {
  test(`${api} exceptions at the ${boundary} boundary spend the request retry budget`, { timeout: 5000 }, async () => {
    const ai = await import("@earendil-works/pi-ai");
    const { models, state } = scriptedModels(ai, [[{ type: "done" }]]);
    const base = models.streamSimple.bind(models);
    let calls = 0;
    models.streamSimple = (...args) => {
      if (++calls > 1) return base(...args);
      const error = new Error("Transport failed", { cause: { code: "ECONNREFUSED" } });
      if (boundary === "create") throw error;
      const source = ai.createAssistantMessageEventStream();
      if (boundary === "iterate") source[Symbol.asyncIterator] = async function* () { throw error; };
      else { source.end(); source.result = async () => { throw error; }; }
      return source;
    };
    const runtime = await createRuntime(models, api);
    const stream = await runtime.streamFn(runtime.model, CONTEXT, { maxRetries: 1 });
    assert.equal((await drain(stream)).at(-1), "done");
    assert.equal((await stream.result()).stopReason, "stop");
    assert.equal(calls, 2); assert.equal(state.options[0]?.maxRetries, 0);
  });
}
}

test("exceptions while creating later attempts still share the same bounded budget", { timeout: 5000 }, async () => {
  const ai = await import("@earendil-works/pi-ai");
  const { models } = scriptedModels(ai, [[{ type: "error", message: "terminated" }]]);
  const base = models.streamSimple.bind(models);
  let calls = 0;
  models.streamSimple = (...args) => {
    if (++calls === 1) return base(...args);
    throw Object.assign(new Error("Transport failed"), { status: 501 });
  };
  const runtime = await createRuntime(models, "openai-completions");
  const stream = await runtime.streamFn(runtime.model, CONTEXT, { maxRetries: 2 });
  assert.equal((await drain(stream)).at(-1), "error");
  assert.equal(calls, 3);
  assert.match((await stream.result()).errorMessage ?? "", /501/);
});

test("iterator exceptions settle a partial response without replaying already visible content", { timeout: 2000 }, async () => {
  const ai = await import("@earendil-works/pi-ai");
  const { models } = scriptedModels(ai, []);
  const partial = assistantMessage({ content: [{ type: "text", text: "Retained" }] });
  let calls = 0;
  models.streamSimple = () => {
    calls++;
    const source = ai.createAssistantMessageEventStream();
    source[Symbol.asyncIterator] = async function* () {
      yield { type: "text_delta", contentIndex: 0, delta: "Retained", partial };
      throw Object.assign(new Error("Transport failed"), { code: "ECONNRESET" });
    };
    return source;
  };
  const runtime = await createRuntime(models, "openai-completions");
  const stream = await runtime.streamFn(runtime.model, CONTEXT, { maxRetries: 1 });
  assert.deepEqual(await drain(stream), ["text_delta", "error"]);
  const result = await stream.result();
  assert.deepEqual(result.content, partial.content); assert.equal(result.usage, partial.usage);
  assert.match(result.errorMessage ?? "", /ECONNRESET/); assert.equal(calls, 1);
});

test("a result supplied without a terminal event completes the consumer", async () => {
  const ai = await import("@earendil-works/pi-ai");
  const { models } = scriptedModels(ai, []);
  models.streamSimple = () => { const source = ai.createAssistantMessageEventStream(); source.end(assistantMessage({})); return source; };
  const runtime = await createRuntime(models, "openai-completions");
  assert.deepEqual(await drain(await runtime.streamFn(runtime.model, CONTEXT, { maxRetries: 0 })), ["done"]);
});

test("a committed terminal event stays authoritative if iterator cleanup fails", async () => {
  const ai = await import("@earendil-works/pi-ai");
  const { models } = scriptedModels(ai, []); let calls = 0;
  models.streamSimple = () => {
    calls++;
    const source = ai.createAssistantMessageEventStream();
    source[Symbol.asyncIterator] = async function* () {
      try { yield { type: "done", reason: "stop", message: assistantMessage({}) } as const; }
      finally { throw new Error("Connection lost during cleanup"); }
    };
    return source;
  };
  const runtime = await createRuntime(models, "openai-completions");
  assert.deepEqual(await drain(await runtime.streamFn(runtime.model, CONTEXT, { maxRetries: 1 })), ["done"]);
  assert.equal(calls, 1);
});

test("construction errors use fallback and retain their original diagnostic", async () => {
  const ai = await import("@earendil-works/pi-ai");
  const { models } = scriptedModels(ai, []);
  const error = new Error("Invalid API key");
  let calls = 0;
  models.streamSimple = () => { calls++; throw error; };
  const runtime = await createRuntime(models, "openai-completions");
  const stream = await runtime.streamFn(runtime.model, CONTEXT, { maxRetries: 1 });
  assert.deepEqual(await drain(stream), ["error"]);
  assert.equal((await stream.result()).errorMessage, error.message);
  assert.equal(calls, 2);
});

for (const boundary of ["iterate", "result"] as const) test(`HTTP 401 ${boundary} exceptions use the bounded fallback`, { timeout: 2000 }, async () => {
  const ai = await import("@earendil-works/pi-ai");
  const { models } = scriptedModels(ai, []);
  let calls = 0;
  models.streamSimple = () => {
    calls++;
    const source = ai.createAssistantMessageEventStream();
    const error = Object.assign(new Error("Request rejected"), { status: 401 });
    if (boundary === "iterate") source[Symbol.asyncIterator] = async function* () { throw error; };
    else { source.end(); source.result = async () => { throw error; }; }
    return source;
  };
  const runtime = await createRuntime(models, "openai-completions");
  const stream = await runtime.streamFn(runtime.model, CONTEXT, { maxRetries: 1 });
  assert.deepEqual(await drain(stream), ["error"]); assert.equal(calls, 2);
  assert.match((await stream.result()).errorMessage ?? "", /401/);
});

test("caller cancellation while an iterator throws settles an aborted response without retrying", { timeout: 2000 }, async () => {
  const ai = await import("@earendil-works/pi-ai");
  const { models } = scriptedModels(ai, []);
  const controller = new AbortController(); let calls = 0;
  models.streamSimple = () => {
    calls++;
    const source = ai.createAssistantMessageEventStream();
    source[Symbol.asyncIterator] = async function* () { controller.abort(); throw new Error("Transport failed", { cause: { code: "ETIMEDOUT" } }); };
    return source;
  };
  const runtime = await createRuntime(models, "openai-completions");
  const stream = await runtime.streamFn(runtime.model, CONTEXT, { signal: controller.signal });
  assert.deepEqual(await drain(stream), ["error"]);
  assert.equal((await stream.result()).stopReason, "aborted"); assert.equal(calls, 1);
});

for (const apiKind of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
  for (const status of [408, 409, 501, 400]) test(`${apiKind} adapter HTTP ${status} uses fallback regardless of HTTP classification`, async () => {
    const runtime = await createPiRuntime({ provider: "http-status-test", model: "test-model",
      baseUrl: "http://127.0.0.1:9/v1", apiKey: "test-key", apiKind });
    let requests = 0;
    const stream = await runtime.streamFn(runtime.model, CONTEXT, { maxRetries: 1, fetch: async () => {
      if (++requests === 1) return new Response(JSON.stringify({ error: { message: "Request failed", type: "provider_failure" } }), { status });
      const events: Array<Record<string, unknown>> = apiKind === "openai-responses"
        ? [{ type: "response.completed", response: { id: "resp_recovered", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0 } } }]
        : apiKind === "anthropic-messages" ? [
          { type: "message_start", message: { id: "recovered", type: "message", role: "assistant", model: "test-model", content: [],
            usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } },
          { type: "message_stop" },
        ] : [{ id: "recovered", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];
      return new Response(events.map(event => `event: ${event.type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    } });
    const events = await drain(stream);
    assert.equal(requests, 2);
    assert.equal(events.at(-1), "done", (await stream.result()).errorMessage);
  });
}

test("the wrapper spends the budget, so each attempt is a single request", async () => {
  const ai = await import("@earendil-works/pi-ai");
  const { models, state } = scriptedModels(ai, [[{ type: "done" }]]);
  const runtime = await createRuntime(models);

  await drain(await runtime.streamFn(runtime.model, CONTEXT));

  assert.equal(state.attempts, 1);
  // pi retrying on top of this wrapper would multiply the two budgets.
  assert.equal(state.options[0]?.maxRetries, 0);
  assert.ok(AGENT_PROVIDER_MAX_RETRIES >= 10);
});

test("per-request options survive the retry wrapper", async () => {
  const ai = await import("@earendil-works/pi-ai");
  const { models, state } = scriptedModels(ai, [[{ type: "done" }]]);
  const runtime = await createRuntime(models);

  await drain(await runtime.streamFn(runtime.model, CONTEXT, { timeoutMs: 1234 }));

  assert.equal(state.options[0]?.timeoutMs, 1234);
});

test("a stream that dies before producing anything is re-issued", async () => {
  const ai = await import("@earendil-works/pi-ai");
  // The failure this covers: the bridge or the Server drops the connection while
  // the model is answering, and pi's own budget cannot retry it because the
  // response already started.
  const { models, state } = scriptedModels(ai, [
    [{ type: "error", message: "terminated" }],
    [{ type: "text", delta: "hello" }, { type: "done" }],
  ]);
  const runtime = await createRuntime(models);

  const events = await drain(await runtime.streamFn(runtime.model, CONTEXT));

  assert.equal(state.attempts, 2);
  assert.ok(events.includes("text_delta"), `expected the retried attempt's text, got ${events.join(",")}`);
  assert.equal(events.at(-1), "done");
  assert.ok(!events.includes("error"), "the dropped attempt must not surface");
});

test("temporary upstream failures without an HTTP status use the request retry budget", async () => {
  const ai = await import("@earendil-works/pi-ai");
  const { models, state } = scriptedModels(ai, [
    [{ type: "error", message: "upstream_error: Upstream service temporarily unavailable" }],
    [{ type: "text", delta: "Recovered" }, { type: "done" }],
  ]);
  const runtime = await createRuntime(models);
  const events = await drain(await runtime.streamFn(runtime.model, CONTEXT));
  assert.equal(state.attempts, 2);
  assert.equal(events.at(-1), "done");
  assert.ok(!events.includes("error"));
});

for (const type of ["error", "response.failed"]) test(`HTTP 200 SSE ${type} failures retry through the real Responses adapter`, async t => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    const error = { code: "upstream_error", message: "Upstream service temporarily unavailable" };
    const event = requests === 1
      ? type === "error" ? { type, ...error } : { type, response: { status: "failed", error } }
      : { type: "response.completed", response: { id: "resp_recovered", status: "completed", output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const runtime = await createPiRuntime({ provider: "self-hosted", model: "gpt-6.1-sol",
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "test-key", apiKind: "openai-responses" });
  const events = await drainEvents(await runtime.streamFn(runtime.model, CONTEXT, { maxRetries: 1 }));
  assert.equal(requests, 2);
  assert.equal(events.at(-1)?.type, "done");
});

test("a stream that announced itself and then died is still replayed", async () => {
  const ai = await import("@earendil-works/pi-ai");
  // This is the shape the bridge produces: the adapters push `start` as soon as
  // the response headers land, so a connection cut before the first token still
  // leaves the consumer holding a start event.
  const { models, state } = scriptedModels(ai, [
    [{ type: "start" }, { type: "error", message: "terminated" }],
    [{ type: "text", delta: "hello" }, { type: "done" }],
  ]);
  const runtime = await createRuntime(models);

  const events = await drain(await runtime.streamFn(runtime.model, CONTEXT));

  assert.equal(state.attempts, 2);
  assert.equal(
    events.filter((type) => type === "start").length,
    1,
    "the replay must not announce a second start, or pi keeps a second partial message",
  );
  assert.ok(events.includes("text_delta"));
  assert.equal(events.at(-1), "done");
});

test("an attempt that already produced events is not replayed", async () => {
  const ai = await import("@earendil-works/pi-ai");
  // pi's loop writes a partial assistant message into the transcript as soon as
  // an event arrives, so replaying here would leave two versions of it.
  const { models, state } = scriptedModels(ai, [
    [{ type: "text", delta: "half an answer" }, { type: "error", message: "terminated" }],
    [{ type: "done" }],
  ]);
  const runtime = await createRuntime(models);

  const events = await drain(await runtime.streamFn(runtime.model, CONTEXT));

  assert.equal(state.attempts, 1);
  assert.equal(events.at(-1), "error");
});

test("a cancelled stream is never replayed", async () => {
  const ai = await import("@earendil-works/pi-ai");
  const { models, state } = scriptedModels(ai, [
    [{ type: "error", message: "terminated", reason: "aborted" }],
    [{ type: "done" }],
  ]);
  const runtime = await createRuntime(models);

  const controller = new AbortController(); controller.abort();
  const events = await drainEvents(await runtime.streamFn(runtime.model, CONTEXT, { signal: controller.signal }));

  assert.equal(state.attempts, 0);
  assert.equal(events.at(-1)?.type, "error");
  assert.equal((events.at(-1) as { error: AssistantMessage }).error.stopReason, "aborted");
});

test("a provider abort without caller cancellation uses the transport retry budget", async () => {
  const ai = await import("@earendil-works/pi-ai");
  const { models, state } = scriptedModels(ai, [
    [{ type: "error", message: "aborted", reason: "aborted" }], [{ type: "done" }],
  ]);
  const runtime = await createRuntime(models);
  const events = await drain(await runtime.streamFn(runtime.model, CONTEXT));
  assert.equal(state.attempts, 2); assert.equal(events.at(-1), "done");
});

/**
 * The shape a proxy leaves behind when it ends the body without a verdict: the
 * response started, the model wrote part of an answer, and no `done` or `error`
 * ever arrives. The wrapper's contract is that every path ends with a terminal
 * event — ending the consumer's stream here would leave `result()` pending
 * forever, and pi awaits that, so the run would hang rather than fail.
 */
test("an attempt that stops without a verdict becomes a retryable error", async () => {
  const ai = await import("@earendil-works/pi-ai");
  const { models, state } = scriptedModels(ai, [
    [{ type: "start" }, { type: "text", delta: "half an answer" }],
  ]);
  const runtime = await createRuntime(models);

  const events = await drainEvents(await runtime.streamFn(runtime.model, CONTEXT));

  assert.equal(state.attempts, 1);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  const error = (terminal as { error?: AssistantMessage } | undefined)?.error;
  assert.equal(error?.stopReason, "error");
  assert.match(error?.errorMessage ?? "", /ended without/);
  assert.equal((error as AssistantMessage).stopReason, "error");
  // The text the user already saw rides on the error, so the turn can be
  // continued from it instead of replayed.
  assert.equal(JSON.stringify(error?.content), JSON.stringify([{ type: "text", text: "half an answer" }]));
});

test("an attempt that stops without a verdict before any content is re-issued", async () => {
  const ai = await import("@earendil-works/pi-ai");
  // Headers landed and nothing else: the consumer holds an empty partial, which
  // is replayable, so the wrapper spends its own budget instead of surfacing it.
  const { models, state } = scriptedModels(ai, [
    [{ type: "start" }],
    [{ type: "text", delta: "hello" }, { type: "done" }],
  ]);
  const runtime = await createRuntime(models);

  const events = await drainEvents(await runtime.streamFn(runtime.model, CONTEXT));

  assert.equal(state.attempts, 2);
  assert.equal(events.filter((event) => event.type === "start").length, 1);
  assert.ok(!events.some((event) => event.type === "error"), "the dropped attempt must not surface");
  assert.equal(events.at(-1)?.type, "done");
});

test("the budget bounds an attempt that keeps stopping without a verdict", async () => {
  const ai = await import("@earendil-works/pi-ai");
  const { models, state } = scriptedModels(ai, [[{ type: "start" }]]);
  const runtime = await createRuntime(models);

  const events = await drainEvents(await runtime.streamFn(runtime.model, CONTEXT, { maxRetries: 1 }));

  // one initial attempt plus one retry, then the cut is reported
  assert.equal(state.attempts, 2);
  assert.equal(events.at(-1)?.type, "error");
});

for (const message of ["invalid api key", "quota exceeded", "Upstream response stream was interrupted", "未知错误", ""]) test(`model failures use fallback without recognizing their text: ${message}`, async () => {
  const ai = await import("@earendil-works/pi-ai");
  const { models, state } = scriptedModels(ai, [
    [{ type: "error", message }],
    [{ type: "done" }],
  ]);
  const runtime = await createRuntime(models);

  const events = await drain(await runtime.streamFn(runtime.model, CONTEXT, { maxRetries: 1 }));

  assert.equal(state.attempts, 2);
  assert.equal(events.at(-1), "done");
});

test("the budget bounds how often a stream is re-issued", async () => {
  const ai = await import("@earendil-works/pi-ai");
  const { models, state } = scriptedModels(ai, [[{ type: "error", message: "terminated" }]]);
  const runtime = await createRuntime(models);

  const events = await drain(await runtime.streamFn(runtime.model, CONTEXT, { maxRetries: 1 }));

  // one initial attempt plus one retry
  assert.equal(state.attempts, 2);
  assert.equal(events.at(-1), "error");
});

/**
 * The shape the bridge produces on a mid-stream failure: the response headers
 * land, then the connection is cut before a single token. Driving the real
 * adapter against a socket that does exactly that is the closest thing to the
 * run that died with `terminated`.
 */
test("a response cut off after its headers is re-issued", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    // Headers only: the adapter announces the start, then loses the body.
    setImmediate(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");

  try {
    const runtime = await createPiRuntime({
      provider: "self-hosted",
      model: "MiniMax-M3",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "test-key",
      apiKind: "openai-responses",
    });

    const stream = await runtime.streamFn(
      runtime.model,
      { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
      { maxRetries: 2 },
    );
    try {
      for await (const _event of stream) {
        // drained for the side effect
      }
    } catch {
      // the budget runs out on a server that never recovers
    }

    // one initial attempt plus two retries
    assert.equal(requests, 3);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/**
 * The bridge answers 502 while the Server AI proxy is unreachable, so that is
 * the failure the request-level budget has to survive. This drives the real
 * provider path against a server that never recovers, with a small budget so
 * the test stays fast: every retry must actually reach the endpoint.
 */
test("a 502 from the provider endpoint is retried, not fatal", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "SteamHarness Server AI 代理请求失败。" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");

  try {
    const runtime = await createPiRuntime({
      provider: "self-hosted",
      model: "MiniMax-M3",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "test-key",
      apiKind: "openai-responses",
    });

    const stream = await runtime.streamFn(
      runtime.model,
      { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
      { maxRetries: 2 },
    );
    try {
      for await (const _event of stream) {
        // drained for the side effect: each attempt has to reach the endpoint
      }
    } catch {
      // spending the budget ends the stream in an error, which is the point
    }

    // one initial attempt plus two retries
    assert.equal(requests, 3);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
