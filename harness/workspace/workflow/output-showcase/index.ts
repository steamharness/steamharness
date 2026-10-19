import type {
  OutputShowcaseConfirmationPayload,
  OutputShowcaseConfirmationValues,
  OutputShowcaseDisplaySnapshot,
  OutputShowcaseDisplaySnapshotItem,
  OutputShowcaseInput,
  OutputShowcaseOutputPayload,
} from "./interface";

const INTRO_ITEM_ID = "output-showcase-intro";
const TOOL_ITEM_ID = "output-showcase-tool-result";
const POST_TOOL_ITEM_ID = "output-showcase-post-tool";
const PRE_TASK_ITEM_ID = "output-showcase-pre-task";
const FINISHED_ITEM_ID = "output-showcase-finished";
const SKIPPED_ITEM_ID = "output-showcase-skipped";
const RAW_JSON_ITEM_ID = "output-showcase-raw-json";

const LONG_TASK_TIMER_ID = "output-showcase-long-task";
const DEFAULT_STREAM_DELAY_MS = 120;
const DEFAULT_TEXT_CHUNK_SIZE = 10;
const TOOL_PROGRESS_TEXT = "\n\n- 已读取 workflow 示例目录\n- 正在整理一条随机项目摘要...";
const PRE_TASK_TEXT = "你已确认，下面启动计时任务。";

// 模拟工具调用随机返回的 4 条项目相关内容。CI / 本地运行时通过 Math.random
// 选一条，App 运行时会看到不同的结果，但每条文本都来自当前工作流所在仓库
// 的真实主题。
const RANDOM_TOOL_RESULTS = [
  [
    "刚才扫描了 4 个核心模块的运行指标：",
    "- core/runtime-api: 0 错误",
    "- server/routes: 12 路由已注册",
    "- app/sqlite: 缓存命中率 86%",
    "- workflow/output: 4 个 item 已渲染",
  ].join("\n"),
  [
    "检索到 3 条最近的修复记录：",
    "- #87 修复 user input 节点的中断恢复",
    "- #88 修复 runtime timer 计时不准",
    "- #89 修复 details output 的 sticky 颜色",
  ].join("\n"),
  [
    "当前示例项目支持的输出形式：",
    "- Markdown 文本流",
    "- 折叠 details 块",
    "- 工具状态切换",
    "- 计时器卡片",
    "- 用户确认分支",
  ].join("\n"),
  [
    "解析出本项目结构概览：",
    "- 1 个 user input 节点",
    "- 1 个 timer 节点",
    "- 6 个 output 节点",
    "- 1 个 if / else 分支",
  ].join("\n"),
] as const;

const introOutputNode = workflow.createOutputNode<OutputShowcaseInput>({
  name: "intro-output",
  async *stream(input, context) {
    yield workflow.createOutputItemChunk({
      type: "output_item_start",
      item: {
        id: INTRO_ITEM_ID,
        // 非工具输出必须用 title: "Output" + 无 icon/iconPreset/metadata,
        // 才会被 App 的 OutputItemsContent 识别为 inline item,直接平铺展示,
        // 不被包进 <details> 块。
        title: "Output",
        content: "",
        contentType: "markdown",
        collapsed: false,
      },
    });

    const text = buildIntroText(input.projectName);

    yield* createSlowOutputItemText({
      itemId: INTRO_ITEM_ID,
      text,
      delayMs: input.streamDelayMs,
      signal: context.abortSignal,
    });

    yield workflow.createOutputItemChunk({
      type: "output_item_end",
      itemId: INTRO_ITEM_ID,
    });
  },
  format(stream) {
    return workflow.createOutputPayload({ items: stream.items });
  },
});

