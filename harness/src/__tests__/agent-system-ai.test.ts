import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveAgentSystemAIInput } from "../agent/node";

const ENV_NAMES = [
  "STEAMHARNESS_AI_SERVER_URL",
  "STEAMHARNESS_AI_API_KEY",
  "STEAMHARNESS_CLI_AUTH_DIR",
] as const;

test("an unconfigured host keeps ordinary self-configured agent credentials", async () => {
  const previousEnv = snapshotEnv();
  const authDir = await mkdtemp(path.join(os.tmpdir(), "workflow-agent-ai-auth-"));
  const previousFetch = globalThis.fetch;
  const input = {
    prompt: "hello",
    provider: "openai",
    model: "gpt-self-hosted",
    apiKey: "developer-key",
    errCode: 0,
    errMessage: "",
  };
  try {
    clearEnv();
    process.env.STEAMHARNESS_CLI_AUTH_DIR = authDir;
    globalThis.fetch = (async () => {
      throw new Error("the unconfigured path must not fetch");
    }) as typeof fetch;

    const resolved = await resolveAgentSystemAIInput(input, {}, undefined);
    assert.strictEqual(resolved.input, input);
    await resolved.close();
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(previousEnv);
    await rm(authDir, { recursive: true, force: true });
  }
});

test("a public Server leaves a caller-supplied agent provider alone", async () => {
  const previousEnv = snapshotEnv();
  const previousFetch = globalThis.fetch;
  try {
    clearEnv();
    process.env.STEAMHARNESS_AI_SERVER_URL = "https://public.example.test";
    process.env.STEAMHARNESS_AI_API_KEY = "project-token";
    globalThis.fetch = (async () => Response.json(
      { errCode: 404, errMessage: "API route not found." },
      { status: 404 },
    )) as typeof fetch;

    const input = {
      prompt: "hello",
      provider: "openai",
      model: "gpt-self-hosted",
      apiKey: "developer-key",
      errCode: 0,
      errMessage: "",
    };
    const resolved = await resolveAgentSystemAIInput(input, {}, undefined);
    assert.strictEqual(resolved.input, input);
    await resolved.close();
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(previousEnv);
  }
});

test("a caller-supplied API key bypasses configured system AI", async () => {
  const previousEnv = snapshotEnv();
  const previousFetch = globalThis.fetch;
  const input = {
    prompt: "hello",
    provider: "openai",
    model: "gpt-self-hosted",
    apiKey: "developer-key",
    errCode: 0,
    errMessage: "",
  };
  try {
    clearEnv();
    process.env.STEAMHARNESS_AI_SERVER_URL = "https://private-ai.example.test";
    process.env.STEAMHARNESS_AI_API_KEY = "ai-session-token";
    globalThis.fetch = (async () => {
      throw new Error("the system AI catalog must not be fetched for a caller-supplied API key");
    }) as typeof fetch;

    const resolved = await resolveAgentSystemAIInput(input, {}, undefined);
    assert.strictEqual(resolved.input, input);
    await resolved.close();
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(previousEnv);
  }
});

test("an agent option API key bypasses configured system AI", async () => {
  const previousEnv = snapshotEnv();
  const previousFetch = globalThis.fetch;
  try {
    clearEnv();
    process.env.STEAMHARNESS_AI_SERVER_URL = "https://private-ai.example.test";
    process.env.STEAMHARNESS_AI_API_KEY = "ai-session-token";
    globalThis.fetch = (async () => {
      throw new Error("the system AI catalog must not be fetched for an option-supplied API key");
    }) as typeof fetch;

    const input = {
      prompt: "hello",
      provider: "openai",
      model: "gpt-self-hosted",
      errCode: 0,
      errMessage: "",
    };
    const resolved = await resolveAgentSystemAIInput(input, {
      apiKey: "developer-key",
    }, undefined);
    assert.strictEqual(resolved.input, input);
    await resolved.close();
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(previousEnv);
  }
});

test("an unavailable configured AI service is surfaced instead of using project credentials", async () => {
  const previousEnv = snapshotEnv();
  const previousFetch = globalThis.fetch;
  try {
    clearEnv();
    process.env.STEAMHARNESS_AI_SERVER_URL = "https://private-ai.example.test";
    process.env.STEAMHARNESS_AI_API_KEY = "project-token";
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;

    await assert.rejects(
      () => resolveAgentSystemAIInput({
        prompt: "hello",
        provider: "openai",
        model: "gpt-self-hosted",
        errCode: 0,
        errMessage: "",
      }, {}, undefined),
      /Could not connect to the private AI service/u,
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(previousEnv);
  }
});

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
}

function clearEnv(): void {
  for (const name of ENV_NAMES) delete process.env[name];
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const name of ENV_NAMES) {
    const value = previous[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
