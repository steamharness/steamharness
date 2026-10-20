import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAgentRuntime, type AgentRuntimeInternalOptions } from "../agent/runtime";
import { parseAgentInput } from "../agent/runtime";
import { compactAgentMessages, estimateAgentContextTokens, estimateAgentTokens, findCompactionSplitIndex } from "../agent/compaction";
import { HarnessError } from "../workflow/errors";
import type { PiRuntime } from "../agent/pi";
import { resolveAgentBridgeBaseUrl } from "../agent/system-llm";
import { recordAgentRunContextUsage, readAgentRunContextUsage } from "../agent/node";
import {
  AGENT_OUTPUT_LIMIT_MAX_RETRIES,
  AGENT_PROVIDER_MAX_RETRIES,
  DEFAULT_AGENT_CONTEXT_WINDOW,
  resolveAgentModelContextWindow,
} from "../agent/pi";
import type { AgentHost, AgentInput, AgentStreamEvent, AgentUsage } from "../agent/types";

/**
 * Builds a pi runtime backed by the SDK's faux provider.
 *
 * The core rule is that default tests stay offline, so the model side is
 * scripted: each entry in `responses` is handed back in order, exactly as a
 * provider would.
 */
async function createFauxRuntime(responses: Array<() => unknown>) {
  const ai = await import("@earendil-works/pi-ai");

  const faux = ai.fauxProvider({
    models: [{ id: "faux-1", name: "Faux", reasoning: true, contextWindow: 1_000, maxTokens: 100 }],
  });
  const models = ai.createModels();
  models.setProvider(faux.provider);
  const model = models.getModel("faux", "faux-1");
  assert.ok(model, "faux model must resolve");

  faux.setResponses(responses as never[]);

  const pi: PiRuntime = {
    Type: ai.Type,
    models,
    streamFn: models.streamSimple.bind(models) as PiRuntime["streamFn"],
    model,
    providerId: "faux",
    modelId: "faux-1",
    supportedThinkingLevels: ["off", "minimal", "low", "medium", "high"],
    clampThinkingLevel: (level) => level,
  };

  return { pi, faux, ai };
}

async function collectEvents(
  options: AgentRuntimeInternalOptions,
  input: Partial<AgentInput> & { prompt: string },
  host?: AgentHost,
): Promise<AgentStreamEvent[]> {
  const runtime = await createAgentRuntime(options);
  const events: AgentStreamEvent[] = [];
  for await (const event of runtime.run({ errCode: 0, errMessage: "", ...input }, host)) {
    events.push(event);
  }
  return events;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "workflow-agent-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A request rendered as one line per message, so a transcript reads as one. */
function readRequestText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((block) => {
      if (typeof block !== "object" || block === null) return [];
      const record = block as { type?: unknown; text?: unknown; name?: unknown };
      if (record.type === "text" && typeof record.text === "string") return [record.text];
      if (record.type === "toolCall" && typeof record.name === "string") return [`<toolCall:${record.name}>`];
      return [];
    })
    .join("");
}

test("parseAgentInput resolves defaults without touching the model", async () => {
  const parsed = parseAgentInput({ prompt: "hello", errCode: 0, errMessage: "" }, { workdir: "/tmp/ws" });

  assert.equal(parsed.prompt, "hello");
  assert.equal(parsed.workdir, path.resolve("/tmp/ws"));
  assert.equal(parsed.effort, "medium");
  assert.equal(parsed.agent, "build");
  assert.equal(parsed.permissionPolicy, "workspace");
  assert.equal(parsed.compact, false);
});

test("parseAgentInput treats an exact /compact prompt as a compaction", () => {
  const parsed = parseAgentInput({ prompt: "  /compact ", errCode: 0, errMessage: "" }, {});

  assert.equal(parsed.compact, true);
  // The same string embedded in a sentence stays an ordinary prompt.
  const prose = parseAgentInput(
    { prompt: "please run /compact later", errCode: 0, errMessage: "" },
    {},
  );
  assert.equal(prose.compact, false);
});

test("parseAgentInput normalizes ultra effort and unknown policies", () => {
  const parsed = parseAgentInput({
    prompt: "hi",
    errCode: 0,
    errMessage: "",
    effort: "ultra",
    permissionPolicy: "nonsense" as never,
    agent: "plan",
  }, {});

  assert.equal(parsed.effort, "ultra");
  assert.equal(parsed.permissionPolicy, "workspace");
  assert.equal(parsed.agent, "plan");
});

test("parseAgentInput resolves the run's own directory scope", () => {
  const options = { workdir: "/srv/runtime", allowedDirectories: ["/srv/runtime", "/srv/shared"] };

  // A run that names nothing inherits the runtime's scope.
  assert.deepEqual(
    parseAgentInput({ prompt: "hi", errCode: 0, errMessage: "" }, options).allowedDirectories,
    ["/srv/runtime", "/srv/shared"],
  );

  // A run that names its own workdir gets that directory by default, and its
  // relative entries resolve against it rather than against the runtime's.
  const own = parseAgentInput(
    { prompt: "hi", workdir: "/srv/other", errCode: 0, errMessage: "" },
    options,
  );
  assert.equal(own.workdir, "/srv/other");
  assert.deepEqual(own.allowedDirectories, ["/srv/runtime", "/srv/shared"]);

  const scoped = parseAgentInput({
    prompt: "hi",
    workdir: "/srv/other",
    allowedDirectories: ["/srv/other", "../linked", "/abs/root"],
    errCode: 0,
    errMessage: "",
  }, options);
  assert.deepEqual(scoped.allowedDirectories, ["/srv/other", "/srv/linked", "/abs/root"]);
});

test("a run's own scope decides what its tools may touch", async () => {
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxToolCall("write", { path: "note.txt", content: "x" })], { stopReason: "toolUse" }),
    () => ai.fauxAssistantMessage([ai.fauxToolCall("write", { path: "../escape.txt", content: "x" })], { stopReason: "toolUse" }),
    () => ai.fauxAssistantMessage([ai.fauxText("done")]),
  ]);

  await withTempDir(async (base) => {
    const runtimeDir = path.join(base, "runtime");
    const runDir = path.join(base, "run");
    const linked = path.join(base, "linked");
    await Promise.all([mkdir(runtimeDir), mkdir(runDir), mkdir(linked)]);

    // The runtime was built for one directory and the run names another, plus
    // a linked root. Both have to win: a host that links folders into a
    // workspace learns which ones from the workspace, not from the project.
    const events = await collectEvents({ pi, workdir: runtimeDir }, {
      prompt: "write a file",
      workdir: runDir,
      allowedDirectories: [runDir, linked],
      errCode: 0,
      errMessage: "",
    });

    assert.equal(await readFile(path.join(runDir, "note.txt"), "utf8"), "x");
    await assert.rejects(() => readFile(path.join(runtimeDir, "note.txt"), "utf8"));

    // One directory above the run's workdir is outside all three roots.
    const escape = events.filter((event) => event.type === "tool" && event.phase === "end")[1];
    assert.ok(escape && escape.type === "tool");
    assert.equal(escape.isError, true);
    await assert.rejects(() => readFile(path.join(base, "escape.txt"), "utf8"));
  });
});

test("a prompt streams text deltas and reports token usage once", async () => {
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("hello "), ai.fauxText("world")]),
  ]);

  const usages: unknown[] = [];
  await withTempDir(async (workdir) => {
    const events = await collectEvents({ pi, workdir }, { prompt: "hi", errCode: 0, errMessage: "" }, {
      reportUsage: (usage) => {
        usages.push(usage);
      },
    });

    const text = events
      .filter((event): event is { type: "text_delta"; delta: string } => event.type === "text_delta")
      .map((event) => event.delta)
      .join("");
    assert.equal(text, "hello world");
    assert.equal(usages.length, 1);

    const contextUsage = [...events].reverse().find((event) => event.type === "context_usage");
    assert.ok(contextUsage, "the composer row needs the usage the run reported");
    // The denominator is the model's own window — the faux model declares 1000 —
    // and the numerator is what the transcript now holds.
    assert.equal(contextUsage.usage.total, 1_000);
    assert.ok(contextUsage.usage.used > 0, "a finished turn cannot have used nothing");
  });
});