const toolOutputNode = workflow.createOutputNode<OutputShowcaseInput & { toolSummary: string }>({
  name: "tool-output",
  async *stream(input, context) {
    yield workflow.createOutputItemChunk({
      type: "output_item_start",
      item: {
        id: TOOL_ITEM_ID,
        title: "工具调用中",
        content: buildToolRunningText(input.projectName, input.toolDelayMs),
        contentType: "markdown",
        collapsed: true,
        iconPreset: "warning",
        metadata: {
          kind: "output-showcase-tool-call",
          status: "running",
          delayMs: input.toolDelayMs,
        },
      },
    });

    // 输出演示不能只在最后一次性给结果；工具块要先以运行中出现，
    // 再在同一个 item 上切到成功态，方便 App 的输出选项卡展示状态变化。
    const progressDelayMs = Math.floor(input.toolDelayMs * 0.45);
    const finishDelayMs = Math.max(0, input.toolDelayMs - progressDelayMs);

    await wait(progressDelayMs, context.abortSignal);
    throwIfAborted(context.abortSignal);
    yield* createSlowOutputItemText({
      itemId: TOOL_ITEM_ID,
      text: TOOL_PROGRESS_TEXT,
      delayMs: input.streamDelayMs,
      signal: context.abortSignal,
    });
    await wait(finishDelayMs, context.abortSignal);
    throwIfAborted(context.abortSignal);

    yield workflow.createOutputItemChunk({
      type: "output_item_delta",
      itemId: TOOL_ITEM_ID,
      delta: buildToolSuccessDelta(input.toolSummary),
      item: {
        title: "工具调用成功",
        iconPreset: "success",
        metadata: {
          kind: "output-showcase-tool-call",
          status: "success",
          delayMs: input.toolDelayMs,
        },
      },
    });

    yield workflow.createOutputItemChunk({
      type: "output_item_end",
      itemId: TOOL_ITEM_ID,
    });
  },
  format(stream) {
    return workflow.createOutputPayload({ items: stream.items });
  },
});

const postToolOutputNode = workflow.createOutputNode<OutputShowcaseInput>({
  name: "post-tool-output",
  async *stream(input, context) {
    yield workflow.createOutputItemChunk({
      type: "output_item_start",
      item: {
        id: POST_TOOL_ITEM_ID,
        title: "Output",
        content: "",
        contentType: "markdown",
        collapsed: false,
      },
    });

    const text = buildPostToolText();

    yield* createSlowOutputItemText({
      itemId: POST_TOOL_ITEM_ID,
      text,
      delayMs: input.streamDelayMs,
      signal: context.abortSignal,
    });

    yield workflow.createOutputItemChunk({
      type: "output_item_end",
      itemId: POST_TOOL_ITEM_ID,
    });
  },
  format(stream) {
    return workflow.createOutputPayload({ items: stream.items });
  },
});

const confirmationNode = workflow.createUserInputNode<
  OutputShowcaseInput,
  OutputShowcaseConfirmationPayload
>({
  name: "run-confirmation",
  title: "是否进入长任务",
  description: "接下来会启动一个 10 秒的计时任务并显示计时卡片。",
  params: [
    {
      // Confirmation node used to be a bare boolean (name:
      // "confirmed") that showed as a "confirmed *" field + on/off
      // switch in the user-input panel. Users looking at the panel
      // could not tell what the toggle meant at a glance. Replace it
      // with a radio whose options spell out the two possible actions
      // and surface a `label: "请选择"` so the form's field heading
      // reads as a question, not as an internal flag.
      name: "decision",
      flag: "--decision",
      type: "string",
      required: true,
      control: "radio",
      defaultValue: "enter",
      label: "请选择",
      options: [
        {
          value: "enter",
          label: "进入长任务",
          description: "启动 10 秒计时并显示计时卡片。",
        },
        {
          value: "skip",
          label: "跳过，直接结束演示",
          description: "不启动计时任务，直接进入收尾。",
        },
      ],
    },
  ],
  defaultValues: {
    decision: "enter",
  },
  format(payload) {
    return {
      errCode: 0,
      errMessage: "",
      requestId: payload.requestId,
      values: normalizeValues(payload.values),
      submittedAt: payload.submittedAt,
    };
  },
});

const timerNode = workflow.createTimerNode({
  name: "long-task-timer",
  title: "长任务计时",
  metadata: {
    type: "long-task-timer",
    title: "Long Task Timer",
    version: "1.0.0",
  },
});

const preTaskOutputNode = workflow.createOutputNode<OutputShowcaseInput>({
  name: "pre-task-output",
  async *stream(_input, context) {
    yield workflow.createOutputItemChunk({
      type: "output_item_start",
      item: {
        id: PRE_TASK_ITEM_ID,
        // inline 输出:title="Output",无 icon / iconPreset / metadata。
        title: "Output",
        content: "",
        contentType: "markdown",
        collapsed: false,
      },
    });

    const text = PRE_TASK_TEXT;

    yield* createSlowOutputItemText({
      itemId: PRE_TASK_ITEM_ID,
      text,
      delayMs: DEFAULT_STREAM_DELAY_MS,
      signal: context.abortSignal,
    });

    yield workflow.createOutputItemChunk({
      type: "output_item_end",
      itemId: PRE_TASK_ITEM_ID,
    });
  },
  format(stream) {
    return workflow.createOutputPayload({ items: stream.items });
  },
});

