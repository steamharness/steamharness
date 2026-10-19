import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProjectScriptSource } from "../executor/rules";
import {
  addOutputItem,
  createOutputItem,
  createOutputItemChunk,
  createOutputNode,
  createOutputPayload,
  createOutputStreamAccumulator,
  createDetailsOutputNode,
  createDisabledProjectConversationContext,
  createDisabledProjectTokenUsageContext,
  createProjectRelatedProjectsContext,
  isOutputContentType,
  isOutputItemStreamChunk,
  type KVContext,
  type RunOutputPayload,
} from "../index";
import { runNode, runStreamNode } from "../workflow/index";
import type { RunContext } from "../types/index";
import { createProjectExecutionReport } from "../executor/report";

test("ring presentation survives output helpers and stream patches", () => {
  const item = createOutputItem({
    id: "quota",
    title: "Storage quota",
    content: { value: 57, total: 100, unit: "MB" },
    display: { type: "ring" },
  });
  assert.deepEqual(createOutputPayload({ items: [item] }).items[0]?.display, { type: "ring" });
  const stream = createOutputStreamAccumulator([
    createOutputItemChunk({ type: "output_item_start", item }),
    createOutputItemChunk({
      type: "output_item_delta", itemId: "quota", delta: { value: 75, total: 100, unit: "MB" },
      item: { display: { type: "ring", placement: "composer-right" } },
    }),
    createOutputItemChunk({ type: "output_item_end", itemId: "quota" }),
    "The answer stays inline.",
  ]);
  assert.deepEqual(stream.items[0]?.display, { type: "ring", placement: "composer-right" });
  assert.deepEqual(stream.items[0]?.content, { value: 75, total: 100, unit: "MB" });
  assert.equal(stream.items[1]?.content, "The answer stays inline.");
  assert.equal(stream.items[1]?.display, undefined);
  assert.equal(stream.items[1]?.collapsed, false);
});

test("createDetailsOutputNode formats a standard collapsible output item", async () => {
  const node = createDetailsOutputNode();
  const output = await runNode(node, {
    title: "点击展开",
    icon: "info",
    content: [
      "这里是被折叠的内容。",
      "",
      "- 列表",
      "- **加粗**",
    ].join("\n"),
  }, createTestProjectContext());

  assert.equal(output.errCode, 0);
  assert.equal(output.errMessage, "");
  assert.equal(output.items.length, 1);
  assert.equal(output.items[0]?.title, "点击展开");
  assert.equal(output.items[0]?.icon, "[i]");
  assert.equal(output.items[0]?.iconPreset, "info");
  assert.equal(output.items[0]?.contentType, "markdown");
  assert.equal(output.items[0]?.collapsed, true);
  assert.equal(output.items[0]?.content, [
    "这里是被折叠的内容。",
    "",
    "- 列表",
    "- **加粗**",
  ].join("\n"));
});

test("createDetailsOutputNode supports custom icon and object content", async () => {
  const node = createDetailsOutputNode<{
    name: string;
    score: number;
  }>({
    title: (input) => `Result for ${input.name}`,
    icon: "custom-icon",
    content: (input) => ({ score: input.score, passed: input.score >= 80 }),
  });

  const output = await runNode(node, { name: "alpha", score: 92 }, createTestProjectContext());

  assert.equal(output.items.length, 1);
  assert.equal(output.items[0]?.title, "Result for alpha");
  assert.equal(output.items[0]?.icon, "custom-icon");
  assert.equal(output.items[0]?.contentType, "json");
  assert.deepEqual(output.items[0]?.content, { score: 92, passed: true });
});

