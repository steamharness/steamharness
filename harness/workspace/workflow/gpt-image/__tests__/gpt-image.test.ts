import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runLocalProjectWithReport } from "steamharness";

const fixtureB64 = "Z3B0LWltYWdlLWZpeHR1cmU=";

describe("gpt-image workflow", () => {
  it("uses generate mode when no input images are provided", async () => {
    const report = await runWithMockConfiguration({
      args: [
        "--prompt",
        "Generate a small badge",
        "--output-format",
        "jpeg",
        "--output-compression",
        "80",
      ],
      mimeType: "image/jpeg",
    });

    expect(report.result.ok).toBe(true);
    if (!report.result.ok) return;

    const output = readOutput(report.result.data);
    expect(output.mode).toBe("generate");
    expect(output.imageCount).toBe(0);
    expect(output.mimeType).toBe("image/jpeg");
    expect(output.dataUrl).toBe(`data:image/jpeg;base64,${fixtureB64}`);
  });

  it("uses prior conversation turns as context for follow-up image prompts", async () => {
    const kvStoreDir = await mkdtemp(`${os.tmpdir()}/steamharness-gpt-image-conversation-test-`);
    const conversationId = "gpt-image-follow-up-thread";

    try {
      const firstReport = await runWithMockConfiguration({
        args: [
          "--prompt",
          "Design a square logo with teal line art",
        ],
        conversationId,
        kvStoreDir,
      });
      expect(firstReport.result.ok).toBe(true);
      if (!firstReport.result.ok) return;
      const firstOutput = readOutput(firstReport.result.data);
      expect(firstOutput.contextMessageCount).toBe(0);
      expect(firstOutput.historyLength).toBe(2);
      expect(firstOutput.modelPrompt).toBe("Design a square logo with teal line art");

      const secondReport = await runWithMockConfiguration({
        args: [
          "--prompt",
          "Make it warmer and add a small badge",
        ],
        conversationId,
        kvStoreDir,
      });
      expect(secondReport.result.ok).toBe(true);
      if (!secondReport.result.ok) return;

      const secondOutput = readOutput(secondReport.result.data);
      expect(secondOutput.contextMessageCount).toBe(2);
      expect(secondOutput.historyLength).toBe(4);
      expect(secondOutput.modelPrompt).toContain("Previous conversation:");
      expect(secondOutput.modelPrompt).toContain("Design a square logo with teal line art");
      expect(secondOutput.modelPrompt).toContain("Latest image request:");
      expect(secondOutput.modelPrompt).toContain("Make it warmer and add a small badge");
      expect(secondOutput.revisedPrompt).toBe(secondOutput.modelPrompt);
    } finally {
      await rm(kvStoreDir, { recursive: true, force: true });
    }
  });

  it("reuses prior conversation images as context for follow-up image edits", async () => {
    const kvStoreDir = await mkdtemp(`${os.tmpdir()}/steamharness-gpt-image-context-image-test-`);
    const conversationId = "gpt-image-context-image-thread";
    const traceFile = path.join(kvStoreDir, "mock-image-runner.ndjson");
    const imageReference = createFixtureImageReference();

    try {
      const firstReport = await runWithMockConfiguration({
        args: [
          "--prompt",
          "Use this reference image as a clean square app icon",
          "--images",
          JSON.stringify([imageReference]),
        ],
        conversationId,
        kvStoreDir,
        traceFile,
      });
      expect(firstReport.result.ok).toBe(true);
      if (!firstReport.result.ok) return;
      const firstOutput = readOutput(firstReport.result.data);
      expect(firstOutput.mode).toBe("edit");
      expect(firstOutput.imageCount).toBe(1);
      expect(firstOutput.inputImageCount).toBe(1);
      expect(firstOutput.contextImageCount).toBe(0);

      const secondReport = await runWithMockConfiguration({
        args: [
          "--prompt",
          "Keep the same icon shape but make it warmer",
        ],
        conversationId,
        kvStoreDir,
        traceFile,
      });
      expect(secondReport.result.ok).toBe(true);
      if (!secondReport.result.ok) return;

      const secondOutput = readOutput(secondReport.result.data);
      expect(secondOutput.mode).toBe("edit");
      expect(secondOutput.imageCount).toBe(1);
      expect(secondOutput.inputImageCount).toBe(0);
      expect(secondOutput.contextImageCount).toBe(1);
      expect(secondOutput.contextMessageCount).toBe(2);

      const traces = await readMockRunnerTraces(traceFile);
      expect(traces).toHaveLength(2);
      expect(traces[0]).toMatchObject({
        mode: "edit",
        imageIds: ["gpt-image-context-pixel"],
      });
      expect(traces[1]).toMatchObject({
        mode: "edit",
        imageIds: ["gpt-image-context-pixel"],
      });
    } finally {
      await rm(kvStoreDir, { recursive: true, force: true });
    }
  });

  it("rejects transparent background for gpt-image-2 before provider calls", async () => {
    const report = await runWithMockConfiguration({
      args: [
        "--prompt",
        "Generate a transparent badge",
        "--background",
        "transparent",
      ],
    });

    expect(report.status).toBe("failed");
    expect(report.result.ok).toBe(true);
    if (!report.result.ok) return;
    const data = report.result.data as {
      errCode: number;
      errMessage: string;
      output: unknown;
    };
    expect(data.errCode).toBe(400);
    expect(data.errMessage).toContain("does not support transparent background");
    expect(data.output).toBeNull();
    expect(report.outputs).toHaveLength(0);
  });
});