const finishedOutputNode = workflow.createOutputNode<
  OutputShowcaseInput & {
    toolSummary: string;
    longTaskTimerId: string;
    pageSnapshot: OutputShowcaseDisplaySnapshot;
  }
>({
  name: "finished-output",
  async *stream(input, context) {
    yield workflow.createOutputItemChunk({
      type: "output_item_start",
      item: {
        id: FINISHED_ITEM_ID,
        // inline 输出:title="Output",无 icon / iconPreset / metadata。
        title: "Output",
        content: "",
        contentType: "markdown",
        collapsed: false,
      },
    });

    const text = buildFinishedText({
      projectName: input.projectName,
      toolSummary: input.toolSummary,
      longTaskTimerId: input.longTaskTimerId,
    });

    yield* createSlowOutputItemText({
      itemId: FINISHED_ITEM_ID,
      text,
      delayMs: input.streamDelayMs,
      signal: context.abortSignal,
    });

    yield workflow.createOutputItemChunk({
      type: "output_item_end",
      itemId: FINISHED_ITEM_ID,
    });
  },
  format(stream, input) {
    return {
      ...workflow.createOutputPayload({ items: stream.items }),
      projectName: input.projectName,
      toolSummary: input.toolSummary,
      confirmed: true,
      longTaskTimerId: input.longTaskTimerId,
      pageSnapshot: input.pageSnapshot,
    };
  },
});

const skippedOutputNode = workflow.createOutputNode<
  OutputShowcaseInput & {
    toolSummary: string;
    pageSnapshot: OutputShowcaseDisplaySnapshot;
  }
>({
  name: "skipped-output",
  async *stream(input, context) {
    yield workflow.createOutputItemChunk({
      type: "output_item_start",
      item: {
        id: SKIPPED_ITEM_ID,
        // inline 输出:title="Output",无 icon / iconPreset / metadata。
        title: "Output",
        content: "",
        contentType: "markdown",
        collapsed: false,
      },
    });

    const text = buildSkippedText({
      projectName: input.projectName,
      toolSummary: input.toolSummary,
    });

    yield* createSlowOutputItemText({
      itemId: SKIPPED_ITEM_ID,
      text,
      delayMs: input.streamDelayMs,
      signal: context.abortSignal,
    });

    yield workflow.createOutputItemChunk({
      type: "output_item_end",
      itemId: SKIPPED_ITEM_ID,
    });
  },
  format(stream, input) {
    return {
      ...workflow.createOutputPayload({ items: stream.items }),
      projectName: input.projectName,
      toolSummary: input.toolSummary,
      confirmed: false,
      longTaskTimerId: "",
      pageSnapshot: input.pageSnapshot,
    };
  },
});

const rawJsonOutputNode = workflow.createOutputNode<{
  projectName: string;
  toolSummary: string;
  confirmed: boolean;
  longTaskTimerId: string;
  pageSnapshot: OutputShowcaseDisplaySnapshot;
}>({
  name: "raw-json-output",
  async *stream(input, context) {
    yield workflow.createOutputItemChunk({
      type: "output_item_start",
      item: {
        id: RAW_JSON_ITEM_ID,
        title: "Output",
        content: "",
        contentType: "markdown",
        collapsed: false,
      },
    });

    yield* createSlowOutputItemText({
      itemId: RAW_JSON_ITEM_ID,
      text: buildRawJsonText(input.pageSnapshot),
      delayMs: 0,
      size: Number.MAX_SAFE_INTEGER,
      signal: context.abortSignal,
    });

    yield workflow.createOutputItemChunk({
      type: "output_item_end",
      itemId: RAW_JSON_ITEM_ID,
    });
  },
  format(stream, input) {
    return {
      ...workflow.createOutputPayload({ items: stream.items }),
      projectName: input.projectName,
      toolSummary: input.toolSummary,
      confirmed: input.confirmed,
      longTaskTimerId: input.longTaskTimerId,
      pageSnapshot: input.pageSnapshot,
    };
  },
});

