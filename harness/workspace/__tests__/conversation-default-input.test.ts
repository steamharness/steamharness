import { beforeAll, describe, expect, it } from "vitest";
import { installProjectRuntimeGlobal } from "steamharness/runtime-api";

installProjectRuntimeGlobal();

type ExecutorLike<Input> = {
  params?: Array<{
    name: string;
    defaultValue?: string;
  }>;
  conversation?: {
    attachments?: {
      images?: boolean;
      videos?: boolean;
      files?: boolean;
    };
    inputQueue?: {
      enabled?: boolean;
    };
  };
  createInput(input: {
    args: string[];
    paramValues?: Record<string, string | string[]>;
  }): Input | Promise<Input>;
};

let piAgentExecutor: ExecutorLike<Record<string, unknown>>;
let claudeAgentExecutor: ExecutorLike<Record<string, unknown>>;
let openAIAgentsExecutor: ExecutorLike<Record<string, unknown>>;
let conversationKnowledgeExecutor: ExecutorLike<Record<string, unknown>>;
let deltaforeAgentExecutor: ExecutorLike<Record<string, unknown>>;
let deltaforceOpenAIAgentExecutor: ExecutorLike<Record<string, unknown>>;
let gptImageExecutor: ExecutorLike<Record<string, unknown>>;
let smokeExecutor: ExecutorLike<Record<string, unknown>>;
let gitlabWebhookExecutor: ExecutorLike<Record<string, unknown>>;

beforeAll(async () => {
  piAgentExecutor = (await import("../workflow/pi-agent/index")).executor;
  claudeAgentExecutor = (await import("../workflow/claude-agent/index")).executor;
  openAIAgentsExecutor = (await import("../workflow/openai-agents/index")).executor;
  conversationKnowledgeExecutor = (await import("../workflow/conversation-knowledge/index")).executor;
  deltaforeAgentExecutor = (await import("../workflow/deltafore-agent/index")).executor;
  deltaforceOpenAIAgentExecutor = (await import("../workflow/deltaforce-openai-agent/index")).executor;
  gptImageExecutor = (await import("../workflow/gpt-image/index")).executor;
  smokeExecutor = (await import("../workflow/smoke/index")).executor;
  gitlabWebhookExecutor = (await import("../workflow/gitlab-webhook/index")).executor;
});

describe("conversation default input executors", () => {
  it("maps default --message into pi-agent prompt while preserving auxiliary params", async () => {
    const input = await piAgentExecutor.createInput({
      args: ["--message", "Summarize repo", "--workdir", ".", "--provider", "anthropic", "--dry-run"],
    });

    expect(input).toMatchObject({
      prompt: "Summarize repo",
      workdir: ".",
      provider: "anthropic",
      dryRun: true,
    });
  });

  it("maps default --message into claude-agent prompt", async () => {
    const input = await claudeAgentExecutor.createInput({
      args: ["--message", "Review README", "--workdir", ".", "--permission-mode", "dontAsk"],
    });

    expect(input).toMatchObject({
      prompt: "Review README",
      workdir: ".",
      permissionMode: "dontAsk",
    });
  });

  it("maps default --message into openai-agents message", async () => {
    const input = await openAIAgentsExecutor.createInput({
      args: ["--message", "Remember the project tone", "--workdir", ".", "--local-shell"],
    });

    expect(input).toMatchObject({
      message: "Remember the project tone",
      workdir: ".",
      localShell: true,
    });
  });

  it("maps default --message into conversation-knowledge message", async () => {
    const input = await conversationKnowledgeExecutor.createInput({
      args: ["--message", "记录今天结论", "--title", "Daily Notes", "--dry-run"],
    });

    expect(input).toMatchObject({
      message: "记录今天结论",
      title: "Daily Notes",
      dryRun: true,
    });
  });

  it("maps default --message into deltafore query", async () => {
    const input = await deltaforeAgentExecutor.createInput({
      args: ["--message", "我需要配置 M7", "--max-rounds", "2"],
    });

    expect(input).toMatchObject({
      query: "我需要配置 M7",
      maxRounds: 2,
    });
  });

  it("maps default --message into deltaforce-openai-agent query", async () => {
    const input = await deltaforceOpenAIAgentExecutor.createInput({
      args: ["--message", "我需要配置 M7", "--max-rounds", "2"],
    });

    expect(input).toMatchObject({
      query: "我需要配置 M7",
      maxRounds: 2,
    });
  });

  it("maps default --message and --images into gpt-image input", async () => {
    const imageRef = JSON.stringify([{
      id: "gpt-image-fixture",
      name: "pixel.png",
      mimeType: "image/png",
      size: 68,
      kind: "image",
      storage: "path",
      path: "/tmp/pixel.png",
      createdAt: "2026-06-18T00:00:00.000Z",
    }]);

    const input = await gptImageExecutor.createInput({
      args: ["--message", "Make it warmer", "--images", imageRef, "--quality", "high"],
    });

    expect(input).toMatchObject({
      prompt: "Make it warmer",
      quality: "high",
    });
    expect(Array.isArray((input as { images?: unknown[] }).images)).toBe(true);
    expect((input as { images: Array<{ id: string }> }).images[0]?.id).toBe("gpt-image-fixture");
  });

  it("maps default --message into smoke input", async () => {
    const input = await smokeExecutor.createInput({
      args: ["--message", "workspace-four", "--mode", "wait", "--wait-ms", "10"],
    });

    expect(input).toMatchObject({
      message: "workspace-four",
      mode: "wait",
      waitMs: 10,
    });
  });

  it("keeps gitlab-webhook payload-specific args while reading default --message", async () => {
    const input = await gitlabWebhookExecutor.createInput({
      args: ["--payload", "{\"object_kind\":\"issue\"}", "--message", "fixture note"],
    });

    expect(input).toMatchObject({
      payload: "{\"object_kind\":\"issue\"}",
      message: "fixture note",
    });
  });

  it("still accepts legacy prompt/query fallbacks for CLI compatibility", async () => {
    expect(await piAgentExecutor.createInput({
      args: ["--prompt", "legacy pi"],
    })).toMatchObject({ prompt: "legacy pi" });

    expect(await claudeAgentExecutor.createInput({
      args: ["--prompt", "legacy claude"],
    })).toMatchObject({ prompt: "legacy claude" });

    expect(await gptImageExecutor.createInput({
      args: ["--prompt", "legacy image"],
    })).toMatchObject({ prompt: "legacy image" });

    expect(await deltaforeAgentExecutor.createInput({
      args: ["--query", "legacy deltafore"],
    })).toMatchObject({ query: "legacy deltafore" });

    expect(await deltaforceOpenAIAgentExecutor.createInput({
      args: ["--query", "legacy deltaforce"],
    })).toMatchObject({ query: "legacy deltaforce" });
  });
});
