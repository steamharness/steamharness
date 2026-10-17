import type { RuntimeTimerInput, RuntimeTimerOutputPayload } from "./interface";

const timerNode = workflow.createTimerNode({
  name: "business-timer",
  title: "业务阶段计时",
  metadata: {
    title: "Runtime Timer",
    type: "runtime-timer",
    version: "1.0.0",
  },
});

const outputNode = workflow.createOutputNode<RuntimeTimerInput & {
  completedTimerId: string;
}, RuntimeTimerOutputPayload>({
  name: "runtime-timer-output",
  format(input) {
    const lines = [
      `已完成计时：${input.title}`,
      `等待时长：${input.milliseconds}ms`,
    ];

    return {
      ...workflow.createOutputPayload({
        items: [{
          title: "Runtime Timer",
          content: lines.join("\n"),
          contentType: "markdown",
          collapsed: false,
        }],
      }),
      title: input.title,
      milliseconds: input.milliseconds,
      completedTimerId: input.completedTimerId,
    };
  },
});

export const runtimeTimerWorkflow = workflow.defineWorkflow<RuntimeTimerInput, RuntimeTimerOutputPayload>({
  name: "runtime-timer",
  async run(input, context) {
    const completedTimer = await workflow.runNode(timerNode, {
      timerId: "runtime-timer-completed",
      title: input.title,
      metadata: { phase: "completed" },
    }, context);

    await wait(input.milliseconds);
    await workflow.endTimer(completedTimer, context, {
      message: "业务阶段已显式结束",
      metadata: { waitedMs: input.milliseconds },
    });

    return workflow.runNode(outputNode, {
      ...input,
      completedTimerId: completedTimer.timerId,
    }, context);
  },
});

export const executor = workflow.defineExecutor<
  RuntimeTimerInput,
  RuntimeTimerOutputPayload
>({
  projectType: "workflow",
  defaultEntrypoint: "main",
  entrypoints: [
    workflow.defineEntrypoint<RuntimeTimerInput, RuntimeTimerOutputPayload>({
      id: "main",
      title: "Runtime Timer",
      workflow: runtimeTimerWorkflow,
      params: [
        {
          name: "title",
          flag: "--title",
          type: "string",
          required: false,
          defaultValue: "业务阶段计时",
          description: "计时卡片标题。",
        },
        {
          name: "milliseconds",
          flag: "--milliseconds",
          type: "number",
          required: false,
          defaultValue: "2000",
          description: "模拟业务耗时，单位毫秒。",
        },
      ],
      createInput({ args }) {
        return parseInput(args);
      },
    }),
  ],
});

export { runtimeTimerWorkflow as workflow };
export default runtimeTimerWorkflow;

function parseInput(args: string[]): RuntimeTimerInput {
  let title = "业务阶段计时";
  let milliseconds = 2000;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--title") {
      title = normalizeTitle(args[++index]);
    } else if (arg === "--milliseconds") {
      milliseconds = normalizeMilliseconds(args[++index]);
    }
  }

  return { title, milliseconds };
}

function normalizeTitle(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? "业务阶段计时" : normalized;
}

function normalizeMilliseconds(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 2000;
  }

  // keeps the runtime-timer sample tied to the form input duration:
  // entering 2000 should wait and display about 2000ms, not a hard-coded 1000ms.
  return Math.max(0, Math.min(60_000, Math.round(parsed)));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