for (const durable of [false, true]) test(`context is visible before the model starts and updates while its response is open (session=${durable})`, { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const { pi, ai } = await createFauxRuntime([]);
  const stream = ai.createAssistantMessageEventStream();
  let partial = ai.fauxAssistantMessage([ai.fauxText("")], { stopReason: "pending" });
  let called = false;
  pi.models.streamSimple = () => {
    called = true;
    stream.push({ type: "start", partial });
    return stream;
  };
  let release!: () => void;
  const lease = new Promise<void>(resolve => { release = resolve; });
  const runtime = await createAgentRuntime({ pi, ...(durable ? { session: {}, sessionLease: lease } : {}) });
  const events = runtime.run({ prompt: "hello", errCode: 0, errMessage: "" })[Symbol.asyncIterator]();
  const first = await events.next();
  assert.deepEqual(first.value, { type: "context_usage", usage: { used: 0, total: 1_000 } });
  assert.equal(called, false, "the ring must appear without waiting for a provider response");
  const received: AgentStreamEvent[] = [];
  const running = (async () => { for (let next = await events.next(); !next.done; next = await events.next()) received.push(next.value); })();
  const until = async (check: () => boolean) => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw new Error("Context stream did not update.");
  };
  t.after(async () => { release(); stream.push({ type: "error", reason: "aborted", error: { ...partial, stopReason: "aborted" } }); stream.end(); await running.catch(() => undefined); await runtime.close(); });
  await until(() => called);
  partial = { ...partial, content: [ai.fauxText("x".repeat(200))] };
  stream.push({ type: "text_delta", contentIndex: 0, delta: "x".repeat(200), partial });
  await until(() => received.some(event => event.type === "text_delta" && event.delta.length >= 200));
  assert.ok(runtime.getContextUsage()!.used > 0);

  runtime.updateContextUsage({ used: 500, total: 2_000 });
  assert.deepEqual(runtime.getContextUsage(), { used: 500, total: 2_000 });
  await until(() => received.some(event => event.type === "context_usage" && event.usage.used === 500));
  if (durable) {
    await runtime.control!({ type: "snapshot", requestId: "external-measurement" });
    await until(() => received.some(event => event.type === "session" && event.snapshot.contexts[0]?.contextUsage?.used === 500));
  }

  t.mock.timers.tick(100);
  partial = { ...partial, content: [ai.fauxText("x".repeat(400))] };
  stream.push({ type: "text_delta", contentIndex: 0, delta: "x".repeat(200), partial });
  await until(() => received.some(event => event.type === "context_usage" && event.usage.used === 550));
  assert.deepEqual(runtime.getContextUsage(), { used: 550, total: 2_000 }, "estimates continue growing from the external measurement");

  partial.usage = { ...partial.usage, input: 200, output: 30, cacheRead: 40, cacheWrite: 10, totalTokens: 280 };
  partial.stopReason = "stop";
  stream.push({ type: "done", reason: "stop", message: partial });
  stream.end();
  release();
  await running;
  assert.deepEqual(runtime.getContextUsage(), { used: 280, total: 1_000 }, "provider usage replaces the temporary measurement");
  assert.deepEqual([...received].reverse().find((event) => event.type === "context_usage"),
    { type: "context_usage", usage: { used: 280, total: 1_000 } });
});

test("context measurements validate inputs, remain snapshots, and reset with restored state", async () => {
  const { pi } = await createFauxRuntime([]);
  const runtime = await createAgentRuntime({ pi });
  runtime.restoreTranscript?.([{ role: "user", content: "hello", timestamp: 1 }]);
  for (const usage of [{ used: -1, total: 100 }, { used: Infinity, total: 100 },
    { used: 1, total: NaN }, { used: 1, total: 0 }]) {
    assert.throws(() => runtime.updateContextUsage(usage), (error: unknown) =>
      error instanceof HarnessError && error.type === "input_validation");
  }
  const supplied = { used: 800, total: 1_000 };
  runtime.updateContextUsage(supplied);
  supplied.used = 1;
  const read = runtime.getContextUsage()!;
  read.used = 2;
  assert.deepEqual(runtime.getContextUsage(), { used: 800, total: 1_000 });
  runtime.reset();
  assert.deepEqual(runtime.readTranscript?.(), []);
  assert.deepEqual(runtime.getContextUsage(), { used: 0, total: 1_000 });
});

test("cancelling after the initial context event prevents the model request", async () => {
  let called = false;
  const { pi, ai } = await createFauxRuntime([() => {
    called = true;
    return ai.fauxAssistantMessage("unexpected");
  }]);
  const controller = new AbortController();
  const runtime = await createAgentRuntime({ pi });
  const events = runtime.run({ prompt: "hello", errCode: 0, errMessage: "" }, {
    abortSignal: controller.signal,
  })[Symbol.asyncIterator]();
  assert.equal((await events.next()).value?.type, "context_usage");
  controller.abort();
  await assert.rejects(() => events.next(), (error: unknown) =>
    error instanceof HarnessError && error.type === "execution_aborted");
  assert.equal(called, false);
});

test("returning from a live stream stops the model and settles usage before releasing its listener", async () => {
  const { pi, ai } = await createFauxRuntime([]);
  const stream = ai.createAssistantMessageEventStream();
  const partial = ai.fauxAssistantMessage("partial answer", { stopReason: "pending" });
  let aborted = false;
  const usages: AgentUsage[] = [];
  pi.models.streamSimple = (_model, _context, options) => {
    options?.signal?.addEventListener("abort", () => {
      aborted = true;
      partial.stopReason = "aborted";
      partial.usage = { ...partial.usage, input: 100, output: 10, totalTokens: 110 };
      stream.push({ type: "error", reason: "aborted", error: partial });
      stream.end();
    }, { once: true });
    stream.push({ type: "start", partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "partial answer", partial });
    return stream;
  };
  const runtime = await createAgentRuntime({ pi });
  const events = runtime.run({ prompt: "hello", errCode: 0, errMessage: "" }, {
    reportUsage: (usage) => { usages.push(usage); },
  })[Symbol.asyncIterator]();
  while ((await events.next()).value?.type !== "text_delta") { /* Wait for the open response. */ }
  await events.return?.();
  assert.equal(aborted, true);
  assert.equal(usages.length, 1);
  assert.equal(usages[0]?.totalTokens, 110);
  runtime.updateContextUsage({ used: 800, total: 1_000 });
  assert.deepEqual(runtime.getContextUsage(), { used: 800, total: 1_000 });
});

test("context uses the latest valid provider usage plus trailing messages, never accumulated billing", async () => {
  const { ai } = await createFauxRuntime([]);
  const earlier = ai.fauxAssistantMessage("earlier");
  earlier.usage = { ...earlier.usage, input: 800, output: 100, totalTokens: 900 };
  const latest = ai.fauxAssistantMessage("latest");
  latest.usage = { ...latest.usage, input: 150, output: 20, cacheRead: 40, cacheWrite: 10, totalTokens: 220 };
  const trailing = { role: "toolResult" as const, toolCallId: "call", toolName: "read", content: [ai.fauxText("hello")], isError: false, timestamp: 1 };
  assert.equal(estimateAgentContextTokens([earlier, latest]), 220);
  assert.ok(estimateAgentContextTokens([earlier, latest, trailing]) > 220);
  latest.usage.totalTokens = 0;
  assert.equal(estimateAgentContextTokens([earlier, latest]), 220, "cache usage participates even without totalTokens");
  latest.stopReason = "error";
  assert.ok(estimateAgentContextTokens([earlier, latest]) >= 900, "failed usage cannot replace a valid baseline");
  const image = { role: "user" as const, content: [{ type: "image" as const, mimeType: "image/png", data: "a".repeat(50_000) }], timestamp: 1 };
  const imageEstimate = estimateAgentContextTokens([image]);
  assert.ok(imageEstimate >= 1_200 && imageEstimate < 1_210, "image estimates must not count base64 as prompt text");
});

test("uncalibrated context includes durable system sections and tool declarations", () => {
  const plain: AgentMessage[] = [{ role: "user", content: "Hello", timestamp: 0 }];
  const system: AgentMessage = { role: "system", content: "System instructions ".repeat(100), timestamp: 0,
    sections: { project: "Project instructions ".repeat(100) },
    toolsAdded: [{ name: "inspect", description: "Tool instructions ".repeat(100), parameters: { type: "object", properties: {} } }] };
  const withSystem = estimateAgentContextTokens([system, ...plain]);
  assert.ok(withSystem > 1200);
  assert.ok(withSystem > estimateAgentContextTokens(plain));
});

test("compacted and restored context ignores retained responses that measured the old prompt", async () => {
  const { pi, ai } = await createFauxRuntime([() => ai.fauxAssistantMessage("summary")]);
  const retained = ai.fauxAssistantMessage("tail");
  retained.usage = { ...retained.usage, input: 850, output: 50, totalTokens: 900 };
  const result = await compactAgentMessages({
    models: pi.models, model: pi.model,
    messages: [{ role: "user", content: "x".repeat(4_000), timestamp: 1 }, retained],
    settings: { enabled: true, threshold: 0.8, reserveTokens: 10, keepRecentTokens: 5 },
  });
  assert.ok(result.removed > 0);
  const restored = JSON.parse(JSON.stringify(result.messages)) as typeof result.messages;
  assert.ok(estimateAgentContextTokens(restored) < 900);
  const runtime = await createAgentRuntime({ pi });
  runtime.restoreTranscript?.(restored);
  assert.equal(runtime.getContextUsage()?.used, estimateAgentContextTokens(result.messages));
  const next = ai.fauxAssistantMessage("new answer");
  next.usage = { ...next.usage, input: 100, output: 30, totalTokens: 130 };
  assert.equal(estimateAgentContextTokens([...restored, next]), 130);
});

