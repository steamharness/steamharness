import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getServerLLMCredentials } from "../provider/llm/server";

test("server LLM credentials hide proxy tokens and refresh before provider calls", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.STEAMHARNESS_AI_SERVER_URL;
  const previousToken = process.env.STEAMHARNESS_AI_API_KEY;
  process.env.STEAMHARNESS_AI_SERVER_URL = "https://workflow.example.test";
  process.env.STEAMHARNESS_AI_API_KEY = "account-token";
  let catalogReads = 0;
  const proxyAuthorizations: string[] = [];
  const proxyBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/ai/catalog")) {
      catalogReads += 1;
      const expiresAt = catalogReads === 1
        ? new Date(Date.now() + 30_000).toISOString()
        : new Date(Date.now() + 60 * 60 * 1000).toISOString();
      return Response.json({
        errCode: 0,
        errMessage: "",
        data: {
          credentials: [{
            id: "provider:4",
            name: "OpenAI configuration",
            platform: "openai",
            providerType: "openai-responses",
            models: ["gpt-test"],
            modelDetails: [{
              id: "gpt-test",
              name: "GPT Test",
              capabilities: { vision: true, webSearch: true, reasoning: true, toolCalling: true },
            }],
            proxyPath: "/api/ai/proxy/provider%3A4",
            credentialToken: catalogReads === 1 ? "short-proxy-token" : "refreshed-proxy-token",
            expiresAt,
          }],
          warnings: [],
          fetchedAt: new Date().toISOString(),
        },
      });
    }
    proxyAuthorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    proxyBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({
      id: "resp-1",
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: "gpt-test",
      output: [{
        id: "msg-1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  }) as typeof fetch;

  try {
    const credentials = await getServerLLMCredentials();
    assert.equal(credentials.length, 1);
    assert.deepEqual(Object.keys(credentials[0]!).sort(), [
      "createProvider",
      "defaultModelId",
      "id",
      "modelDetails",
      "models",
      "name",
      "platform",
      "providerType",
      "startLLMProxyBridge",
      "startOpenAIProxyBridge",
    ]);
    assert.deepEqual(credentials[0]!.modelDetails, [{
      id: "gpt-test",
      name: "GPT Test",
      capabilities: { vision: true, webSearch: true, reasoning: true, toolCalling: true },
    }]);
    assert.equal(JSON.stringify(credentials).includes("short-proxy-token"), false);

    const provider = credentials[0]!.createProvider({ model: "gpt-test", webSearch: true });
    const [first, second] = await Promise.all([
      provider.chat({ prompt: "hi" }),
      provider.chat({ prompt: "again" }),
    ]);
    assert.equal(first.text, "hello");
    assert.equal(second.text, "hello");
    assert.equal(catalogReads, 2);
    assert.deepEqual(proxyAuthorizations, ["Bearer refreshed-proxy-token", "Bearer refreshed-proxy-token"]);
    assert.equal(proxyBodies.every((body) => (
      Array.isArray(body.tools) && (body.tools as Array<{ type?: string }>)[0]?.type === "web_search"
    )), true);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("STEAMHARNESS_AI_SERVER_URL", previousUrl);
    restoreEnv("STEAMHARNESS_AI_API_KEY", previousToken);
  }
});

test("server LLM credentials preserve the provider preference order returned by Server", async () => {
  const previousFetch = globalThis.fetch;
  const previous = snapshotEnv(["STEAMHARNESS_AI_SERVER_URL", "STEAMHARNESS_AI_API_KEY"]);
  process.env.STEAMHARNESS_AI_SERVER_URL = "https://workflow.example.test";
  process.env.STEAMHARNESS_AI_API_KEY = "account-token";
  globalThis.fetch = (async () => Response.json({
    errCode: 0,
    errMessage: "",
    data: {
      credentials: [
        createCredentialRecord("provider:2", "Preferred configuration"),
        createCredentialRecord("provider:1", "Balance fallback"),
      ],
      warnings: [],
      fetchedAt: new Date().toISOString(),
    },
  })) as typeof fetch;

  try {
    const credentials = await getServerLLMCredentials();
    assert.deepEqual(credentials.map((credential) => credential.id), ["provider:2", "provider:1"]);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvSnapshot(previous);
  }
});

test("server LLM credentials canonicalize the configured default model case-insensitively", async () => {
  const previousFetch = globalThis.fetch;
  const previous = snapshotEnv(["STEAMHARNESS_AI_SERVER_URL", "STEAMHARNESS_AI_API_KEY"]);
  process.env.STEAMHARNESS_AI_SERVER_URL = "https://workflow.example.test";
  process.env.STEAMHARNESS_AI_API_KEY = "account-token";
  const defaults = ["GPT-Test", "gpt-missing", undefined];
  let reads = 0;
  globalThis.fetch = (async () => {
    const record = createCredentialRecord("provider:4", "OpenAI configuration");
    const defaultModelId = defaults[reads] ?? null;
    reads += 1;
    return Response.json({
      errCode: 0,
      errMessage: "",
      data: {
        credentials: [defaultModelId === null ? record : { ...record, defaultModelId }],
        warnings: [],
        fetchedAt: new Date().toISOString(),
      },
    });
  }) as typeof fetch;

  try {
    // A default that only differs by case must survive as the credential's
    // own spelling; otherwise the host silently loses the configured model.
    assert.equal((await getServerLLMCredentials())[0]!.defaultModelId, "gpt-test");
    // A default outside the credential's model list still falls back to null
    // so the host can apply its own priority chain.
    assert.equal((await getServerLLMCredentials())[0]!.defaultModelId, null);
    // An absent default stays null.
    assert.equal((await getServerLLMCredentials())[0]!.defaultModelId, null);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvSnapshot(previous);
  }
});

test("server LLM OpenAI bridge proxies only loopback Responses requests without exposing credentials", async () => {
  const previousFetch = globalThis.fetch;
  const previous = snapshotEnv([
    "STEAMHARNESS_AI_SERVER_URL",
    "STEAMHARNESS_AI_API_KEY",
    "STEAMHARNESS_SERVER_URL",
    "STEAMHARNESS_SERVER_ADMIN_KEY",
  ]);
  process.env.STEAMHARNESS_AI_SERVER_URL = "https://workflow.example.test";
  process.env.STEAMHARNESS_AI_API_KEY = "account-token";
  delete process.env.STEAMHARNESS_SERVER_URL;
  delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
  let upstreamUrl = "";
  let upstreamAuthorization = "";
  let upstreamCookie = "";
  let upstreamBody = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/ai/catalog")) {
      return createCatalogResponse({ credentialToken: "hidden-proxy-token" });
    }
    upstreamUrl = String(input);
    const headers = new Headers(init?.headers);
    upstreamAuthorization = headers.get("authorization") ?? "";
    upstreamCookie = headers.get("cookie") ?? "";
    upstreamBody = Buffer.from(init?.body as ArrayBuffer).toString("utf8");
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: first\n\n"));
        controller.enqueue(encoder.encode("data: second\n\n"));
        controller.close();
      },
    }), {
      headers: {
        "content-type": "text/event-stream",
        "set-cookie": "must-not-leak=1",
      },
    });
  }) as typeof fetch;

  let bridge: Awaited<ReturnType<(Awaited<ReturnType<typeof getServerLLMCredentials>>)[number]["startOpenAIProxyBridge"]>> | undefined;
  try {
    const [credential] = await getServerLLMCredentials();
    bridge = await credential!.startOpenAIProxyBridge();
    const bridgeUrl = new URL(bridge.baseUrl);
    assert.equal(bridgeUrl.hostname, "127.0.0.1");
    assert.equal(bridge.apiKey, "workflow-loopback-proxy");
    assert.equal(JSON.stringify(bridge).includes("hidden-proxy-token"), false);

    const notFound = await previousFetch(`${bridge.baseUrl}/chat/completions`, { method: "POST" });
    assert.equal(notFound.status, 404);

    const tooLarge = await requestWithDeclaredLength(
      `${bridge.baseUrl}/responses`,
      50 * 1024 * 1024 + 1,
    );
    assert.equal(tooLarge, 413);
    assert.equal(upstreamUrl, "");

    const response = await previousFetch(`${bridge.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.apiKey}`,
        cookie: "local-secret=1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-test", input: "hello" }),
    });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(await response.text(), "data: first\n\ndata: second\n\n");
    assert.equal(upstreamUrl, "https://workflow.example.test/api/ai/proxy/provider%3A4/responses");
    assert.equal(upstreamAuthorization, "Bearer hidden-proxy-token");
    assert.equal(upstreamCookie, "");
    assert.deepEqual(JSON.parse(upstreamBody), { model: "gpt-test", input: "hello" });

    await bridge.close();
    await assert.rejects(() => previousFetch(`${bridge!.baseUrl}/responses`, { method: "POST" }));
  } finally {
    await bridge?.close();
    globalThis.fetch = previousFetch;
    restoreEnvSnapshot(previous);
  }
});