test("workflow structure recognizes createDetailsOutputNode as output", () => {
  const analysis = analyzeProjectScriptSource(`
    const detailsNode = steamharness.createDetailsOutputNode({
      name: "output",
      title: "Summary",
      content: "Body",
      icon: "success",
    });

    export const demo = steamharness.defineProject({
      name: "demo",
      async run(input, context) {
        return steamharness.runNode(detailsNode, input, context);
      },
    });
  `);

  assert.equal(analysis.structureApiCalls.some((call) => call.method === "createDetailsOutputNode"), true);
  assert.equal(analysis.structureNodes[0]?.factory, "createDetailsOutputNode");
  assert.equal(analysis.structureNodes[0]?.standardName, "output");
});

test("workflow structure recognizes executor tokenUsage configuration", () => {
  const analysis = analyzeProjectScriptSource(`
    const outputNode = steamharness.createOutputNode({
      name: "output",
      format(input) {
        return { errCode: 0, errMessage: "", content: String(input) };
      },
    });

    export const demo = steamharness.defineProject({
      name: "demo",
      async run(input, context) {
        return steamharness.runNode(outputNode, input, context);
      },
    });

    export const executor = steamharness.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "main",
      entrypoints: [steamharness.defineEntrypoint({
        id: "main",
        title: "Main",
        workflow: demo,
        tokenUsage: {
          enabled: true,
          display: false,
        },
        createInput() { return {}; },
      })],
    });
  `);

  assert.deepEqual(analysis.executorEntrypoints?.[0]?.tokenUsage, {
    enabled: true,
    display: false,
  });
});

test("workflow structure preserves textarea and date-related executor param controls", () => {
  const analysis = analyzeProjectScriptSource(`
    const outputNode = steamharness.createOutputNode({
      name: "output",
      format(input) {
        return { errCode: 0, errMessage: "", content: String(input.prompt) };
      },
    });

    export const demo = steamharness.defineProject({
      name: "demo",
      async run(input, context) {
        return steamharness.runNode(outputNode, input, context);
      },
    });

    export const executor = steamharness.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "main",
      entrypoints: [steamharness.defineEntrypoint({
        id: "main",
        title: "Main",
        workflow: demo,
        params: [
          { name: "prompt", flag: "--prompt", type: "string", control: "textarea" },
          { name: "day", flag: "--day", type: "string", control: "date" },
          { name: "time", flag: "--time", type: "string", control: "time" },
          { name: "startsAt", flag: "--starts-at", type: "string", control: "datetime" },
          { name: "period", flag: "--period", type: "string", control: "date-range" },
        ],
        createInput({ args }) {
          return { prompt: args.join(" ") };
        },
      })],
    });
  `);

  assert.deepEqual(analysis.executorEntrypoints?.[0]?.params?.map((param) => param.control), [
    "textarea",
    "date",
    "time",
    "datetime",
    "date-range",
  ]);
});

test("output helpers create and append normalized output items", () => {
  const item = createOutputItem({
    title: "Tool Result",
    icon: "success",
    content: { ok: true },
    collapsed: true,
  });
  const payload = addOutputItem(createOutputPayload({ metadata: { source: "test" } }), item);

  assert.equal(item.icon, "[ok]");
  assert.equal(item.iconPreset, "success");
  assert.equal(item.contentType, "json");
  assert.deepEqual(payload.items, [item]);
  assert.deepEqual(payload.metadata, { source: "test" });
});

test("output helpers preserve audio content type", () => {
  const item = createOutputItem({
    title: "Speech",
    content: {
      src: "data:audio/wav;base64,UklGRgAAAAAA",
      mimeType: "audio/wav",
      name: "speech.wav",
      size: 12,
      format: "wav",
    },
    contentType: "audio",
  });
  const payload = createOutputPayload({ items: [item] });

  assert.equal(item.contentType, "audio");
  assert.equal(payload.items[0]?.contentType, "audio");
});

test("output helpers preserve video descriptors and recognize video content type", () => {
  const content = {
    src: "https://cdn.example.test/video.mp4?signature=redacted",
    mimeType: "video/mp4",
    name: "minimax-video.mp4",
    durationMs: 5000,
    format: "mp4",
  };
  const item = createOutputItem({
    id: "video-item",
    title: "MiniMax video",
    content,
    contentType: "video",
    collapsed: false,
  });

  assert.equal(isOutputContentType("video"), true);
  assert.equal(item.contentType, "video");
  assert.deepEqual(item.content, content);
});