test("resuming and restoring an interrupted response cannot reuse its billed usage as context", async () => {
  const { ai, pi } = await createFauxRuntime([
    () => previous,
    () => partial,
    () => ai.fauxAssistantMessage("continued"),
  ]);
  const previous = ai.fauxAssistantMessage("complete answer");
  previous.usage = { ...previous.usage, input: 450, output: 50, totalTokens: 500 };
  const partial = ai.fauxAssistantMessage([ai.fauxText("kept text"), ai.fauxToolCall("lost", {})], {
    stopReason: "error", errorMessage: "connection lost",
  });
  partial.usage = { ...partial.usage, input: 1_800, output: 200, totalTokens: 2_000 };
  const runtime = await createAgentRuntime({ pi, retryDelayMs: 0 });
  const billed: AgentUsage[] = [];
  for await (const _ of runtime.run({ prompt: "First", errCode: 0, errMessage: "" })) { /* drain */ }
  for await (const _ of runtime.run({ prompt: "Second", errCode: 0, errMessage: "" }, {
    reportUsage: usage => { billed.push(usage); },
  })) { /* drain */ }
  const restored = JSON.parse(JSON.stringify(runtime.readTranscript!())) as AgentMessage[];
  const index = restored.findIndex(message => "projectInterrupted" in message);
  assert.ok(index > 0);
  const interrupted = restored[index] as typeof partial;
  assert.equal(interrupted.usage.totalTokens, billed[0]?.totalTokens, "diagnostic billed usage is retained");
  const prefix = restored.slice(0, index + 1);
  (prefix.find(message => message.role === "assistant") as typeof previous).usage = previous.usage;
  interrupted.usage = partial.usage;
  const tokens = estimateAgentContextTokens(prefix);
  assert.ok(tokens > 500 && tokens < 2_000, "the context uses the prior valid baseline plus retained text");
  const lengthLimited = ai.fauxAssistantMessage("kept text", { stopReason: "length" });
  lengthLimited.usage = partial.usage;
  assert.equal(estimateAgentContextTokens([previous, lengthLimited]), 2_000,
    "an unchanged response with valid length-limit usage still calibrates the context");
  await runtime.close();
});

test("model usage is reported before tools finish and each response is counted once", async () => {
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxToolCall("observe", {})], { stopReason: "toolUse" }),
    () => ai.fauxAssistantMessage("finished"),
  ]);
  const reported: AgentUsage[] = [];
  const contexts: number[] = [];
  let usageBeforeTool = false;
  pi.model.contextWindow = 10_000;
  const runtime = await createAgentRuntime({ pi, extraTools: [{
    name: "observe", label: "Observe", description: "Observe usage", parameters: ai.Type.Object({}),
    execute: async () => {
      usageBeforeTool = reported.length === 1;
      return { content: [ai.fauxText("result".repeat(200))], details: {} };
    },
  }] });
  for await (const event of runtime.run({ prompt: "observe", errCode: 0, errMessage: "" }, {
    reportUsage: (usage) => { reported.push(usage); },
  })) {
    if (event.type === "context_usage") contexts.push(event.usage.used);
  }
  assert.equal(usageBeforeTool, true);
  assert.equal(reported.length, 2);
  assert.ok(contexts.length > 3, "user, assistant, and tool messages must update the occupancy");
  assert.equal(runtime.getContextUsage()?.used, reported.at(-1)?.totalTokens);
});

test("usage hook errors are retained when the model emits later events", async () => {
  const { pi, ai } = await createFauxRuntime([() => ai.fauxAssistantMessage("answer")]);
  await assert.rejects(() => collectEvents({ pi }, { prompt: "hi" }, {
    reportUsage: () => { throw new Error("usage sink unavailable"); },
  }), /usage sink unavailable/);
});

test("a read-only policy offers the model no mutating tools", async () => {
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("ok")]),
  ]);

  await withTempDir(async (workdir) => {
    const runtime = await createAgentRuntime({ pi, workdir });
    const seen: string[] = [];
    for await (const event of runtime.run({
      prompt: "hi",
      errCode: 0,
      errMessage: "",
      permissionPolicy: "read-only",
    })) {
      if (event.type === "tool") seen.push(event.toolName);
    }

    const agent = (runtime as unknown as { agent?: { state: { tools: Array<{ name: string }> } } }).agent;
    assert.ok(agent, "runtime must have created an agent");
    const names = agent.state.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["find", "grep", "ls", "read"]);
    assert.deepEqual(seen, []);
  });
});

test("the workspace policy pauses a mutating tool for approval", async () => {
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxToolCall("write", { path: "note.txt", content: "x" })], { stopReason: "toolUse" }),
    () => ai.fauxAssistantMessage([ai.fauxText("done")]),
  ]);

  await withTempDir(async (workdir) => {
    const approvals: string[] = [];
    await collectEvents({ pi, workdir }, { prompt: "write a file", errCode: 0, errMessage: "" }, {
      approveToolCall: async ({ toolName }) => {
        approvals.push(toolName);
      },
    });

    assert.deepEqual(approvals, ["write"]);
    assert.equal(await readFile(path.join(workdir, "note.txt"), "utf8"), "x");
  });
});

test("a denied tool call becomes a tool error instead of running", async () => {
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxToolCall("write", { path: "note.txt", content: "x" })], { stopReason: "toolUse" }),
    () => ai.fauxAssistantMessage([ai.fauxText("blocked")]),
  ]);

  await withTempDir(async (workdir) => {
    const events = await collectEvents({ pi, workdir }, { prompt: "write a file", errCode: 0, errMessage: "" }, {
      approveToolCall: async () => {
        throw new Error("nope");
      },
    });

    const end = events.find((event) => event.type === "tool" && event.phase === "end");
    assert.ok(end && end.type === "tool");
    assert.equal(end.isError, true);
    await assert.rejects(() => readFile(path.join(workdir, "note.txt"), "utf8"));
  });
});

test("plan mode prompts for approval and streams the plan", async () => {
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("1. do the thing")]),
  ]);

  await withTempDir(async (workdir) => {
    const decisions: Array<{ requestId: string }> = [];
    const events = await collectEvents(
      { pi, workdir, sessionId: "s1" },
      { prompt: "plan it", errCode: 0, errMessage: "", agent: "plan" },
      {
        approvePlan: async ({ requestId }) => {
          decisions.push({ requestId });
          return { approved: true, requestId };
        },
      },
    );

    assert.equal(decisions.length, 1);
    assert.match(decisions[0]?.requestId ?? "", /^agent-plan-approval:s1:[a-f0-9-]+$/);
    const planEvents = events.filter((event) => event.type === "plan");
    assert.equal(planEvents.length, 2);
    assert.equal(
      events.some((event) => event.type === "approval" && event.approved === true),
      true,
    );
  });
});

test("plan approval excludes text spoken before a tool call", async () => {
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("Let me inspect the files. "), ai.fauxToolCall("ls", {})], { stopReason: "toolUse" }),
    () => ai.fauxAssistantMessage([ai.fauxText("1. read the code\n2. propose")]),
  ]);

  await withTempDir(async (workdir) => {
    const plans: string[] = [];
    const events = await collectEvents({ pi, workdir }, { prompt: "plan it", agent: "plan" }, {
      approvePlan: async ({ plan }) => {
        plans.push(plan);
        return { approved: true };
      },
    });

    assert.deepEqual(plans, ["1. read the code\n2. propose"]);
    assert.deepEqual(events.filter((event) => event.type === "plan").map((event) => event.text), [
      "1. read the code\n2. propose", "1. read the code\n2. propose",
    ]);
    assert.match(events.filter((event) => event.type === "text_delta").map((event) => event.delta).join(""),
      /^Let me inspect the files\. /);
  });
});

test("a plan turn with only tool introductions does not request plan approval", async () => {
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("Let me inspect the files. "), ai.fauxToolCall("ls", {})], { stopReason: "toolUse" }),
    () => ai.fauxAssistantMessage([]),
  ]);

  await withTempDir(async (workdir) => {
    let approvals = 0;
    const events = await collectEvents({ pi, workdir }, { prompt: "plan it", agent: "plan" }, {
      approvePlan: async () => {
        approvals += 1;
        return { approved: true };
      },
    });

    assert.equal(approvals, 0);
    assert.equal(events.some((event) => event.type === "plan"), false);
  });
});

test("a restored transcript is what the next run continues from", async () => {
  const requests: string[][] = [];
  const { pi, ai } = await createFauxRuntime([
    ((request: { messages: Array<{ role: string; content: unknown }> }) => {
      requests.push(request.messages.filter(message => message.role !== "system").map((message) => `${message.role}:${readRequestText(message.content)}`));
      return ai.fauxAssistantMessage([ai.fauxText("welcome back")]);
    }) as never,
  ]);

  await withTempDir(async (workdir) => {
    const runtime = await createAgentRuntime({ pi, workdir });
    runtime.restoreTranscript?.([
      { role: "user", content: "the earlier question", timestamp: 1 },
      ai.fauxAssistantMessage([ai.fauxText("the earlier answer")]),
    ] as never);

    for await (const _event of runtime.run({ prompt: "and now?", errCode: 0, errMessage: "" })) {
      // Drain the turn; the request it made is the assertion.
    }
  });

  assert.deepEqual(requests, [["user:the earlier question", "assistant:the earlier answer", "user:and now?"]]);
});