test("server LLM credentials keep undeclared model web search disabled", async () => {
  const previousFetch = globalThis.fetch;
  const previous = snapshotEnv(["STEAMHARNESS_AI_SERVER_URL", "STEAMHARNESS_AI_API_KEY"]);
  process.env.STEAMHARNESS_AI_SERVER_URL = "https://workflow.example.test";
  process.env.STEAMHARNESS_AI_API_KEY = "account-token";
  globalThis.fetch = (async () => createCatalogResponse()) as typeof fetch;
  try {
    const [credential] = await getServerLLMCredentials();
    assert.equal(credential!.modelDetails[0]?.capabilities.webSearch, false);
    assert.throws(
      () => credential!.createProvider({ model: "gpt-test", webSearch: true }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /does not support web search/);
        assert.deepEqual(
          (error as Error & { metadata?: Record<string, unknown> }).metadata?.steamHarnessI18n,
          {
            namespace: "common",
            key: "serverAiModelWebSearchUnsupported",
            values: { model: "gpt-test" },
          },
        );
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvSnapshot(previous);
  }
});

test("server LLM OpenAI bridge rejects Anthropic credentials", async () => {
  const previousFetch = globalThis.fetch;
  const previous = snapshotEnv(["STEAMHARNESS_AI_SERVER_URL", "STEAMHARNESS_AI_API_KEY"]);
  process.env.STEAMHARNESS_AI_SERVER_URL = "https://workflow.example.test";
  process.env.STEAMHARNESS_AI_API_KEY = "account-token";
  globalThis.fetch = (async () => Response.json({
    errCode: 0,
    errMessage: "",
    data: {
      credentials: [{
        id: "provider:anthropic",
        name: "Anthropic configuration",
        platform: "anthropic",
        providerType: "anthropic",
        models: ["claude-test"],
        proxyPath: "/api/ai/proxy/provider%3Aanthropic",
        credentialToken: "hidden-token",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }],
      warnings: [],
      fetchedAt: new Date().toISOString(),
    },
  })) as typeof fetch;
  try {
    const [credential] = await getServerLLMCredentials();
    await assert.rejects(
      () => credential!.startOpenAIProxyBridge(),
      (error: unknown) => {
        assert.match((error as Error).message, /does not support the OpenAI Responses proxy bridge/);
        assert.deepEqual((error as { metadata?: Record<string, unknown> }).metadata?.steamHarnessI18n, {
          namespace: "common",
          key: "serverAiResponsesProxyUnsupported",
          values: { configuration: "Anthropic configuration" },
        });
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvSnapshot(previous);
  }
});

test("server LLM generic bridge proxies Anthropic Messages with server credentials", async () => {
  const previousFetch = globalThis.fetch;
  const previous = snapshotEnv(["STEAMHARNESS_AI_SERVER_URL", "STEAMHARNESS_AI_API_KEY"]);
  process.env.STEAMHARNESS_AI_SERVER_URL = "https://workflow.example.test";
  process.env.STEAMHARNESS_AI_API_KEY = "account-token";
  let upstreamUrl = "";
  let upstreamApiKey = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/ai/catalog")) {
      return Response.json({
        errCode: 0,
        errMessage: "",
        data: {
          credentials: [{
            id: "provider:anthropic",
            name: "Anthropic configuration",
            platform: "anthropic",
            providerType: "anthropic",
            models: ["claude-test"],
            proxyPath: "/api/ai/proxy/provider%3Aanthropic",
            credentialToken: "hidden-anthropic-token",
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }],
          warnings: [],
          fetchedAt: new Date().toISOString(),
        },
      });
    }
    upstreamUrl = String(input);
    upstreamApiKey = new Headers(init?.headers).get("x-api-key") ?? "";
    return Response.json({ content: [{ type: "text", text: "hello" }] });
  }) as typeof fetch;

  let bridge: Awaited<ReturnType<(Awaited<ReturnType<typeof getServerLLMCredentials>>)[number]["startLLMProxyBridge"]>> | undefined;
  try {
    const [credential] = await getServerLLMCredentials();
    bridge = await credential!.startLLMProxyBridge();
    assert.equal(new URL(bridge.baseUrl).hostname, "127.0.0.1");
    assert.equal(JSON.stringify(bridge).includes("hidden-anthropic-token"), false);

    const response = await previousFetch(`${bridge.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": bridge.apiKey,
      },
      body: JSON.stringify({ model: "claude-test", messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamUrl, "https://workflow.example.test/api/ai/proxy/provider%3Aanthropic/messages");
    assert.equal(upstreamApiKey, "hidden-anthropic-token");
  } finally {
    await bridge?.close();
    globalThis.fetch = previousFetch;
    restoreEnvSnapshot(previous);
  }
});

test("server LLM OpenAI bridge cancels active upstream requests when closed", async () => {
  const previousFetch = globalThis.fetch;
  const previous = snapshotEnv(["STEAMHARNESS_AI_SERVER_URL", "STEAMHARNESS_AI_API_KEY"]);
  process.env.STEAMHARNESS_AI_SERVER_URL = "https://workflow.example.test";
  process.env.STEAMHARNESS_AI_API_KEY = "account-token";
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let upstreamSignal: AbortSignal | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/ai/catalog")) {
      return createCatalogResponse();
    }
    upstreamSignal = init?.signal ?? undefined;
    markStarted?.();
    return new Promise<Response>((_resolve, reject) => {
      upstreamSignal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }) as typeof fetch;

  let bridge: Awaited<ReturnType<(Awaited<ReturnType<typeof getServerLLMCredentials>>)[number]["startOpenAIProxyBridge"]>> | undefined;
  try {
    const [credential] = await getServerLLMCredentials();
    bridge = await credential!.startOpenAIProxyBridge();
    const clientRequest = previousFetch(`${bridge.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch((error) => error);
    await started;
    await bridge.close();
    assert.equal(upstreamSignal?.aborted, true);
    assert.ok(await clientRequest instanceof Error);
  } finally {
    await bridge?.close();
    globalThis.fetch = previousFetch;
    restoreEnvSnapshot(previous);
  }
});

test("server LLM provider keeps a still-valid token when refresh fails", async () => {
  const previousFetch = globalThis.fetch;
  const previous = snapshotEnv([
    "STEAMHARNESS_AI_SERVER_URL",
    "STEAMHARNESS_AI_API_KEY",
    "STEAMHARNESS_SERVER_URL",
    "STEAMHARNESS_SERVER_ADMIN_KEY",
  ]);
  process.env.STEAMHARNESS_AI_SERVER_URL = "https://workflow.example.test";
  process.env.STEAMHARNESS_AI_API_KEY = "account-token";
  delete process.env.STEAMHARNESS_SERVER_URL;
  delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
  let catalogReads = 0;
  let proxyAuthorization = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/ai/catalog")) {
      catalogReads += 1;
      if (catalogReads > 1) throw new Error("temporary catalog outage");
      return createCatalogResponse({
        credentialToken: "still-valid-token",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
    }
    proxyAuthorization = new Headers(init?.headers).get("authorization") ?? "";
    return createOpenAIResponse();
  }) as typeof fetch;

  try {
    const [credential] = await getServerLLMCredentials();
    const result = await credential!.createProvider({ model: "gpt-test" }).chat({ prompt: "hi" });
    assert.equal(result.text, "hello");
    assert.equal(catalogReads, 2);
    assert.equal(proxyAuthorization, "Bearer still-valid-token");
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvSnapshot(previous);
  }
});

test("server LLM connection sources keep URL and token pairs together in priority order", async (context) => {
  const authDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-llm-auth-"));
  await writeFile(path.join(authDir, "workflow-auth.json"), JSON.stringify({
    serverUrl: "https://saved.example.test",
    apiKey: "saved-token",
    aiServerUrl: "https://saved-ai.example.test",
    aiApiKey: "saved-ai-token",
  }), "utf8");
  const names = [
    "STEAMHARNESS_AI_SERVER_URL",
    "STEAMHARNESS_AI_API_KEY",
    "STEAMHARNESS_SERVER_URL",
    "STEAMHARNESS_SERVER_ADMIN_KEY",
    "STEAMHARNESS_CLI_AUTH_DIR",
  ];
  const previousEnv = snapshotEnv(names);
  const previousFetch = globalThis.fetch;
  try {
    const cases = [
      {
        name: "explicit AI connection takes precedence over project connection",
        env: {
          STEAMHARNESS_AI_SERVER_URL: "https://specific.example.test",
          STEAMHARNESS_AI_API_KEY: "specific-token",
          STEAMHARNESS_SERVER_URL: "https://general.example.test",
          STEAMHARNESS_SERVER_ADMIN_KEY: "general-token",
        },
        expectedUrl: "https://specific.example.test/api/ai/catalog",
        expectedToken: "specific-token",
      },
      {
        name: "saved CLI login",
        env: {},
        expectedUrl: "https://saved-ai.example.test/api/ai/catalog",
        expectedToken: "saved-ai-token",
      },
    ] as const;

    for (const item of cases) {
      await context.test(item.name, async () => {
        names.forEach((name) => delete process.env[name]);
        process.env.STEAMHARNESS_CLI_AUTH_DIR = authDir;
        Object.assign(process.env, item.env);
        let requestUrl = "";
        let requestToken = "";
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          requestUrl = String(input);
          requestToken = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer\s+/, "");
          return createCatalogResponse();
        }) as typeof fetch;

        const credentials = await getServerLLMCredentials();
        assert.equal(credentials.length, 1);
        assert.equal(requestUrl, item.expectedUrl);
        assert.equal(requestToken, item.expectedToken);
      });
    }
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvSnapshot(previousEnv);
    await rm(authDir, { recursive: true, force: true });
  }
});