test("output stream accumulator keeps video item start, delta and end data", () => {
  const stream = createOutputStreamAccumulator([
    createOutputItemChunk({
      type: "output_item_start",
      item: {
        id: "video-item",
        title: "MiniMax video",
        content: {
          src: "https://cdn.example.test/video.mp4",
          mimeType: "video/mp4",
          name: "minimax-video.mp4",
        },
        contentType: "video",
        collapsed: false,
      },
    }),
    createOutputItemChunk({
      type: "output_item_delta",
      itemId: "video-item",
      delta: { durationMs: 5000, format: "mp4" },
      item: { contentType: "video", collapsed: false },
    }),
    createOutputItemChunk({ type: "output_item_end", itemId: "video-item" }),
  ]);

  assert.equal(stream.items.length, 1);
  assert.equal(stream.items[0]?.contentType, "video");
  assert.deepEqual(stream.items[0]?.content, {
    src: "https://cdn.example.test/video.mp4",
    mimeType: "video/mp4",
    name: "minimax-video.mp4",
    durationMs: 5000,
    format: "mp4",
  });
  assert.equal(stream.items[0]?.collapsed, false);
});

test("stream chunk validation rejects malformed item starts without throwing", () => {
  assert.equal(isOutputItemStreamChunk({
    type: "output_item_start",
    item: {
      id: "valid",
      title: "Video",
      content: { src: "https://cdn.example.test/video.mp4" },
      contentType: "video",
    },
  }), true);
  assert.equal(isOutputItemStreamChunk({
    type: "output_item_start",
    item: { id: "missing-content", title: "Video", contentType: "video" },
  }), false);
  assert.equal(isOutputItemStreamChunk({ type: "output_item_delta", itemId: "video" }), false);
});

test("execution reports preserve ring display declarations and raw values", () => {
  const payload = createOutputPayload({ items: [{
    id: "quota", title: "Quota", content: { value: 57, total: 100, unit: "MB" },
    display: { type: "ring", placement: "composer-right" },
  }] });
  const report = createProjectExecutionReport({
    runId: "run-quota", projectName: "quota", status: "success",
    startedAt: new Date("2026-10-14T00:00:00.000Z"), endedAt: new Date("2026-10-14T00:00:01.000Z"),
    result: { ok: true, data: payload }, nodes: [],
    outputs: [{ order: 1, nodeOrder: 1, nodeName: "output", output: payload }],
  });
  assert.deepEqual(report.outputs[0]?.output.items[0]?.display, payload.items[0]?.display);
  const data = report.result.ok ? report.result.data as { output?: RunOutputPayload } : undefined;
  assert.deepEqual(data?.output?.items[0]?.display, payload.items[0]?.display);
  assert.deepEqual(data?.output?.items[0]?.content, { value: 57, total: 100, unit: "MB" });
});

test("final execution reports retain video content types during normalization", () => {
  const startedAt = new Date("2026-05-26T00:00:00.000Z");
  const endedAt = new Date("2026-05-26T00:00:01.000Z");
  const payload = createOutputPayload({
    items: [{
      id: "video-item",
      title: "MiniMax video",
      content: {
        src: "https://cdn.example.test/video.mp4",
        mimeType: "video/mp4",
        name: "minimax-video.mp4",
      },
      contentType: "video",
      collapsed: false,
    }],
  });

  const report = createProjectExecutionReport({
    runId: "run-video",
    projectName: "video",
    startedAt,
    endedAt,
    status: "success",
    result: {
      ok: true,
      data: payload,
    },
    nodes: [],
    outputs: [{ order: 1, nodeOrder: 1, nodeName: "output", output: payload }],
  });

  assert.equal(report.outputs[0]?.output.items[0]?.contentType, "video");
  const reportedData = report.result.ok
    ? report.result.data as { output?: { items?: Array<{ contentType?: string }> } }
    : undefined;
  assert.equal(
    reportedData?.output?.items?.[0]?.contentType,
    "video",
  );
});