test("a restored transcript never replaces what the process already holds", async () => {
  const requests: string[][] = [];
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("first answer")]),
    ((request: { messages: Array<{ role: string; content: unknown }> }) => {
      requests.push(request.messages.filter(message => message.role !== "system").map((message) => `${message.role}:${readRequestText(message.content)}`));
      return ai.fauxAssistantMessage([ai.fauxText("second answer")]);
    }) as never,
  ]);

  await withTempDir(async (workdir) => {
    const runtime = await createAgentRuntime({ pi, workdir });
    for await (const _event of runtime.run({ prompt: "first", errCode: 0, errMessage: "" })) {
      // Drain the first turn so the runtime holds a transcript of its own.
    }

    // A host reads the store before every run, so the second run arrives
    // carrying the copy it loaded *before* the first one — restoring that would
    // delete the turn that just happened.
    runtime.restoreTranscript?.([{ role: "user", content: "first", timestamp: 1 }] as never);
    for await (const _event of runtime.run({ prompt: "second", errCode: 0, errMessage: "" })) {
      // Drain the second turn.
    }
  });

  assert.deepEqual(requests, [["user:first", "assistant:first answer", "user:second"]]);
});

test("a restored transcript over the window is compacted before it is sent", async () => {
  const requests: string[][] = [];
  const { pi, ai } = await createFauxRuntime([
    // The summarizer's own call comes first: it is the model asking for the
    // summary, not the turn.
    () => ai.fauxAssistantMessage([ai.fauxText("condensed history")]),
    ((request: { messages: Array<{ role: string; content: unknown }> }) => {
      requests.push(request.messages.filter(message => message.role !== "system").map((message) => `${message.role}:${readRequestText(message.content)}`));
      return ai.fauxAssistantMessage([ai.fauxText("carried on")]);
    }) as never,
  ]);

  await withTempDir(async (workdir) => {
    const runtime = await createAgentRuntime({
      pi,
      workdir,
      compaction: { enabled: true, threshold: 0.5, reserveTokens: 10, keepRecentTokens: 20 },
    });
    // Past the threshold of the 1000-token window the faux model declares,
    // which is the state a restored conversation reaches and a fresh one does
    // not: nothing bounds the transcript between two processes.
    runtime.restoreTranscript?.([
      { role: "user", content: "x".repeat(1_000), timestamp: 1 },
      ai.fauxAssistantMessage([ai.fauxText("y".repeat(1_000))]),
      { role: "user", content: "z".repeat(1_000), timestamp: 3 },
    ] as never);

    const events: AgentStreamEvent[] = [];
    for await (const event of runtime.run({ prompt: "carry on", errCode: 0, errMessage: "" })) {
      events.push(event);
    }

    const compaction = events.filter((event) => event.type === "compaction");
    assert.deepEqual(compaction, [
      { type: "compaction", phase: "start", auto: true },
      { type: "compaction", phase: "end", auto: true, summary: "condensed history" },
    ]);
    // Announced before the turn's own text: the model is asked with the
    // compacted transcript, and the row has to describe the request that was
    // actually made.
    assert.equal(events[0]?.type, "context_usage", "context appears before automatic compaction calls the provider");
    assert.ok(events.findIndex((event) => event.type === "compaction") <
      events.findIndex((event) => event.type === "text_delta"));
    assert.equal(requests.length, 1);
    assert.match(requests[0]?.[0] ?? "", /condensed history/);
  });
});

test("a transcript that fits is sent as it is", async () => {
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("ok")]),
  ]);

  await withTempDir(async (workdir) => {
    const runtime = await createAgentRuntime({
      pi,
      workdir,
      compaction: { enabled: true, threshold: 0.8, reserveTokens: 10, keepRecentTokens: 100_000 },
    });
    runtime.restoreTranscript?.([
      { role: "user", content: "a short earlier question", timestamp: 1 },
    ] as never);

    const events: AgentStreamEvent[] = [];
    for await (const event of runtime.run({ prompt: "hi", errCode: 0, errMessage: "" })) {
      events.push(event);
    }

    assert.deepEqual(events.filter((event) => event.type === "compaction"), []);
  });
});

test("manual compact immediately summarizes short context and replaces the actual transcript", async () => {
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("first answer, long enough to be worth compacting away")]),
    () => ai.fauxAssistantMessage([ai.fauxText("condensed history")]),
  ]);

  await withTempDir(async (workdir) => {
    const runtime = await createAgentRuntime({
      pi,
      workdir,
      compaction: { enabled: true, threshold: 0.8, reserveTokens: 10, keepRecentTokens: 100_000 },
    });
    for await (const _event of runtime.run({ prompt: "first", errCode: 0, errMessage: "" })) {
      // Drain the first turn so there is a transcript to compact.
    }

    const second: AgentStreamEvent[] = [];
    for await (const event of runtime.run({ prompt: "/compact", errCode: 0, errMessage: "", contextWindow: 5_000 })) {
      second.push(event);
    }

    const compaction = second.filter((event) => event.type === "compaction");
    assert.equal(compaction.length, 2);
    assert.equal(compaction[0]?.type === "compaction" && compaction[0].phase, "start");
    assert.equal(
      compaction[1]?.type === "compaction" ? compaction[1].summary : undefined,
      "condensed history",
    );
    const usage = [...second].reverse().find((event) => event.type === "context_usage");
    assert.ok(usage, "manual compaction updates context occupancy");
    assert.equal(usage.usage.total, 5_000);
    assert.ok(usage.usage.used > 0 && Number.isFinite(usage.usage.used));
    assert.equal(second.at(-1), usage, "occupancy is reported after the transcript was compacted");
    assert.equal(runtime.readTranscript?.().length, 1);
    assert.match(JSON.stringify(runtime.readTranscript?.()), /condensed history/);
    assert.doesNotMatch(JSON.stringify(runtime.readTranscript?.()), /first answer/);
  });
});

for (const stopReason of ["error", "aborted", "length", "toolUse", "pending", "deferred"] as const) {
  test(`manual compact preserves the transcript when the summary ends with ${stopReason}`, async () => {
    const { pi, ai } = await createFauxRuntime([]);
    pi.models.completeSimple = async () => ai.fauxAssistantMessage("incomplete summary", {
      stopReason, errorMessage: stopReason === "error" ? "Summary provider failed" : undefined,
    });
    await withTempDir(async (workdir) => {
      const runtime = await createAgentRuntime({ pi, workdir });
      runtime.restoreTranscript?.([{ role: "user", content: "original request", timestamp: 1 }, ai.fauxAssistantMessage("original answer")]);
      const before = structuredClone(runtime.readTranscript?.());
      const events: AgentStreamEvent[] = [];
      await assert.rejects(async () => {
        for await (const event of runtime.run({ prompt: "/compact", errCode: 0, errMessage: "" })) events.push(event);
      }, stopReason === "error" ? /Summary provider failed/ : /compaction summary/i);
      assert.deepEqual(runtime.readTranscript?.(), before);
      assert.deepEqual(events.filter(event => event.type === "compaction"), [{ type: "compaction", phase: "start", auto: false }]);
    });
  });
}

test("manual compact preserves the transcript when the provider returns after cancellation", async () => {
  const { pi, ai } = await createFauxRuntime([]);
  const controller = new AbortController();
  pi.models.completeSimple = async () => {
    controller.abort(new Error("Summary cancelled"));
    return ai.fauxAssistantMessage("late summary");
  };
  await withTempDir(async (workdir) => {
    const runtime = await createAgentRuntime({ pi, workdir });
    runtime.restoreTranscript?.([{ role: "user", content: "original request", timestamp: 1 }, ai.fauxAssistantMessage("original answer")]);
    const before = structuredClone(runtime.readTranscript?.());
    const events: AgentStreamEvent[] = [];
    await assert.rejects(async () => {
      for await (const event of runtime.run({ prompt: "/compact", errCode: 0, errMessage: "" }, { abortSignal: controller.signal })) events.push(event);
    }, error => error instanceof HarnessError && error.type === "execution_aborted" && /Summary cancelled/.test(error.message));
    assert.deepEqual(runtime.readTranscript?.(), before);
    assert.deepEqual(events.filter(event => event.type === "compaction"), [{ type: "compaction", phase: "start", auto: false }]);
  });
});