test("server LLM connection variables must be configured as a pair", async () => {
  const previousUrl = process.env.STEAMHARNESS_AI_SERVER_URL;
  const previousToken = process.env.STEAMHARNESS_AI_API_KEY;
  process.env.STEAMHARNESS_AI_SERVER_URL = "https://workflow.example.test";
  delete process.env.STEAMHARNESS_AI_API_KEY;
  try {
    await assert.rejects(() => getServerLLMCredentials(), (error: unknown) => {
      assert.match((error as Error).message, /must be configured together/);
      assert.deepEqual((error as { metadata?: Record<string, unknown> }).metadata?.steamHarnessI18n, {
        namespace: "common",
        key: "workflowServerConnectionPairRequired",
        values: { names: "STEAMHARNESS_AI_SERVER_URL/STEAMHARNESS_AI_API_KEY" },
      });
      return true;
    });
  } finally {
    restoreEnv("STEAMHARNESS_AI_SERVER_URL", previousUrl);
    restoreEnv("STEAMHARNESS_AI_API_KEY", previousToken);
  }
});

test("legacy LLM connection variables never become a system AI connection", async () => {
  const names = [
    "STEAMHARNESS_AI_SERVER_URL",
    "STEAMHARNESS_AI_API_KEY",
    "STEAMHARNESS_LLM_SERVER_URL",
    "STEAMHARNESS_LLM_SERVER_TOKEN",
    "STEAMHARNESS_SERVER_URL",
    "STEAMHARNESS_SERVER_ADMIN_KEY",
    "STEAMHARNESS_CLI_AUTH_DIR",
  ];
  const previous = snapshotEnv(names);
  names.forEach((name) => delete process.env[name]);
  process.env.STEAMHARNESS_LLM_SERVER_URL = "https://legacy.example.test";
  process.env.STEAMHARNESS_LLM_SERVER_TOKEN = "legacy-token";
  try {
    await assert.rejects(() => getServerLLMCredentials(), (error: unknown) => {
      assert.equal((error as Error).message, "System AI is unavailable. Configure the private AI service URL and API key.");
      assert.deepEqual((error as { metadata?: Record<string, unknown> }).metadata?.steamHarnessI18n, {
        namespace: "common",
        key: "systemAiUnavailable",
      });
      return true;
    });
  } finally {
    restoreEnvSnapshot(previous);
  }
});