async function runWithMockConfiguration(options: {
  args: string[];
  mimeType?: string;
  conversationId?: string;
  kvStoreDir?: string;
  traceFile?: string;
}) {
  const ownsKvStoreDir = options.kvStoreDir === undefined;
  const kvStoreDir = options.kvStoreDir ?? await mkdtemp(`${os.tmpdir()}/steamharness-gpt-image-test-`);
  try {
    return await runLocalProjectWithReport({
      projectDir: path.resolve(process.cwd(), "workflow/gpt-image"),
      projectName: "gpt-image",
      args: options.args,
      conversationId: options.conversationId,
      configuration: { id: "fixture", name: "Fixture", revision: 0, values: {
        GPT_IMAGE_MOCK: "1",
        GPT_IMAGE_MOCK_B64: fixtureB64,
        ...(options.mimeType === undefined ? {} : { GPT_IMAGE_MOCK_MIME_TYPE: options.mimeType }),
        ...(options.traceFile === undefined ? {} : { GPT_IMAGE_MOCK_TRACE_FILE: options.traceFile }),
      } },
      storage: {
        host: "local",
        local: { kvStoreDir },
      },
    });
  } finally {
    if (ownsKvStoreDir) {
      await rm(kvStoreDir, { recursive: true, force: true });
    }
  }
}

function createFixtureImageReference() {
  return {
    id: "gpt-image-context-pixel",
    name: "pixel.png",
    mimeType: "image/png",
    size: 68,
    kind: "image" as const,
    storage: "path" as const,
    path: path.join(process.cwd(), "workflow", "gpt-image", "__fixtures__", "pixel.png"),
    createdAt: "2026-06-02T00:00:00.000Z",
  };
}

async function readMockRunnerTraces(filePath: string): Promise<Array<{ mode: string; prompt: string; imageIds: string[] }>> {
  const content = await readFile(filePath, "utf8");
  return content.trim().split("\n").map((line) => JSON.parse(line) as { mode: string; prompt: string; imageIds: string[] });
}

function readOutput(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe("object");
  expect(value).not.toBe(null);
  const outer = value as { output?: unknown };
  expect(typeof outer.output).toBe("object");
  expect(outer.output).not.toBe(null);
  return outer.output as Record<string, unknown>;
}