for (const outcome of ["success", "error", "cancelled"] as const) {
  test(`manual compact reports summary usage exactly once on ${outcome}`, async () => {
    const { pi, ai } = await createFauxRuntime([]);
    const controller = new AbortController();
    pi.models.completeSimple = async () => {
      const message = ai.fauxAssistantMessage("summary", { stopReason: outcome === "error" ? "error" : "stop", errorMessage: outcome === "error" ? "Summary provider failed" : undefined });
      message.usage = { ...message.usage, input: 120, output: 30, cacheRead: 20, cacheWrite: 10, reasoning: 5, totalTokens: 180 };
      if (outcome === "cancelled") controller.abort(new Error("Summary cancelled"));
      return message;
    };
    await withTempDir(async workdir => {
      const runtime = await createAgentRuntime({ pi, workdir });
      runtime.restoreTranscript?.([{ role: "user", content: "original request", timestamp: 1 }, ai.fauxAssistantMessage("original answer")]);
      const usages: AgentUsage[] = [];
      const host: AgentHost = { abortSignal: controller.signal, reportUsage: async usage => { usages.push(usage); } };
      const run = async () => { for await (const _event of runtime.run({ prompt: "/compact", errCode: 0, errMessage: "" }, host)) {} };
      if (outcome === "success") {
        await run();
        assert.ok((runtime.getContextUsage()?.used ?? 0) < 180);
      } else {
        await assert.rejects(run, outcome === "error" ? /Summary provider failed/ : /Summary cancelled/);
      }
      assert.deepEqual(usages, [{ inputTokens: 120, outputTokens: 30, totalTokens: 180, cacheReadTokens: 20, cacheWriteTokens: 10, reasoningTokens: 5 }]);
    });
  });
}

test("compact with an empty context completes without calling the model", async () => {
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("hi")]),
  ]);

  await withTempDir(async (workdir) => {
    const runtime = await createAgentRuntime({
      pi,
      workdir,
      compaction: { enabled: true, threshold: 0.8, reserveTokens: 10, keepRecentTokens: 100_000 },
    });
    const events: AgentStreamEvent[] = [];
    for await (const event of runtime.run({ prompt: "/compact", errCode: 0, errMessage: "" })) {
      events.push(event);
    }

    const compaction = events.filter((event) => event.type === "compaction");
    assert.equal(compaction.length, 1);
    assert.equal(compaction[0]?.type === "compaction" && compaction[0].phase, "end");
    assert.ok(events.some((event) => event.type === "context_usage"), "a no-op compaction still reports the current occupancy");
  });
});

test("a custom endpoint gets a window from the model family table", () => {
  // A caller-supplied endpoint is absent from pi's catalog, so without a table
  // the composer row would divide by a number nobody chose.
  assert.equal(resolveAgentModelContextWindow("MiniMax-M3"), DEFAULT_AGENT_CONTEXT_WINDOW);
  assert.equal(resolveAgentModelContextWindow("gpt-5.6-terra"), 872_000);
  assert.equal(resolveAgentModelContextWindow("claude-sonnet-5"), 200_000);
  assert.equal(resolveAgentModelContextWindow("deepseek-v4"), 1_000_000);
  // Credential ids may be namespaced.
  assert.equal(resolveAgentModelContextWindow("vendor/claude-opus-4"), 200_000);
  assert.equal(resolveAgentModelContextWindow(""), DEFAULT_AGENT_CONTEXT_WINDOW);
});

test("the run's context usage is keyed by the input the caller holds", () => {
  const original = { prompt: "hi" };
  const rewritten = { ...original, baseUrl: "http://127.0.0.1:1/x/v1" };

  // The system-AI path hands the node a rewritten input while finalize and the
  // project's format are handed the original. Recording against the rewrite is
  // exactly the bug that kept the composer row from ever appearing.
  recordAgentRunContextUsage(rewritten, { used: 1, total: 10 });
  assert.equal(readAgentRunContextUsage(original), undefined);

  const usage = { used: 42, total: 272_000 };
  recordAgentRunContextUsage(original, usage);
  assert.deepEqual(readAgentRunContextUsage(original), usage);
});

test("each run carries its own system prompt", async () => {
  const seen: string[] = [];
  const { pi, ai } = await createFauxRuntime([
    (context: { messages: import("@earendil-works/pi-ai").Message[] }) => {
      seen.push(ai.getCurrentSystemPrompt(context.messages));
      return ai.fauxAssistantMessage([ai.fauxText("ok")]);
    },
    (context: { messages: import("@earendil-works/pi-ai").Message[] }) => {
      seen.push(ai.getCurrentSystemPrompt(context.messages));
      return ai.fauxAssistantMessage([ai.fauxText("ok")]);
    },
  ] as never[]);

  await withTempDir(async (workdir) => {
    const runtime = await createAgentRuntime({ pi, workdir, systemPrompt: "default persona" });

    for await (const _event of runtime.run({ prompt: "a", errCode: 0, errMessage: "" })) { void _event; }
    for await (const _event of runtime.run({
      prompt: "b",
      errCode: 0,
      errMessage: "",
      systemPrompt: "per-run persona",
    })) { void _event; }

    // The runtime's own prompt is the fallback; a run may replace it.
    assert.deepEqual(seen, ["default persona", "per-run persona"]);
  });
});

test("plan mode leads with the plan contract and keeps the caller's persona", async () => {
  const { ai } = await createFauxRuntime([]);
  const seen: string[] = [];
  const faux = await createFauxRuntime([
    (context: { messages: import("@earendil-works/pi-ai").Message[] }) => {
      seen.push(ai.getCurrentSystemPrompt(context.messages));
      return ai.fauxAssistantMessage([ai.fauxText("plan")]);
    },
  ] as never[]);

  await withTempDir(async (workdir) => {
    const runtime = await createAgentRuntime({ pi: faux.pi, workdir, systemPrompt: "you are the assistant" });
    for await (const _event of runtime.run({ prompt: "plan it", errCode: 0, errMessage: "", agent: "plan" })) { void _event; }

    // The read-only contract has to lead, but the persona must survive.
    assert.match(seen[0] ?? "", /plan mode/u);
    assert.match(seen[0] ?? "", /you are the assistant/u);
    assert.ok((seen[0] ?? "").indexOf("plan mode") < (seen[0] ?? "").indexOf("you are the assistant"));
  });
});

test("hands the images to the model as content blocks", async () => {
  const seen: Array<Array<{ type?: string }>> = [];
  const { pi, ai } = await createFauxRuntime([
    (context: { messages: Array<{ content: unknown }> }) => {
      const last = context.messages.at(-1);
      seen.push(Array.isArray(last?.content) ? (last.content as Array<{ type?: string }>) : []);
      return ai.fauxAssistantMessage([ai.fauxText("looked")]);
    },
  ] as never[]);

  await withTempDir(async (workdir) => {
    const runtime = await createAgentRuntime({ pi, workdir });
    for await (const _event of runtime.run({
      prompt: "what is this",
      errCode: 0,
      errMessage: "",
      images: [{ data: "aGk=", mimeType: "image/png" }],
    })) { void _event; }

    // The layer used to parse images and then drop them on the floor.
    assert.equal(seen[0]?.some((part) => part.type === "image"), true);
  });
});

test("an image-only turn sends the images without an empty text block", async () => {
  const seen: Array<Array<{ type?: string; text?: string }>> = [];
  const { pi, ai } = await createFauxRuntime([
    (context: { messages: Array<{ content: unknown }> }) => {
      const last = context.messages.at(-1);
      seen.push(Array.isArray(last?.content) ? (last.content as Array<{ type?: string; text?: string }>) : []);
      return ai.fauxAssistantMessage([ai.fauxText("looked")]);
    },
  ] as never[]);

  await withTempDir(async (workdir) => {
    const runtime = await createAgentRuntime({ pi, workdir });
    for await (const _event of runtime.run({
      prompt: "",
      errCode: 0,
      errMessage: "",
      images: [{ data: "aGk=", mimeType: "image/png" }],
    })) { void _event; }

    // pi builds `[{ type: "text", text: "" }, ...images]` for a string prompt,
    // and an empty text block is a part several providers reject outright, so
    // the message is assembled here instead.
    assert.deepEqual(seen[0]?.map((part) => part.type), ["image"]);
  });
});

test("caller-supplied tools run alongside the built-ins", async () => {
  const calls: string[] = [];
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxToolCall("external_thing", { value: "x" })], { stopReason: "toolUse" }),
    () => ai.fauxAssistantMessage([ai.fauxText("done")]),
  ]);

  await withTempDir(async (workdir) => {
    const runtime = await createAgentRuntime({ pi, workdir });
    runtime.setExternalTools([{
      name: "external_thing",
      label: "External",
      description: "A caller-supplied tool.",
      parameters: { type: "object", properties: { value: { type: "string" } } },
      execute: async (_id: string, params: { value: string }) => {
        calls.push(params.value);
        return { content: [{ type: "text", text: "ran" }], details: {} };
      },
    } as never]);

    const names: string[] = [];
    for await (const event of runtime.run({ prompt: "go", errCode: 0, errMessage: "" })) {
      if (event.type === "tool" && event.phase === "start") names.push(event.toolName);
    }

    assert.deepEqual(calls, ["x"]);
    assert.deepEqual(names, ["external_thing"]);
  });
});

/**
 * A project writes its own tools from a plain JSON Schema: `Type` is Core's,
 * not theirs, so the schema they hand over is an ordinary object rather than a
 * TypeBox type. Everything the schema says still has to be enforced — a
 * contract that only looks like one is worse than none.
 */