test("server LLM missing login keeps a localizable error descriptor", async () => {
  const names = [
    "STEAMHARNESS_AI_SERVER_URL",
    "STEAMHARNESS_AI_API_KEY",
    "STEAMHARNESS_SERVER_URL",
    "STEAMHARNESS_SERVER_ADMIN_KEY",
    "STEAMHARNESS_CLI_AUTH_DIR",
  ];
  const previous = snapshotEnv(names);
  const authDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-server-auth-empty-"));
  names.forEach((name) => delete process.env[name]);
  process.env.STEAMHARNESS_CLI_AUTH_DIR = authDir;
  try {
    await assert.rejects(() => getServerLLMCredentials(), (error: unknown) => {
      assert.equal(
        (error as Error).message,
        "System AI is unavailable. Configure the private AI service URL and API key.",
      );
      assert.deepEqual((error as { metadata?: Record<string, unknown> }).metadata?.steamHarnessI18n, {
        namespace: "common",
        key: "systemAiUnavailable",
      });
      return true;
    });
  } finally {
    restoreEnvSnapshot(previous);
    await rm(authDir, { recursive: true, force: true });
  }
});

test("public Server 404s are reported as unavailable system AI", async () => {
  const names = ["STEAMHARNESS_AI_SERVER_URL", "STEAMHARNESS_AI_API_KEY", "STEAMHARNESS_AI_SERVER_URL", "STEAMHARNESS_AI_API_KEY", "STEAMHARNESS_SERVER_URL", "STEAMHARNESS_SERVER_ADMIN_KEY", "STEAMHARNESS_CLI_AUTH_DIR"];
  const previous = snapshotEnv(names);
  const previousFetch = globalThis.fetch;
  names.forEach((name) => delete process.env[name]);
  process.env.STEAMHARNESS_AI_SERVER_URL = "https://public.example.test";
  process.env.STEAMHARNESS_AI_API_KEY = "ai-token";
  globalThis.fetch = (async () => Response.json({ errCode: 404, errMessage: "API route not found." }, { status: 404 })) as typeof fetch;
  try {
    await assert.rejects(() => getServerLLMCredentials(), (error: unknown) => {
      assert.equal((error as Error).message, "System AI is unavailable on this public Server. Configure the private AI service URL and API key.");
      assert.deepEqual((error as { metadata?: Record<string, unknown> }).metadata?.steamHarnessI18n, {
        namespace: "common",
        key: "systemAiUnavailable",
      });
      assert.equal((error as { metadata?: Record<string, unknown> }).metadata?.systemAiConfigured, false);
      return true;
    });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvSnapshot(previous);
  }
});