interface OutputShowcaseWorkflowState extends OutputShowcaseInput {
  toolSummary: string;
  confirmation: OutputShowcaseConfirmationPayload;
}

export const outputShowcaseWorkflow = workflow.defineWorkflow<
  OutputShowcaseInput,
  OutputShowcaseOutputPayload
>({
  name: "output-showcase",
  async run(input, context) {
    // 1. 项目介绍
    await workflow.runStreamNode(introOutputNode, input, context);

    // 2. 模拟工具调用：节点内部会先显示“进行中”，再切到“成功”。
    const toolSummary = pickRandomToolResult();
    await workflow.runStreamNode(toolOutputNode, { ...input, toolSummary }, context);
    await workflow.runStreamNode(postToolOutputNode, input, context);

    // 4. 用户确认
    const confirmation = await workflow.runNode(confirmationNode, input, context);

    const state: OutputShowcaseWorkflowState = {
      ...input,
      toolSummary,
      confirmation,
    };

    // 5. 用户确认分支
    return workflow.runIf(state, context, {
      name: "用户确认分支",
      branches: [
        {
          label: "执行长任务",
          condition: (value) => value.confirmation.values.confirmed === true,
          run: async (value, branchContext) => {
            await workflow.runStreamNode(preTaskOutputNode, value, branchContext);
            const timer = await workflow.runNode(timerNode, {
              timerId: LONG_TASK_TIMER_ID,
              title: "长任务计时",
              metadata: { phase: "running" },
            }, branchContext);
            await wait(value.taskDurationMs, branchContext.abortSignal);
            throwIfAborted(branchContext.abortSignal);
            await workflow.endTimer(timer, branchContext, {
              message: "业务阶段已显式结束",
              metadata: { waitedMs: value.taskDurationMs },
            });
            const pageSnapshot = buildDisplaySnapshot({
              projectName: value.projectName,
              toolSummary: value.toolSummary,
              confirmed: true,
              longTaskTimerId: timer.timerId,
              timerDurationMs: value.taskDurationMs,
            });
            await workflow.runStreamNode(
              finishedOutputNode,
              {
                ...value,
                longTaskTimerId: timer.timerId,
                pageSnapshot,
              },
              branchContext,
            );
            return workflow.runStreamNode(rawJsonOutputNode, {
              projectName: value.projectName,
              toolSummary: value.toolSummary,
              confirmed: true,
              longTaskTimerId: timer.timerId,
              pageSnapshot,
            }, branchContext);
          },
        },
      ],
      else: {
        label: "跳过",
        run: async (value, branchContext) => {
          const pageSnapshot = buildDisplaySnapshot({
            projectName: value.projectName,
            toolSummary: value.toolSummary,
            confirmed: false,
            longTaskTimerId: "",
          });
          await workflow.runStreamNode(skippedOutputNode, {
            ...value,
            pageSnapshot,
          }, branchContext);
          return workflow.runStreamNode(rawJsonOutputNode, {
            projectName: value.projectName,
            toolSummary: value.toolSummary,
            confirmed: false,
            longTaskTimerId: "",
            pageSnapshot,
          }, branchContext);
        },
      },
    });
  },
});

export const executor = workflow.defineExecutor<
  OutputShowcaseInput,
  OutputShowcaseOutputPayload
>({
  projectType: "workflow",
  defaultEntrypoint: "main",
  entrypoints: [
    workflow.defineEntrypoint<OutputShowcaseInput, OutputShowcaseOutputPayload>(
      {
        id: "main",
        title: "Output Showcase",
        workflow: outputShowcaseWorkflow,
        params: [
          {
            name: "projectName",
            flag: "--project-name",
            type: "string",
            required: false,
            defaultValue: "output-showcase",
            description: "示例项目名，会出现在介绍文字和最终输出里。",
          },
          {
            name: "toolDelayMs",
            flag: "--tool-delay-ms",
            type: "number",
            required: false,
            defaultValue: "3000",
            description: "模拟工具调用的等待时长，单位毫秒。",
          },
          {
            name: "taskDurationMs",
            flag: "--task-duration-ms",
            type: "number",
            required: false,
            defaultValue: "10000",
            description: "确认后长任务的等待时长，单位毫秒。",
          },
          {
            name: "streamDelayMs",
            flag: "--stream-delay-ms",
            type: "number",
            required: false,
            defaultValue: String(DEFAULT_STREAM_DELAY_MS),
            description: "每段流式文字之间的等待时长，单位毫秒。",
          },
        ],
        createInput({ args }) {
          return parseInput(args);
        },
      },
    ),
  ],
});