test("a caller-supplied tool's JSON Schema is enforced, not decorative", async () => {
  const calls: unknown[] = [];
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxToolCall("external_thing", { wrong: 1 })], { stopReason: "toolUse" }),
    () => ai.fauxAssistantMessage([ai.fauxText("done")]),
  ]);

  await withTempDir(async (workdir) => {
    const runtime = await createAgentRuntime({ pi, workdir });
    runtime.setExternalTools([{
      name: "external_thing",
      label: "External",
      description: "A caller-supplied tool.",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      execute: async (_id: string, params: unknown) => {
        calls.push(params);
        return { content: [{ type: "text", text: "ran" }], details: {} };
      },
    } as never]);

    const failures: unknown[] = [];
    for await (const event of runtime.run({ prompt: "go", errCode: 0, errMessage: "" })) {
      if (event.type === "tool" && event.phase === "end" && event.isError === true) {
        failures.push(event.result);
      }
    }

    assert.deepEqual(calls, [], "an argument that fails the schema never reaches the tool");
    assert.equal(failures.length, 1);
    assert.match(JSON.stringify(failures[0]), /value/);
  });
});

test("the bridge URL is trimmed for the SDK that has to append /v1 itself", () => {
  const bridge = "http://127.0.0.1:63584/43f4b8f50db851fbd677ed42203dd2e162b15ccf7d953b51/v1";

  // @anthropic-ai/sdk takes the API root and appends /v1/messages, so the
  // /v1 the bridge advertises would be doubled.
  assert.equal(
    resolveAgentBridgeBaseUrl("anthropic", bridge),
    "http://127.0.0.1:63584/43f4b8f50db851fbd677ed42203dd2e162b15ccf7d953b51",
  );
  // The OpenAI client already appends /responses to a base that ends at /v1.
  assert.equal(resolveAgentBridgeBaseUrl("openai-responses", bridge), bridge);

  // A trailer without /v1 is left alone rather than mangled.
  assert.equal(resolveAgentBridgeBaseUrl("anthropic", "https://api.example.com"), "https://api.example.com");
});

test("a symbolic link inside the workspace cannot carry a tool out of it", async () => {
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("read")]),
  ]);

  await withTempDir(async (workdir) => {
    const outside = await mkdtemp(path.join(tmpdir(), "workflow-agent-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "the neighbours' secret", "utf8");
      // The lexical guard this used to rely on is satisfied by both links.
      await symlink(path.join(outside, "secret.txt"), path.join(workdir, "linked.txt"));
      await symlink(outside, path.join(workdir, "linked-dir"), "dir");

      const runtime = await createAgentRuntime({ pi, workdir });
      for await (const _event of runtime.run({ prompt: "go", errCode: 0, errMessage: "" })) {
        // Drain the run so the runtime finishes construction.
      }

      const agent = (runtime as unknown as { agent: { state: { tools: Array<{ name: string; execute: Function }> } } }).agent;
      const read = agent.state.tools.find((tool) => tool.name === "read");
      const write = agent.state.tools.find((tool) => tool.name === "write");
      const list = agent.state.tools.find((tool) => tool.name === "ls");
      assert.ok(read && write && list);

      await assert.rejects(
        () => read.execute("call-1", { path: "linked.txt" }),
        /outside the directories/,
      );
      await assert.rejects(
        () => read.execute("call-2", { path: "linked-dir/secret.txt" }),
        /outside the directories/,
      );
      // A write through the same link would clobber the file it points at.
      await assert.rejects(
        () => write.execute("call-3", { path: "linked-dir/written.txt", content: "x" }),
        /outside the directories/,
      );
      // Listing the link itself is refused too: it is a directory outside.
      await assert.rejects(
        () => list.execute("call-4", { path: "linked-dir" }),
        /outside the directories/,
      );
      assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "the neighbours' secret");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("the edit tool replaces text literally", async () => {
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("ok")]),
  ]);

  await withTempDir(async (workdir) => {
    await writeFile(path.join(workdir, "note.md"), "hello world", "utf8");
    const runtime = await createAgentRuntime({ pi, workdir });
    for await (const _event of runtime.run({ prompt: "go", errCode: 0, errMessage: "" })) {
      // Drain the run so the runtime finishes construction.
    }

    const agent = (runtime as unknown as { agent: { state: { tools: Array<{ name: string; execute: Function }> } } }).agent;
    const edit = agent.state.tools.find((tool) => tool.name === "edit");
    assert.ok(edit);
    await edit.execute("call-1", {
      path: "note.md",
      edits: [{ oldText: "world", newText: "you $& and $' too" }],
    });

    // `$&` and `$'` are replacement patterns to String.replace, and two
    // characters to whoever typed them into a file.
    assert.equal(await readFile(path.join(workdir, "note.md"), "utf8"), "hello you $& and $' too");
  });
});

test("a file too large to load is read as the slice that was asked for", async () => {
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("ok")]),
  ]);

  await withTempDir(async (workdir) => {
    const line = `${"x".repeat(999)}\n`;
    await writeFile(path.join(workdir, "big.log"), line.repeat(9_000), "utf8");
    const runtime = await createAgentRuntime({ pi, workdir });
    for await (const _event of runtime.run({ prompt: "go", errCode: 0, errMessage: "" })) {
      // Drain the run so the runtime finishes construction.
    }

    const agent = (runtime as unknown as { agent: { state: { tools: Array<{ name: string; execute: Function }> } } }).agent;
    const read = agent.state.tools.find((tool) => tool.name === "read");
    assert.ok(read);
    const result = await read.execute("call-1", { path: "big.log", offset: 5, limit: 3 });
    const text = result.content[0].text as string;
    assert.match(text, /^5\tx{999}\n6\tx{999}\n7\tx{999}/);
    assert.match(text, /large file/);
  });
});

test("a turn the provider refused fails the run instead of reporting an empty success", async () => {
  // pi does not reject when the stream fails: it records the message on the
  // agent and resolves, which used to leave a run that "succeeded" with no
  // output at all and a host waiting on output that never came.
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream refused the request" }),
  ]);

  await withTempDir(async (workdir) => {
    await assert.rejects(
      () => collectEvents({ pi, workdir }, { prompt: "hi", errCode: 0, errMessage: "" }),
      /upstream refused the request/,
    );
  });
});

test("a cancelled run stops the turn and is reported as aborted", async () => {
  const controller = new AbortController();
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxToolCall("cancel_now", {})], { stopReason: "toolUse" }),
    () => ai.fauxAssistantMessage([ai.fauxText("this turn should never run")]),
  ]);

  await withTempDir(async (workdir) => {
    const runtime = await createAgentRuntime({
      pi,
      workdir,
      externalTools: [{
        name: "cancel_now",
        label: "Cancel",
        description: "Cancel the run.",
        parameters: {},
        async execute() {
          controller.abort(new Error("user cancelled"));
          return { content: [{ type: "text" as const, text: "cancelling" }], details: {} };
        },
      }] as never,
    });

    const deltas: string[] = [];
    await assert.rejects(
      async () => {
        for await (const event of runtime.run(
          { prompt: "go", errCode: 0, errMessage: "" },
          { abortSignal: controller.signal },
        )) {
          if (event.type === "text_delta") deltas.push(event.delta);
        }
      },
      (error: unknown) => error instanceof HarnessError && error.type === "execution_aborted",
    );

    assert.equal(deltas.join("").includes("never run"), false);
  });
});

test("a run that arrives after the cancellation does not start", async () => {
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("hello")]),
  ]);

  await withTempDir(async (workdir) => {
    const controller = new AbortController();
    controller.abort();
    const runtime = await createAgentRuntime({ pi, workdir });

    await assert.rejects(
      async () => {
        for await (const _event of runtime.run(
          { prompt: "go", errCode: 0, errMessage: "" },
          { abortSignal: controller.signal },
        )) {
          // Nothing should be produced.
        }
      },
      (error: unknown) => error instanceof HarnessError && error.type === "execution_aborted",
    );
  });
});

test("an unset effort keeps the runtime's, and an empty one asks for the model's", async () => {
  // Both of these arrive from a command line, where the type is a claim and
  // the string is whatever the host passed.
  const asInput = (effort?: string): AgentInput =>
    ({ prompt: "hello", errCode: 0, errMessage: "", ...(effort === undefined ? {} : { effort }) }) as unknown as AgentInput;

  // Nothing named at all: the project's own effort applies.
  assert.equal(
    parseAgentInput(asInput(), { workdir: "/tmp/ws", effort: "high" }).effort,
    "high",
  );
  // The built-in param's "let the model decide" is an empty value, and pi asks
  // for that by naming no level: its `off`.
  assert.equal(
    parseAgentInput(asInput(""), { workdir: "/tmp/ws", effort: "high" }).effort,
    "off",
  );
  // A level this runtime cannot parse is not a request for some middle
  // setting either.
  assert.equal(
    parseAgentInput(asInput("brisk"), { workdir: "/tmp/ws", effort: "high" }).effort,
    "high",
  );
});