test("model attributes ride along, and a broken one is dropped rather than fatal", async () => {
  const names = ["STEAMHARNESS_AI_SERVER_URL", "STEAMHARNESS_AI_API_KEY", "STEAMHARNESS_SERVER_URL", "STEAMHARNESS_SERVER_ADMIN_KEY", "STEAMHARNESS_CLI_AUTH_DIR"];
  const previousEnv = snapshotEnv(names);
  const previousFetch = globalThis.fetch;
  names.forEach((name) => delete process.env[name]);
  process.env.STEAMHARNESS_AI_SERVER_URL = "https://workflow.example.test";
  process.env.STEAMHARNESS_AI_API_KEY = "account-token";

  const modelDetails = [
    {
      id: "MiniMax-M3",
      name: "MiniMax M3",
      capabilities: { vision: true, webSearch: false, reasoning: true, toolCalling: true },
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_048_576,
      maxTokens: 512_000,
      cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
      thinkingLevelMap: { off: "none", high: "high", max: "max" },
    },
    {
      id: "broken-model",
      name: "Broken",
      capabilities: { vision: false, webSearch: false, reasoning: false, toolCalling: false },
      // One field the Server got wrong must not fail every run that names the
      // model, so each unusable value is dropped instead of thrown on.
      reasoning: "yes",
      input: ["text", "audio"],
      contextWindow: -1,
      maxTokens: 1.5,
      cost: { input: "free" },
      thinkingLevelMap: { ultra: "max" },
    },
  ];

  globalThis.fetch = (async () => Response.json({
    errCode: 0,
    errMessage: "",
    data: {
      credentials: [{
        ...createCredentialRecord("provider:7", "MiniMax"),
        models: ["MiniMax-M3", "broken-model"],
        modelDetails,
      }],
      warnings: [],
      fetchedAt: new Date().toISOString(),
    },
  })) as typeof fetch;

  try {
    const credentials = await getServerLLMCredentials();
    assert.deepEqual(credentials[0]!.modelDetails, [
      {
        id: "MiniMax-M3",
        name: "MiniMax M3",
        capabilities: { vision: true, webSearch: false, reasoning: true, toolCalling: true },
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_048_576,
        maxTokens: 512_000,
        cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
        thinkingLevelMap: { off: "none", high: "high", max: "max" },
      },
      {
        // Only the modality this build understands survived: a modality it has
        // never heard of narrows the model rather than widening it, and the
        // `audio` entry must not push the model back to the permissive default.
        id: "broken-model",
        name: "Broken",
        capabilities: { vision: false, webSearch: false, reasoning: false, toolCalling: false },
        input: ["text"],
      },
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvSnapshot(previousEnv);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function createCatalogResponse(options: {
  credentialToken?: string;
  expiresAt?: string;
} = {}): Response {
  return Response.json({
    errCode: 0,
    errMessage: "",
    data: {
      credentials: [createCredentialRecord("provider:4", "OpenAI configuration", options)],
      warnings: [],
      fetchedAt: new Date().toISOString(),
    },
  });
}

function createCredentialRecord(
  id: string,
  name: string,
  options: { credentialToken?: string; expiresAt?: string } = {},
) {
  return {
    id,
    name,
    platform: "openai",
    providerType: "openai-responses",
    models: ["gpt-test"],
    modelDetails: [{
      id: "gpt-test",
      name: "gpt-test",
      capabilities: { vision: false, webSearch: false, reasoning: false, toolCalling: false },
    }],
    proxyPath: `/api/ai/proxy/${encodeURIComponent(id)}`,
    credentialToken: options.credentialToken ?? "proxy-token",
    expiresAt: options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}

function createOpenAIResponse(): Response {
  return Response.json({
    id: "resp-1",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: "gpt-test",
    output: [{
      id: "msg-1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "hello", annotations: [] }],
    }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });
}

function snapshotEnv(names: string[]): Map<string, string | undefined> {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnvSnapshot(snapshot: Map<string, string | undefined>): void {
  snapshot.forEach((value, name) => restoreEnv(name, value));
}

function requestWithDeclaredLength(url: string, contentLength: number): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: { "content-length": String(contentLength) },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}