export { outputShowcaseWorkflow as workflow };
export default outputShowcaseWorkflow;

function parseInput(args: string[]): OutputShowcaseInput {
  let projectName = "output-showcase";
  let toolDelayMs = 3000;
  let taskDurationMs = 10000;
  let streamDelayMs = DEFAULT_STREAM_DELAY_MS;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--project-name") {
      projectName = args[++index] ?? projectName;
    } else if (arg === "--tool-delay-ms") {
      toolDelayMs = normalizeNumber(args[++index], toolDelayMs, 0, 60_000);
    } else if (arg === "--task-duration-ms") {
      taskDurationMs = normalizeNumber(args[++index], taskDurationMs, 0, 60_000);
    } else if (arg === "--stream-delay-ms") {
      streamDelayMs = normalizeNumber(args[++index], streamDelayMs, 0, 5_000);
    }
  }

  return {
    projectName: projectName.trim() === "" ? "output-showcase" : projectName,
    toolDelayMs,
    taskDurationMs,
    streamDelayMs,
  };
}

function normalizeNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function normalizeValues(values: Record<string, unknown>): OutputShowcaseConfirmationValues {
  return {
    // The wire form of the confirmation node is a radio whose
    // `decision` value is "enter" or "skip". Downstream branches and
    // output payloads still reason in terms of the boolean `confirmed`,
    // so map the radio value back to a boolean here. Treat any
    // unrecognised value as "no" so a tampered resume payload can
    // never silently enter the long-task branch.
    confirmed: values["decision"] === "enter",
  };
}

function pickRandomToolResult(): string {
  const index = Math.floor(Math.random() * RANDOM_TOOL_RESULTS.length);
  return RANDOM_TOOL_RESULTS[Math.max(0, Math.min(RANDOM_TOOL_RESULTS.length - 1, index))];
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      signal?.removeEventListener("abort", finish);
      resolve();
    };

    timeout = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) {
      finish();
    }
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) {
    return;
  }

  throw new workflow.HarnessError({
    type: "execution_aborted",
    message: "Output showcase run was cancelled.",
    cause: signal.reason,
  });
}

async function* createSlowOutputItemText(options: {
  itemId: string;
  text: string;
  delayMs: number;
  size?: number;
  signal?: AbortSignal;
}) {
  const pieces = [...splitText(options.text, options.size ?? DEFAULT_TEXT_CHUNK_SIZE)];
  for (const [index, piece] of pieces.entries()) {
    throwIfAborted(options.signal);
    yield workflow.createOutputItemChunk({
      type: "output_item_delta",
      itemId: options.itemId,
      delta: piece,
    });
    if (index < pieces.length - 1 && options.delayMs > 0) {
      await wait(options.delayMs, options.signal);
    }
  }
}

function* splitText(text: string, size: number): Generator<string> {
  if (text.length === 0) {
    return;
  }
  if (size <= 0) {
    yield text;
    return;
  }
  for (let index = 0; index < text.length; index += size) {
    yield text.slice(index, index + size);
  }
}