test("output stream accumulator merges item start, delta and end chunks", async () => {
  const chunks = [
    "hello",
    createOutputItemChunk({
      type: "output_item_start",
      item: {
        id: "tool",
        title: "Tool",
        content: { count: 1 },
        contentType: "json",
        collapsed: true,
      },
    }),
    createOutputItemChunk({
      type: "output_item_delta",
      itemId: "tool",
      delta: { ok: true },
      item: {
        title: "Tool complete",
        icon: "success",
        metadata: { status: "success", durationMs: 1200 },
      },
    }),
    createOutputItemChunk({
      type: "output_item_end",
      itemId: "tool",
    }),
    " world",
  ];
  const stream = createOutputStreamAccumulator(chunks);

  assert.equal(stream.text, "hello world");
  assert.equal(stream.items.length, 2);
  assert.equal(stream.items[0]?.content, "hello world");
  assert.equal(stream.items[0]?.icon, undefined);
  assert.equal(stream.items[0]?.iconPreset, undefined);
  assert.equal(stream.items[1]?.title, "Tool complete");
  assert.equal(stream.items[1]?.icon, "[ok]");
  assert.deepEqual(stream.items[1]?.metadata, { status: "success", durationMs: 1200 });
  assert.deepEqual(stream.items[1]?.content, { count: 1, ok: true });
  assert.equal(stream.items[1]?.collapsed, true);
});

test("createOutputNode stream format receives text, items and chunks", async () => {
  interface TestOutputPayload extends RunOutputPayload {
    text: string;
    chunkCount: number;
  }

  const node = createOutputNode<string, TestOutputPayload>({
    async *stream(input: string) {
      yield "prefix:";
      yield createOutputItemChunk({
        type: "output_item_start",
        item: {
          id: "custom",
          title: "Custom",
          content: input,
          contentType: "text",
          collapsed: false,
        },
      });
    },
    format(stream) {
      return {
        ...createOutputPayload({
          items: stream.items,
        }),
        text: stream.text,
        chunkCount: stream.chunks.length,
      };
    },
  });

  const result = await runStreamNode(node, "body", createTestProjectContext());

  assert.equal(result.output?.text, "prefix:");
  assert.equal(result.output?.chunkCount, 2);
  assert.equal(result.output?.items.length, 2);
  assert.equal(result.output?.items[0]?.content, "prefix:");
  assert.equal(result.output?.items[1]?.content, "body");
});

function createTestProjectContext(): RunContext {
  const kv = createMemoryKVContext();

  return {
    providers: {},
    storage: {
      local: { kv, persistentValue: createMemoryKVContext(), relatedProjects: createProjectRelatedProjectsContext() },
      server: { kv: createMemoryKVContext(), persistentValue: createMemoryKVContext(), relatedProjects: createProjectRelatedProjectsContext() },
    },
    conversation: createDisabledProjectConversationContext(),
    tokenUsage: createDisabledProjectTokenUsageContext(),
  };
}

function createMemoryKVContext(): KVContext {
  const values = new Map<string, unknown>();

  function createNamespace(prefix: string) {
    return {
      async getValue(key: string) {
        return values.get(`${prefix}:${key}`);
      },
      async setValue(key: string, value: unknown) {
        values.set(`${prefix}:${key}`, value);
      },
      async deleteValue(key: string) {
        return values.delete(`${prefix}:${key}`);
      },
      async updateValue(key: string, updater: (current: unknown | undefined) => unknown) {
        const next = updater(values.get(`${prefix}:${key}`));
        values.set(`${prefix}:${key}`, next);
        return next;
      },
    };
  }

  const project = createNamespace("project");

  return {
    ...project,
    conversation: createNamespace("conversation"),
  };
}
