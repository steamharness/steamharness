import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentStreamResumePrompt,
  createAgentStreamRetryText,
} from "../agent/plan";
import { WORKFLOW_RUNTIME_LOCALE_ENV } from "../runtime-locale";

function withRuntimeLocale(value: string | undefined, run: () => void): void {
  const previous = process.env[WORKFLOW_RUNTIME_LOCALE_ENV];

  try {
    if (value === undefined) {
      delete process.env[WORKFLOW_RUNTIME_LOCALE_ENV];
    } else {
      process.env[WORKFLOW_RUNTIME_LOCALE_ENV] = value;
    }
    run();
  } finally {
    if (previous === undefined) {
      delete process.env[WORKFLOW_RUNTIME_LOCALE_ENV];
    } else {
      process.env[WORKFLOW_RUNTIME_LOCALE_ENV] = previous;
    }
  }
}

test("a dropped stream is still resumed with the connection wording", () => {
  const prompt = createAgentStreamResumePrompt({
    kind: "dropped",
    reason: "terminated",
    keptPartial: true,
  });

  assert.match(prompt, /cut off by a connection error \(terminated\)/);
  assert.match(prompt, /Continue from exactly where you stopped\./);
});

test("an output-limit cut is resumed with wording that fits the cause", () => {
  const kept = createAgentStreamResumePrompt({
    kind: "length",
    reason: "max output tokens",
    keptPartial: true,
  });

  // The two causes read differently on purpose: nothing was disconnected, and a
  // continuation told it was would not know why the same thing keeps happening.
  assert.doesNotMatch(kept, /connection error/);
  assert.match(kept, /output token limit/);
  assert.match(kept, /Everything you had already written is still in this conversation\./);
  // The instruction that makes the continuation land: whatever it was
  // composing did not fit, so it has to be sent on its own.
  assert.match(kept, /the tool call on its own/);
  assert.match(kept, /keep the output short/);

  const dropped = createAgentStreamResumePrompt({
    kind: "length",
    reason: "max output tokens",
    keptPartial: false,
  });
  assert.match(dropped, /ended in a tool call that never ran/);
  assert.match(dropped, /the tool call on its own/);
});

test("a lost tool call is resumed by asking for that call again", () => {
  const prompt = createAgentStreamResumePrompt({
    kind: "lost-call",
    reason: "tool call missing",
    keptPartial: true,
  });

  // Not the connection wording: nothing was disconnected, and a model told it
  // was would carry on as though the call had already been made.
  assert.doesNotMatch(prompt, /connection error/);
  assert.match(prompt, /no tool call arrived and nothing ran/);
  assert.match(prompt, /Make that tool call again, on its own\./);

  const nothingKept = createAgentStreamResumePrompt({
    kind: "lost-call",
    reason: "tool call missing",
    keptPartial: false,
  });
  assert.match(nothingKept, /Nothing of that response could be kept\./);
});

test("the retry row says which budget it is spending", () => {
  withRuntimeLocale("zh-CN", () => {
    const length = createAgentStreamRetryText({ attempt: 1, maxAttempts: 2, kind: "length" });
    assert.match(length.title, /输出超出上限/);
    assert.match(length.title, /（1\/2）/);
    assert.match(length.content, /输出上限/);

    const dropped = createAgentStreamRetryText({ attempt: 1, maxAttempts: 10, kind: "dropped" });
    assert.match(dropped.title, /连接中断/);
    assert.match(dropped.title, /（1\/10）/);
    assert.doesNotMatch(length.content, /[A-Za-z]{4,}/, "zh-CN must not leak the English sentence");

    const lost = createAgentStreamRetryText({ attempt: 1, maxAttempts: 10, kind: "lost-call" });
    assert.match(lost.title, /工具调用丢失/);
    assert.match(lost.title, /（1\/10）/);
  });

  withRuntimeLocale("en", () => {
    const length = createAgentStreamRetryText({ attempt: 2, maxAttempts: 2, kind: "length" });
    assert.match(length.title, /Output limit reached/);
    assert.match(length.title, /\(2\/2\)/);
    assert.match(length.content, /output token limit/);

    const dropped = createAgentStreamRetryText({ attempt: 3, maxAttempts: 10, kind: "dropped" });
    assert.match(dropped.title, /Model stream dropped/);
    assert.match(dropped.title, /\(3\/10\)/);

    const lost = createAgentStreamRetryText({ attempt: 2, maxAttempts: 10, kind: "lost-call" });
    assert.match(lost.title, /Tool call lost/);
    assert.match(lost.content, /nothing ran/);
  });
});

test("a caller that does not name a kind keeps the dropped wording", () => {
  // The builder is exported; a caller written before the two causes were told
  // apart must not change what its users read.
  withRuntimeLocale("en", () => {
    const legacy = createAgentStreamRetryText({ attempt: 1, maxAttempts: 10 });
    assert.deepEqual(
      legacy,
      createAgentStreamRetryText({ attempt: 1, maxAttempts: 10, kind: "dropped" }),
    );
  });
});