function buildDisplaySnapshot(input: {
  projectName: string;
  toolSummary: string;
  confirmed: boolean;
  longTaskTimerId: string;
  timerDurationMs?: number;
}): OutputShowcaseDisplaySnapshot {
  const items: OutputShowcaseDisplaySnapshotItem[] = [
    {
      id: INTRO_ITEM_ID,
      kind: "output",
      title: "Output",
      content: buildIntroText(input.projectName),
      contentType: "markdown",
      collapsed: false,
    },
    {
      id: TOOL_ITEM_ID,
      kind: "tool",
      title: "工具调用成功",
      content: buildToolOutputText(input.projectName, input.toolSummary),
      contentType: "markdown",
      collapsed: true,
      metadata: {
        kind: "output-showcase-tool-call",
        status: "success",
      },
    },
    {
      id: POST_TOOL_ITEM_ID,
      kind: "output",
      title: "Output",
      content: buildPostToolText(),
      contentType: "markdown",
      collapsed: false,
    },
    {
      id: "output-showcase-confirmation-result",
      kind: "user-input-resolved",
      title: "用户确认结果",
      content: {
        confirmed: input.confirmed,
      },
      contentType: "json",
      collapsed: false,
    },
  ];

  if (input.confirmed) {
    items.push({
      id: PRE_TASK_ITEM_ID,
      kind: "output",
      title: "Output",
      content: PRE_TASK_TEXT,
      contentType: "markdown",
      collapsed: false,
    });
    items.push({
      id: LONG_TASK_TIMER_ID,
      kind: "timer",
      title: "长任务计时",
      content: {
        timerId: input.longTaskTimerId,
        status: "success",
        durationMs: input.timerDurationMs,
        message: "业务阶段已显式结束",
      },
      contentType: "json",
      collapsed: false,
    });
    items.push({
      id: FINISHED_ITEM_ID,
      kind: "output",
      title: "Output",
      content: buildFinishedText({
        projectName: input.projectName,
        toolSummary: input.toolSummary,
        longTaskTimerId: input.longTaskTimerId,
      }),
      contentType: "markdown",
      collapsed: false,
    });
  } else {
    items.push({
      id: SKIPPED_ITEM_ID,
      kind: "output",
      title: "Output",
      content: buildSkippedText({
        projectName: input.projectName,
        toolSummary: input.toolSummary,
      }),
      contentType: "markdown",
      collapsed: false,
    });
  }

  return {
    projectName: "output-showcase",
    projectName: input.projectName,
    confirmed: input.confirmed,
    toolSummary: input.toolSummary,
    longTaskTimerId: input.longTaskTimerId,
    items,
  };
}

function buildIntroText(projectName: string): string {
  return [
    `## ${projectName}`,
    "",
    "这是一个专门用于展示 **输出选项卡** 效果的示例 workflow。",
    "",
    "界面里会依次看到：",
    "",
    "- 一段慢速流式介绍文字",
    "- 一个带“进行中 / 成功”状态切换的模拟工具调用",
    "- 用户确认分支和长任务计时卡片",
  ].join("\n");
}

function buildToolRunningText(projectName: string, toolDelayMs: number): string {
  return [
    "⏳ 工具调用进行中（模拟）",
    "",
    `- 项目：${projectName}`,
    `- 预计耗时：${toolDelayMs}ms`,
    "- 正在扫描当前项目相关内容...",
  ].join("\n");
}

function buildToolSuccessDelta(toolSummary: string): string {
  return `\n\n✅ 工具调用成功（模拟）\n\n${toolSummary}`;
}

function buildToolOutputText(projectName: string, toolSummary: string): string {
  return [
    "⏳ 工具调用进行中（模拟）",
    "",
    `- 项目：${projectName}`,
    "- 预计耗时：已完成",
    "- 正在扫描当前项目相关内容...",
    "",
    "- 已读取 workflow 示例目录",
    "- 正在整理一条随机项目摘要...",
    "",
    "✅ 工具调用成功（模拟）",
    "",
    toolSummary,
  ].join("\n");
}

function buildPostToolText(): string {
  return [
    "上面的工具块已经从“进行中”切换成“成功”。",
    "",
    "下面会展示一个用户确认选项：",
    "",
    "- 选择执行：进入长任务并显示计时卡片",
    "- 选择不执行：直接结束本次演示",
  ].join("\n");
}

function buildFinishedText(input: {
  projectName: string;
  toolSummary: string;
  longTaskTimerId: string;
}): string {
  const firstToolLine = input.toolSummary.split("\n")[0] ?? input.toolSummary;
  return [
    "🎉 长任务执行完毕，计时器已结束。",
    "",
    `- 项目：${input.projectName}`,
    `- 工具摘要：${firstToolLine}`,
    `- 计时 ID：${input.longTaskTimerId}`,
  ].join("\n");
}

function buildSkippedText(input: {
  projectName: string;
  toolSummary: string;
}): string {
  const firstToolLine = input.toolSummary.split("\n")[0] ?? input.toolSummary;
  return [
    "你选择了不执行长任务，示例到此结束。",
    "",
    `- 项目：${input.projectName}`,
    `- 工具摘要：${firstToolLine}`,
  ].join("\n");
}

function stringifySnapshot(snapshot: OutputShowcaseDisplaySnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

function buildRawJsonText(snapshot: OutputShowcaseDisplaySnapshot): string {
  return [
    "下面是当前页面全部展示内容组成的原始 JSON：",
    "",
    "```json",
    stringifySnapshot(snapshot),
    "```",
  ].join("\n");
}
