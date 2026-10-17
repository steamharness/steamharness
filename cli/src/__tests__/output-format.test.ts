import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  createCliOutputStreamHooks,
  formatCliOutputContent,
  formatWorkflowExecutionJson,
  type WorkflowExecutionReport,
} from "steamharness";

const videoUrl = "https://cdn.example.test/minimax-video.mp4?signature=redacted";
const videoDescriptor = {
  src: videoUrl,
  mimeType: "video/mp4",
  name: "minimax-video.mp4",
  durationMs: 5_000,
  format: "mp4",
};

describe("CLI output formatting", () => {
  it("keeps readable links in ordinary output and preserves video descriptors in JSON", () => {
    const output = formatCliOutputContent({
      errCode: 0,
      errMessage: "",
      items: [
        {
          id: "summary",
          title: "Output",
          content: `视频任务完成。\n\n[打开 / 下载视频](${videoUrl})`,
          contentType: "markdown",
          collapsed: false,
        },
        {
          id: "minimax-video:task-1",
          title: "MiniMax 视频",
          content: videoDescriptor,
          contentType: "video",
          collapsed: false,
        },
      ],
    });

    assert.ok(output.includes(`[打开 / 下载视频](${videoUrl})`));
    assert.match(output, /"mimeType":\s*"video\/mp4"/);
    assert.match(output, /"name":\s*"minimax-video\.mp4"/);
  });

  it("does not throw for output items with an unknown future content type", () => {
    assert.doesNotThrow(() => {
      const output = formatCliOutputContent({
        items: [{
          id: "future-item",
          title: "Future output",
          content: { value: "kept" },
          contentType: "model-3d",
        }],
      });
      assert.match(output, /"value":\s*"kept"/);
    });
  });

  it("streams a video item start without treating its descriptor as text markup", () => {
    const writes: string[] = [];
    const hooks = createCliOutputStreamHooks();
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      hooks.onNodeChunk?.({
        nodeName: "output",
        executionId: "run-video",
        chunk: "[打开 / 下载视频](https://cdn.example.test/video.mp4)",
      } as never);
      hooks.onNodeChunk?.({
        nodeName: "output",
        executionId: "run-video",
        chunk: {
          type: "output_item_start",
          item: {
            id: "video-item",
            title: "MiniMax 视频",
            content: videoDescriptor,
            contentType: "video",
            collapsed: false,
          },
        },
      } as never);
    } finally {
      process.stdout.write = originalWrite;
    }

    const streamed = writes.join("");
    assert.match(streamed, /打开 \/ 下载视频/);
    assert.match(streamed, /MiniMax 视频/);
    assert.doesNotMatch(streamed, /<video/);
  });

  it("retains video contentType in JSON execution reports", () => {
    const report = {
      status: "success",
      outputs: [{
        output: {
          items: [{
            id: "video-item",
            title: "MiniMax 视频",
            content: videoDescriptor,
            contentType: "video",
            collapsed: false,
          }],
        },
      }],
      result: { ok: true, data: {} },
    } as unknown as WorkflowExecutionReport;

    const json = formatWorkflowExecutionJson(report);
    assert.match(json, /"contentType":\s*"video"/);
    assert.match(json, /"src":\s*"https:\/\/cdn\.example\.test\/minimax-video\.mp4/);
  });
});