test("compaction keeps the newest turn when the tail holds no user message", () => {
  // A long tool-heavy turn since the user's request: the kept window contains
  // no user turn at all, which used to send the split to the end of the
  // transcript and summarize everything the run was still working on.
  const toolLoop = Array.from({ length: 20 }, (_value, index) => [
    { role: "assistant", content: [{ type: "text", text: `step ${String(index)} ${"a".repeat(60)}` }] },
    { role: "toolResult", content: `result ${String(index)} ${"b".repeat(60)}` },
  ]).flat();
  const messages = [
    { role: "user", content: "do the thing" },
    ...toolLoop,
  ] as unknown as Parameters<typeof findCompactionSplitIndex>[0];

  const index = findCompactionSplitIndex(messages, 50);
  assert.ok(index > 0, "the transcript is long enough to need compacting");
  assert.ok(index < messages.length, "the newest message must survive");
  // Falling back to an assistant turn keeps a tool result from starting the
  // tail without the message that asked for it.
  assert.equal((messages[index] as unknown as { role: string }).role, "assistant");
});

test("the token estimate charges CJK as more than latin", () => {
  // The composer row shows this number as the context in use; four latin
  // characters are about a token, one Han character is about a token.
  assert.equal(estimateAgentTokens("abcd"), 1);
  assert.equal(estimateAgentTokens("你好世界"), 4);
});

test("compaction keeps the newest message even when it alone exceeds the window", () => {
  const messages = [
    { role: "user", content: "read the log" },
    { role: "assistant", content: [{ type: "text", text: "reading" }] },
    { role: "toolResult", content: "x".repeat(100_000) },
  ] as unknown as Parameters<typeof findCompactionSplitIndex>[0];

  const index = findCompactionSplitIndex(messages, 100);
  assert.ok(index < messages.length, "the huge result must be kept");
  assert.equal(index, 1);
});

test("compaction splits at the user turn the window lands in", () => {
  const messages = [
    { role: "user", content: "first request" },
    { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    { role: "user", content: "second request" },
    { role: "assistant", content: [{ type: "text", text: "second answer" }] },
  ] as unknown as Parameters<typeof findCompactionSplitIndex>[0];

  // A 20-token window reaches back into the first exchange, so the split
  // aligns forward to the next user turn rather than cutting a tool result
  // from the message that asked for it.
  assert.equal(findCompactionSplitIndex(messages, 20), 2);
  // A transcript that fits entirely has nothing to drop.
  assert.equal(findCompactionSplitIndex(messages, 10_000), 0);
});

test("built-in tools read and write inside the working directory only", async () => {
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("read")]),
  ]);

  await withTempDir(async (workdir) => {
    await writeFile(path.join(workdir, "note.txt"), "line one\nline two", "utf8");
    const runtime = await createAgentRuntime({ pi, workdir });
    for await (const _event of runtime.run({ prompt: "go", errCode: 0, errMessage: "" })) {
      // Drain the run so the runtime finishes construction.
    }

    const agent = (runtime as unknown as { agent: { state: { tools: Array<{ name: string; execute: Function }> } } }).agent;
    const read = agent.state.tools.find((tool) => tool.name === "read");
    assert.ok(read);
    const result = await read.execute("call-1", { path: "note.txt" });
    assert.match(JSON.stringify(result.content), /line two/);

    await assert.rejects(
      () => read.execute("call-2", { path: "../../etc/hosts" }),
      /outside the directories/,
    );
  });
});

/**
 * The failure this covers: the model streams part of an answer, the connection
 * dies, and the text it already wrote is on the user's screen. Replaying the
 * request is not an option — the half answer is in the transcript — so the turn
 * is resumed instead, against the same budget one model call gets.
 */
test("a stream cut off mid-answer is continued rather than failed", async () => {
  const requests: string[][] = [];
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("half an answer")], {
      stopReason: "error",
      errorMessage: "terminated",
    }),
    ((request: { messages: Array<{ role: string; content: unknown }> }) => {
      requests.push(request.messages.filter(message => message.role !== "system").map((message) => `${message.role}:${readRequestText(message.content)}`));
      return ai.fauxAssistantMessage([ai.fauxText(" and the rest")]);
    }) as never,
  ]);

  await withTempDir(async (workdir) => {
    const events = await collectEvents(
      { pi, workdir, retryDelayMs: 0 },
      { prompt: "write it", errCode: 0, errMessage: "" },
    );

    assert.equal(
      events.filter((event) => event.type === "text_delta").map((event) => event.delta).join(""),
      "half an answer and the rest",
    );
    const retries = events.filter((event) => event.type === "retry");
    assert.equal(retries.length, 1);
    assert.equal(retries[0]?.attempt, 1);
    assert.equal(retries[0]?.maxAttempts, 10);
    assert.equal(retries[0]?.reason, "terminated");
    assert.deepEqual(events.flatMap(event => event.type === "text_delta" ? [`text:${event.delta}`]
      : event.type === "retry" ? [`retry:${event.attempt}`] : []),
    ["text:half an answer", "retry:1", "text: and the rest"]);
  });

  // The half answer is what the continuation is asked from. Sending the
  // original prompt again would ask for the whole thing twice.
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.slice(0, 2), ["user:write it", "assistant:half an answer"]);
  assert.match(requests[0]?.[2] ?? "", /^user:Your previous response was cut off/);
});

test("a continuation never sends the tool call that never ran", async () => {
  const requests: string[] = [];
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage(
      [ai.fauxText("let me write that"), ai.fauxToolCall("write", { path: "a.ts", content: "x" })],
      { stopReason: "error", errorMessage: "terminated" },
    ),
    ((request: { messages: Array<{ role: string; content: unknown }> }) => {
      requests.push(request.messages.filter(message => message.role !== "system").map((message) => readRequestText(message.content)).join("|"));
      return ai.fauxAssistantMessage([ai.fauxText("written")]);
    }) as never,
  ]);

  await withTempDir(async (workdir) => {
    await collectEvents(
      { pi, workdir, retryDelayMs: 0 },
      { prompt: "write a.ts", errCode: 0, errMessage: "" },
    );
  });

  assert.equal(requests.length, 1);
  assert.ok(requests[0]?.includes("let me write that"), "the sentence stays");
  assert.ok(!requests[0]?.includes("<toolCall:write>"), "an unanswered call would be refused outright");
});

test("a turn that keeps dropping gives up saying what happened", async () => {
  const { pi, ai } = await createFauxRuntime(
    Array.from({ length: 12 }, () => () => ai.fauxAssistantMessage([ai.fauxText("starting again")], {
      stopReason: "error",
      errorMessage: "terminated",
    })),
  );

  await withTempDir(async (workdir) => {
    await assert.rejects(
      collectEvents(
        { pi, workdir, retryDelayMs: 0 },
        { prompt: "go", errCode: 0, errMessage: "" },
      ),
      (error: Error) => {
        // The transport's one-word error is not an answer the user can act on,
        // and the count is the drops that happened — the budget allows ten
        // continuations, so the last attempt is an eleventh call.
        assert.match(error.message, /cut off mid-answer 11 times/);
        assert.match(error.message, /terminated/);
        return true;
      },
    );
  });
});

/**
 * The failure this covers: the model composes a tool call after a long
 * reasoning block, hits the output token ceiling the request was sent with, and
 * the provider reports that as an ordinary finish. Nothing failed, so the turn
 * used to be finalized as a success — the sentence announcing the action was
 * the whole answer, and the action never happened. Reported to the user as the
 * agent stopping halfway through, with no error to explain it.
 */
test("a turn cut off by the output limit is continued rather than finished", async () => {
  const requests: string[] = [];
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("✅ 攻略拿到了。写入知识库：")], {
      stopReason: "length",
    }),
    ((request: { messages: Array<{ role: string; content: unknown }> }) => {
      requests.push(request.messages.filter(message => message.role !== "system").map((message) => `${message.role}:${readRequestText(message.content)}`).join("|"));
      return ai.fauxAssistantMessage([ai.fauxText("已写入")]);
    }) as never,
  ]);

  await withTempDir(async (workdir) => {
    const events = await collectEvents(
      { pi, workdir, retryDelayMs: 0 },
      { prompt: "write it", errCode: 0, errMessage: "" },
    );

    assert.equal(
      events.filter((event) => event.type === "text_delta").map((event) => event.delta).join(""),
      "✅ 攻略拿到了。写入知识库：已写入",
    );
    const retries = events.filter((event) => event.type === "retry");
    assert.equal(retries.length, 1);
    assert.equal(retries[0]?.attempt, 1);
    // The output limit has its own, smaller budget, and the row says so.
    assert.equal(retries[0]?.maxAttempts, AGENT_OUTPUT_LIMIT_MAX_RETRIES);
    assert.equal(retries[0]?.kind, "length");
    assert.match(retries[0]?.reason ?? "", /max output tokens/);
  });

  // The half-written sentence is what the continuation is asked from, and the
  // continuation has to be told *why* it was cut: whatever the model was
  // composing did not fit, so it has to send that action on its own rather than
  // write its way up to it again and stop at the same ceiling.
  assert.equal(requests.length, 1);
  assert.ok(requests[0]?.includes("✅ 攻略拿到了。写入知识库："), "the sentence stays");
  assert.match(requests[0] ?? "", /output token limit/);
  assert.match(requests[0] ?? "", /the tool call on its own/);
});

test("a turn that keeps hitting the output limit gives up saying what happened", async () => {
  const { pi, ai } = await createFauxRuntime(
    Array.from({ length: 5 }, () => () => ai.fauxAssistantMessage([ai.fauxText("写入知识库：")], {
      stopReason: "length",
    })),
  );

  await withTempDir(async (workdir) => {
    const runtime = await createAgentRuntime({ pi, workdir, retryDelayMs: 0 });
    const events: AgentStreamEvent[] = [];
    await assert.rejects(async () => {
      for await (const event of runtime.run({ prompt: "go", errCode: 0, errMessage: "" })) {
        events.push(event);
      }
    }, (error: Error) => {
      // The budget allows two continuations, so the last attempt is a third
      // call. The message has to name the one thing that actually fixes this,
      // and it must not blame the connection — nothing was disconnected.
      assert.match(error.message, /ran out of output tokens mid-answer 3 times/);
      assert.match(error.message, /max output tokens/);
      assert.match(error.message, /maxTokens/);
      assert.doesNotMatch(error.message, /connection/);
      return true;
    });

    assert.equal(
      events.filter((event) => event.type === "retry").length,
      AGENT_OUTPUT_LIMIT_MAX_RETRIES,
    );
  });
});

test("an output-limit continuation does not spend the connection budget", async () => {
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("写入知识库：")], { stopReason: "length" }),
    () => ai.fauxAssistantMessage([ai.fauxText("再试一次：")], {
      stopReason: "error",
      errorMessage: "terminated",
    }),
    () => ai.fauxAssistantMessage([ai.fauxText("已写入")]),
  ]);

  await withTempDir(async (workdir) => {
    const events = await collectEvents(
      { pi, workdir, retryDelayMs: 0 },
      { prompt: "write it", errCode: 0, errMessage: "" },
    );

    // Two budgets, two counters: the drop is the first drop even though a
    // continuation already happened, and the row reports the budget it spent.
    assert.deepEqual(
      events
        .filter((event) => event.type === "retry")
        .map((event) => [event.attempt, event.maxAttempts, event.kind]),
      [
        [1, AGENT_OUTPUT_LIMIT_MAX_RETRIES, "length"],
        [1, AGENT_PROVIDER_MAX_RETRIES, "dropped"],
      ],
    );
  });
});

test("an output-limit stop with nothing produced is not continued", async () => {
  let calls = 0;
  const { pi, ai } = await createFauxRuntime([
    () => {
      calls += 1;
      return ai.fauxAssistantMessage([], { stopReason: "length" });
    },
  ]);

  await withTempDir(async (workdir) => {
    const events = await collectEvents(
      { pi, workdir, retryDelayMs: 0 },
      { prompt: "go", errCode: 0, errMessage: "" },
    );

    // Same rule as a drop: with nothing produced there is nothing to carry on
    // from, and re-sending the prompt is the request the stream wrapper owns.
    assert.equal(events.filter((event) => event.type === "retry").length, 0);
    assert.equal(calls, 1);
  });
});

/**
 * The failure this covers: the response says it is calling a tool and carries
 * no tool call. Every adapter sets that stop reason from the provider's own
 * field, separately from whether the block survived the trip — so it is the
 * message contradicting itself, and what it means is that the call was dropped
 * on the way here. Reported as a finished text-only answer, this is how work
 * disappears without a trace: the user sees the model stop and nothing else.
 */
test("a response that promises a tool call and carries none is re-asked", async () => {
  const requests: string[] = [];
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("✅ 攻略拿到了。写入知识库：")], {
      stopReason: "toolUse",
    }),
    ((request: { messages: Array<{ role: string; content: unknown }> }) => {
      requests.push(request.messages.filter(message => message.role !== "system").map((message) => `${message.role}:${readRequestText(message.content)}`).join("|"));
      return ai.fauxAssistantMessage([ai.fauxText("已写入")]);
    }) as never,
  ]);

  await withTempDir(async (workdir) => {
    const events = await collectEvents(
      { pi, workdir, retryDelayMs: 0 },
      { prompt: "write it", errCode: 0, errMessage: "" },
    );

    const retries = events.filter((event) => event.type === "retry");
    assert.equal(retries.length, 1);
    assert.equal(retries[0]?.kind, "lost-call");
    assert.equal(retries[0]?.reason, "tool call missing");
    // Counted with the drops, not with the output limit: this is the transport
    // losing part of the answer.
    assert.equal(retries[0]?.maxAttempts, AGENT_PROVIDER_MAX_RETRIES);
  });

  // The continuation says what actually went wrong, so the model makes the call
  // again instead of carrying on as if it had already been made.
  assert.equal(requests.length, 1);
  assert.match(requests[0] ?? "", /no tool call arrived/);
  assert.match(requests[0] ?? "", /Make that tool call again/);
});

test("a tool call that never arrives gives up saying what went missing", async () => {
  const { pi, ai } = await createFauxRuntime(
    Array.from({ length: 12 }, () => () => ai.fauxAssistantMessage([ai.fauxText("写入知识库：")], {
      stopReason: "toolUse",
    })),
  );

  await withTempDir(async (workdir) => {
    await assert.rejects(
      collectEvents(
        { pi, workdir, retryDelayMs: 0 },
        { prompt: "go", errCode: 0, errMessage: "" },
      ),
      (error: Error) => {
        // Nothing in the answer can show a missing call, so the error has to.
        assert.match(error.message, /tool call the model made went missing 11 times/);
        assert.match(error.message, /tool call missing/);
        return true;
      },
    );
  });
});

test("a response that promised a call and carried nothing is still re-asked", async () => {
  // The contradiction is checked before the "produced nothing" guard: a
  // continuation is not the same request sent twice, so an empty response that
  // contradicts itself is still worth re-asking.
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([], { stopReason: "toolUse" }),
    () => ai.fauxAssistantMessage([ai.fauxText("done")]),
  ]);

  await withTempDir(async (workdir) => {
    const events = await collectEvents(
      { pi, workdir, retryDelayMs: 0 },
      { prompt: "go", errCode: 0, errMessage: "" },
    );

    assert.equal(events.filter((event) => event.type === "retry").length, 1);
    assert.equal(
      events.filter((event) => event.type === "text_delta").map((event) => event.delta).join(""),
      "done",
    );
  });
});

test("cancelling a durable continuation settles the turn", async () => {
  const controller = new AbortController();
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("half")], {
      stopReason: "error",
      errorMessage: "terminated",
    }),
    () => { controller.abort(new Error("user cancelled")); return ai.fauxAssistantMessage("Late response"); },
  ]);

  await withTempDir(async (workdir) => {
    const events: AgentStreamEvent[] = [];
    const runtime = await createAgentRuntime({
      pi,
      workdir,
      retryDelayMs: 0,
    });

    await assert.rejects(
      async () => {
        for await (const event of runtime.run(
          { prompt: "go", errCode: 0, errMessage: "" },
          { abortSignal: controller.signal },
        )) {
          events.push(event);
        }
      },
      (error: unknown) => error instanceof HarnessError && error.type === "execution_aborted",
    );

    assert.equal(events.filter((event) => event.type === "retry").length, 1);
  });
});

test("a failure the provider would repeat is not continued", async () => {
  const { pi, ai } = await createFauxRuntime([
    () => ai.fauxAssistantMessage([ai.fauxText("thinking")], {
      stopReason: "error",
      errorMessage: "invalid api key",
    }),
    () => ai.fauxAssistantMessage([ai.fauxText("should never be asked")]),
  ]);

  await withTempDir(async (workdir) => {
    const events = await collectEvents(
      { pi, workdir, retryDelayMs: 0 },
      { prompt: "go", errCode: 0, errMessage: "" },
    ).catch((error: unknown) => error as Error);

    assert.ok(events instanceof Error);
    assert.match(events.message, /invalid api key/);
  });
});

test("empty failures use the persisted provider retry budget without continuation prompts", async () => {
  let calls = 0;
  const { pi, ai } = await createFauxRuntime([
    ...Array.from({ length: 11 }, () => (request?: { messages: Array<{ role: string }> }) => {
      calls += 1;
      assert.equal(request!.messages.filter(message => message.role === "user").length, 1);
      return ai.fauxAssistantMessage([], { stopReason: "error", errorMessage: "terminated" });
    }),
  ]);

  await withTempDir(async (workdir) => {
    const events = await collectEvents(
      { pi, workdir, retryDelayMs: 0 },
      { prompt: "go", errCode: 0, errMessage: "" },
    ).catch((error: unknown) => error as Error);

    assert.ok(events instanceof Error);
    assert.equal(calls, 11);
    assert.match(events.message, /terminated/);
  });
});
