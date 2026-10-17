import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  MockLLMProvider,
  inspectLocalWorkflowStructure,
  runLocalWorkflowWithReport,
  WorkflowError,
  type LLMChatInput,
  type WorkflowExecutionReport,
  type WorkflowExecutionStorageOptions,
  type WorkflowFileReference,
  type WorkflowKVStore,
  type WorkflowRuntimeEvent,
  type WorkflowStructureReport,
  type WorkflowUserInputContext,
} from "workflow-code";
import type { WorkflowOutputItem } from "workflow-code/node/output";
import type {
  WorkflowStructureExecution,
  WorkflowStructureExecutionBranch,
  WorkflowStructureExecutionBranchPath,
  WorkflowStructureExecutionItem,
  WorkflowStructureExecutionLoop,
  WorkflowStructureExecutionNode,
} from "workflow-code/executor/rules";

const workflowNames = [
  "classify",
  "claude-agent",
  "conversation-knowledge",
  "deltaforce-bilibili-collect",
  "deltafore-agent",
  "deltaforce-openai-agent",
  "details-output",
  "game",
  "gpt-image",
  "gitlab-webhook",
  "hello",
  "human-input",
  "local-data-parent",
  "local-data-child",
  "local-data-grandchild",
  "loop",
  "minimax-speech-t2a",
  "openai-agents",
  "output-showcase",
  "pi-agent",
  "runtime-timer",
  "runtime-platform",
  "server-data-parent",
  "server-data-child",
  "server-data-grandchild",
  "smoke",
] as const;

const WORKFLOW_ROOT = path.resolve(process.cwd(), "workflow");

type WorkflowName = (typeof workflowNames)[number];

interface WorkflowOutputItemExpectation {
  index?: number;
  title?: string;
  content?: unknown;
  contentType?: string;
  icon?: string;
  iconPreset?: string;
  collapsed?: boolean;
  metadata?: Record<string, unknown>;
  contentIncludes?: string[];
  contentMatches?: unknown;
}

interface WorkflowSmokeFixture {
  args: string[];
  conversationId?: string;
  run?: boolean;
  skipReason?: string;
  expected: {
    status?: WorkflowExecutionReport["status"];
    errCode: number;
    errMessage?: string;
    outputRequired?: boolean;
    output?: Record<string, unknown>;
    item?: {
      title?: string;
      content?: unknown;
      contentType?: string;
      iconPreset?: string;
    };
    itemCount?: number;
    items?: WorkflowOutputItemExpectation[];
    contentIncludes?: string[];
    nodes?: string[];
    outputCount?: number;
    conversationMessages?: number;
    tokenUsage?: {
      enabled?: boolean;
      display?: boolean;
      calls?: number;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cachedInputTokens?: number;
      cacheCreationTokens?: number;
    };
    timers?: WorkflowTimerExpectation[];
  };
}

interface WorkflowTimerExpectation {
  timerId?: string;
  title?: string;
  status?: "running" | "success" | "failed" | "cleared";
  message?: string;
  minDurationMs?: number;
  metadata?: Record<string, unknown>;
}

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("workspace workflow fixtures", () => {
  it.each(workflowNames)("%s has a dedicated smoke fixture", async (workflowName) => {
    const fixture = await readSmokeFixture(workflowName);

    expect(Array.isArray(fixture.args)).toBe(true);
    expect(fixture.expected.errCode).toEqual(expect.any(Number));
    if (fixture.run === false) {
      expect(fixture.skipReason?.trim()).not.toBe("");
    }
  });
});

describe("workspace workflow structure snapshots", () => {
  it.each(workflowNames)("%s matches its structure snapshot", async (workflowName) => {
    // turns every sample workflow into an owned contract: each sample
    // keeps a fixture and a compact structure snapshot next to its source.
    // The nested workspace resolves its projects explicitly and
    // does not depend on the repository's former workspace/workflow lookup.
    const report = inspectLocalWorkflowStructure({
      workflowDir: workflowDirectory(workflowName),
      workflowName,
    });

    const structure = summarizeStructure(report);
    if (process.env.UPDATE_WORKFLOW_STRUCTURE_SNAPSHOTS === "1") {
      await writeStructureSnapshot(workflowName, structure);
    }

    expect(report.diagnostics.violations).toEqual([]);
    expect(structure).toEqual(await readStructureSnapshot(workflowName));
    expect(Object.values(report.definitions.nodes).some((node) => node.standardName === "output")).toBe(true);
  });
});

describe("workspace workflow offline runtime smoke", () => {
  it.each(workflowNames)("%s runs or is explicitly opted out", async (workflowName) => {
    const fixture = await readSmokeFixture(workflowName);

    if (fixture.run === false) {
      expect(fixture.skipReason?.trim()).not.toBe("");
      return;
    }

    const events: WorkflowRuntimeEvent[] = [];
    const runtimeEventRecorder = createFixtureRuntimeEventRecorder(workflowName);
    const runFixture = async () => runLocalWorkflowWithReport({
      workflowDir: workflowDirectory(workflowName),
      workflowName,
      args: await resolveFixtureArgs(workflowName, fixture.args),
      env: createFixtureEnv(workflowName),
      conversationId: fixture.conversationId,
      storage: await createFixtureStorage(workflowName),
      providers: {
        llm: createFixtureLLMProvider(workflowName),
      },
      maxNodeExecutions: 80,
      userInput: createFixtureUserInputContext(workflowName),
      onRuntimeEvent(event) {
        events.push(event);
        runtimeEventRecorder?.(event);
      },
    });
    const report = isDeltaforceFixtureWorkflow(workflowName)
      ? await withDeltaforeFixtureFetch(runFixture)
      : await runFixture();

    expect(report.status).toBe(fixture.expected.status ?? "success");
    expect(report.result.ok).toBe(true);
    if (!report.result.ok) {
      return;
    }

    const data = report.result.data as {
      errCode: number;
      errMessage: string;
      output: unknown;
    };
    const outputRequired = fixture.expected.outputRequired ?? true;
    const output = outputRequired ? readOutputObject(data.output) : readOptionalOutputObject(data.output);

    expect(data.errCode).toBe(fixture.expected.errCode);
    expect(data.errMessage).toBe(resolveExpectedRunText(fixture.expected.errMessage ?? "", report));
    if (outputRequired) {
      expect(output.errCode).toBe(fixture.expected.errCode);
      expect(output.errMessage).toBe(resolveExpectedRunText(fixture.expected.errMessage ?? "", report));
    }

    for (const [key, value] of Object.entries(fixture.expected.output ?? {})) {
      expect(output[key]).toEqual(value);
    }

    const outputItems = outputRequired ? readOutputItems(output) : [];

    if (fixture.expected.itemCount !== undefined) {
      expect(outputItems).toHaveLength(fixture.expected.itemCount);
    }

    if (fixture.expected.item !== undefined) {
      const firstItem = outputItems[0];
      expect(firstItem).toBeDefined();
      for (const [key, value] of Object.entries(fixture.expected.item)) {
        expect(firstItem?.[key]).toEqual(value);
      }
    }

    for (const [index, expectedItem] of (fixture.expected.items ?? []).entries()) {
      expectOutputItem(outputItems, expectedItem, index);
    }

    const outputContent = outputRequired ? readOutputContent(output) : "";
    for (const expectedContent of fixture.expected.contentIncludes ?? []) {
      expect(outputContent).toContain(expectedContent);
    }
    if (outputRequired) {
      // The App keeps live stream items while the final report is
      // arriving. Every workspace sample must therefore make streamed output
      // item ids line up with final report items when the content is the same.
      expectMergedRuntimeItemsToAvoidDuplicateContent(events, outputItems);
    }
    if (isDeltaforceFixtureWorkflow(workflowName)) {
      expect(outputContent).not.toContain("\"decision\":\"final_answer\"");
      expect(outputContent).not.toContain("\"phase\":\"final_answer\"");
      expect(outputContent).not.toContain("\"phase\":\"action\"");
      expect(outputContent).not.toContain("\"finalAnswer\"");
      expect(outputContent).not.toContain("查询目标");
      expect(outputContent).not.toContain("数据结论");
    }

    for (const nodeName of fixture.expected.nodes ?? []) {
      expect(report.nodes.some((node) => node.name === nodeName)).toBe(true);
    }

    if (fixture.expected.outputCount !== undefined) {
      expect(report.outputs).toHaveLength(fixture.expected.outputCount);
    }

    if (fixture.expected.conversationMessages !== undefined) {
      expect(output.historyLength ?? output.conversationMessages).toBe(fixture.expected.conversationMessages);
    }

    if (fixture.expected.tokenUsage !== undefined) {
      expect(report.tokenUsage?.enabled).toBe(fixture.expected.tokenUsage.enabled ?? true);
      expect(report.tokenUsage?.display).toBe(fixture.expected.tokenUsage.display ?? true);
      expect(report.tokenUsage?.run.totalTokens).toBeGreaterThan(0);
      if (fixture.expected.tokenUsage.calls !== undefined) {
        expect(report.tokenUsage?.run.calls).toBe(fixture.expected.tokenUsage.calls);
      }
      if (fixture.expected.tokenUsage.inputTokens !== undefined) {
        expect(report.tokenUsage?.run.inputTokens).toBe(fixture.expected.tokenUsage.inputTokens);
      }
      if (fixture.expected.tokenUsage.outputTokens !== undefined) {
        expect(report.tokenUsage?.run.outputTokens).toBe(fixture.expected.tokenUsage.outputTokens);
      }
      if (fixture.expected.tokenUsage.totalTokens !== undefined) {
        expect(report.tokenUsage?.run.totalTokens).toBe(fixture.expected.tokenUsage.totalTokens);
      }
      if (fixture.expected.tokenUsage.cachedInputTokens !== undefined) {
        expect(report.tokenUsage?.run.cachedInputTokens).toBe(fixture.expected.tokenUsage.cachedInputTokens);
      }
      if (fixture.expected.tokenUsage.cacheCreationTokens !== undefined) {
        expect(report.tokenUsage?.run.cacheCreationTokens).toBe(fixture.expected.tokenUsage.cacheCreationTokens);
      }
    } else {
      expect(report.tokenUsage).toBeUndefined();
    }

    if (fixture.expected.timers !== undefined) {
      // Workspace timer fixtures assert the final report contract used
      // by App, Embed, and server/web replay instead of only checking node output.
      expect(report.timers).toHaveLength(fixture.expected.timers.length);
      for (const [index, expectedTimer] of fixture.expected.timers.entries()) {
        expectTimerRecord(report.timers?.[index], expectedTimer, index);
      }
      expect(report.timers?.some((timer) => timer.status === "running")).toBe(false);
    } else {
      expect(report.timers ?? []).toHaveLength(0);
    }
  });
});

describe("conversation knowledge persistence", () => {
  it("writes a conversation transcript into PersistentValue-backed knowledge documents", async () => {
    const persistentValueStore = createMemoryKVStore();
    const report = await runLocalWorkflowWithReport({
      workflowDir: workflowDirectory("conversation-knowledge"),
      workflowName: "conversation-knowledge",
      args: ["--message", "记录真实写入", "--title", "Persistent Conversation"],
      conversationId: "persistent-conversation-thread",
      storage: {
        host: "local",
        local: {
          kvStoreDir: await createTempDir("conversation-knowledge-real-kv-"),
          persistentValueStore,
        },
      },
      maxNodeExecutions: 20,
    });

    expect(report.status).toBe("success");
    expect(report.result.ok).toBe(true);
    if (!report.result.ok) {
      return;
    }

    const output = readOutputObject((report.result.data as { output: unknown }).output);
    const documentId = String(output.documentId);
    const projectStoragePrefix = "persistent_value:project:2162c99c-4e8a-4ef6-9ba0-e368d36bf198:";
    const index = persistentValueStore.values.get(`${projectStoragePrefix}:knowledge.documents`);
    const headPageId = (index as { headPageId?: unknown })?.headPageId;
    const page = typeof headPageId === "string"
      ? persistentValueStore.values.get(`${projectStoragePrefix}:knowledge.documents.page.${headPageId}`)
      : undefined;
    const locator = persistentValueStore.values.get(
      `${projectStoragePrefix}:knowledge.documents.locator.${documentId}`,
    );
    const document = persistentValueStore.values.get(`${projectStoragePrefix}:knowledge.document.${documentId}`);

    // Verifies the real non-dry-run path writes the conversation transcript
    // through the injected PersistentValue store and bounded v2 index records.
    expect(output.knowledgeWritten).toBe(true);
    expect(index).toMatchObject({
      version: 2,
      total: 1,
      nextSequence: 1,
      headPageId: expect.any(String),
    });
    expect(page).toMatchObject({
      version: 2,
      entries: [expect.objectContaining({
        sequence: 1,
        summary: expect.objectContaining({ id: documentId, title: "Persistent Conversation" }),
      })],
    });
    expect(locator).toMatchObject({
      version: 2,
      pageId: headPageId,
      sequence: 1,
    });
    expect(document).toMatchObject({
      id: documentId,
      title: "Persistent Conversation",
      markdown: expect.stringContaining("记录真实写入"),
    });
    expect(String((document as { markdown?: unknown }).markdown)).toContain("已记录到知识库文档: 记录真实写入");
  });
});

describe("workspace workflow human input resume", () => {
  it("human-input pauses for network permission, then resumes the same run", async () => {
    const args: string[] = [];
    const events: WorkflowRuntimeEvent[] = [];

    const waitingReport = await runLocalWorkflowWithReport({
      workflowDir: workflowDirectory("human-input"),
      workflowName: "human-input",
      args,
      runId: "human-input-fixture-run",
      userInput: createFixtureUserInputContext("human-input"),
      onRuntimeEvent(event) {
        events.push(event);
      },
    });

    expect(waitingReport.status).toBe("waiting_for_input");
    expect(waitingReport.pendingUserInput?.requestId).toBe("human-input:human-input-fixture-run:network-permission");
    expect(waitingReport.pendingUserInput?.params.map((param) => param.name)).toEqual([
      "allowed",
    ]);
    expect(readReportOutputContent(waitingReport)).toContain("下面需要请求网络访问权限，请你同意开启");
    expectPlainTextOutputItem(readReportOutputItems(waitingReport)[0], "下面需要请求网络访问权限，请你同意开启");
    expect(events.some((event) => event.type === "user_input_requested")).toBe(true);

    const submittedAt = new Date("2026-06-04T10:30:00.000Z");
    const resumedEvents: WorkflowRuntimeEvent[] = [];
    const resumedReport = await resumeHumanInputWorkflow({
      args,
      runId: waitingReport.runId,
      requestId: waitingReport.pendingUserInput?.requestId ?? "",
      allowed: true,
      submittedAt,
      onRuntimeEvent(event) {
        resumedEvents.push(event);
      },
    });

    expect(resumedReport.runId).toBe(waitingReport.runId);
    expect(resumedReport.status).toBe("success");
    expect(resumedReport.pendingUserInput).toBeUndefined();
    expect(resumedReport.resolvedUserInputs).toEqual([{
      requestId: "human-input:human-input-fixture-run:network-permission",
      nodeName: "network-permission",
      values: {
        allowed: true,
      },
      submittedAt,
      request: expect.objectContaining({
        requestId: "human-input:human-input-fixture-run:network-permission",
        nodeName: "network-permission",
        title: "请求网络访问权限",
        params: expect.arrayContaining([
          expect.objectContaining({ name: "allowed", type: "boolean" }),
        ]),
      }),
    }]);
    expect(resumedEvents.some((event) => event.type === "user_input_resolved")).toBe(true);
    expect(resumedReport.result.ok).toBe(true);
    if (!resumedReport.result.ok) {
      return;
    }

    const data = resumedReport.result.data as {
      errCode: number;
      errMessage: string;
      output: unknown;
    };
    const output = readOutputObject(data.output);
    expect(data.errCode).toBe(0);
    expect(data.errMessage).toBe("");
    expect(output.allowed).toBe(true);
    expect(output.message).toBe("成功获取权限");
    expect(readOutputContent(output)).toContain("成功获取权限");
    const outputItems = readOutputItems(output);
    expectPlainTextOutputItem(outputItems[outputItems.length - 1], "成功获取权限");

    const deniedReport = await resumeHumanInputWorkflow({
      args,
      runId: waitingReport.runId,
      requestId: waitingReport.pendingUserInput?.requestId ?? "",
      allowed: false,
      submittedAt,
    });
    expect(deniedReport.status).toBe("success");
    expect(deniedReport.result.ok).toBe(true);
    if (!deniedReport.result.ok) {
      return;
    }

    const deniedData = deniedReport.result.data as {
      errCode: number;
      errMessage: string;
      output: unknown;
    };
    const deniedOutput = readOutputObject(deniedData.output);
    expect(deniedData.errCode).toBe(0);
    expect(deniedOutput.allowed).toBe(false);
    expect(deniedOutput.message).toBe("获取权限失败");
    expect(readOutputContent(deniedOutput)).toContain("获取权限失败");
    const deniedOutputItems = readOutputItems(deniedOutput);
    expectPlainTextOutputItem(deniedOutputItems[deniedOutputItems.length - 1], "获取权限失败");
  });
});

describe("workspace workflow output-showcase resume", () => {
  // output-showcase 的离线 smoke 路径因为有 user input 节点而无法跑通,
  // 这里直接覆盖 paused / confirmed / skipped 三个状态。
  it("pauses for run-confirmation, then resumes the long-task and skipped branches", async () => {
    const args = [
      "--project-name",
      "output-showcase-fixture",
      "--tool-delay-ms",
      "20",
      "--task-duration-ms",
      "20",
      "--stream-delay-ms",
      "1",
    ];
    const waitingEvents: WorkflowRuntimeEvent[] = [];
    const waitingReport = await runLocalWorkflowWithReport({
      workflowDir: workflowDirectory("output-showcase"),
      workflowName: "output-showcase",
      args,
      runId: "output-showcase-fixture-run",
      userInput: createFixtureUserInputContext("output-showcase"),
      onRuntimeEvent(event) {
        waitingEvents.push(event);
      },
    });

    expect(waitingReport.status).toBe("waiting_for_input");
    expect(waitingReport.pendingUserInput?.requestId).toBe(
      "output-showcase:output-showcase-fixture-run:run-confirmation",
    );
    expect(waitingReport.pendingUserInput?.params.map((param) => param.name)).toEqual(["decision"]);
    // paused report 应当已经流式输出了 intro + tool result, 但不进入计时分支。
    expect(readReportOutputContent(waitingReport)).toContain("这是一个专门用于展示");
    expect(readReportOutputContent(waitingReport)).toContain("工具调用成功");
    expect(readReportOutputContent(waitingReport)).toContain("下面会展示一个用户确认选项");
    expect(readReportOutputContent(waitingReport)).not.toContain("任务结束");
    expect(readReportOutputContent(waitingReport)).not.toContain("已跳过");
    // 验证 intro + tool-output 节点确实在等用户确认之前就流式 emit 了
    // start / delta / end chunks, 而不是只在结束时整块提交。
    expectStreamingChunksForNodes(waitingEvents, ["intro-output", "tool-output", "post-tool-output"]);
    expectOutputNodeStreamedSlowText(waitingEvents, "intro-output");
    expectToolOutputStatusTransition(waitingEvents);
    // paused 阶段不应该有计时 / 长任务分支相关的 chunk。
    expect(waitingEvents.some((event) => {
      if (event.type !== "node_started") return false;
      const meta = (event as { metadata?: { title?: string } }).metadata;
      return meta?.title === "pre-task-output" || meta?.title === "long-task-timer";
    })).toBe(false);

    const submittedAt = new Date("2026-06-10T12:00:00.000Z");
    const longTaskEvents: WorkflowRuntimeEvent[] = [];
    const longTaskReport = await resumeOutputShowcaseWorkflow({
      args,
      runId: waitingReport.runId,
      requestId: waitingReport.pendingUserInput?.requestId ?? "",
      confirmed: true,
      submittedAt,
      onRuntimeEvent(event) {
        longTaskEvents.push(event);
      },
    });
    expect(longTaskReport.status).toBe("success");
    expect(longTaskReport.pendingUserInput).toBeUndefined();
    expect(longTaskReport.result.ok).toBe(true);
    if (!longTaskReport.result.ok) {
      return;
    }

    const longTaskData = longTaskReport.result.data as {
      errCode: number;
      errMessage: string;
      output: unknown;
    };
    const longTaskOutput = readOutputObject(longTaskData.output);
    expect(longTaskData.errCode).toBe(0);
    expect(longTaskData.errMessage).toBe("");
    expect(longTaskOutput.confirmed).toBe(true);
    expect(longTaskOutput.longTaskTimerId).toBe("output-showcase-long-task");
    expect(longTaskOutput.projectName).toBe("output-showcase-fixture");
    expect(isRecord(longTaskOutput.pageSnapshot)).toBe(true);
    const longTaskItems = readOutputItems(longTaskOutput);
    // 非工具输出用 title="Output" 走 inline 平铺,避免被 App 包进 <details>。
    expect(longTaskItems[longTaskItems.length - 1]?.title).toBe("Output");
    expect(longTaskItems[longTaskItems.length - 1]?.id).toBe("output-showcase-raw-json");
    expect(readOutputContent(longTaskOutput)).toContain("长任务执行完毕");
    expect(readOutputContent(longTaskOutput)).toContain("工具摘要");
    expect(readOutputContent(longTaskOutput)).toContain("当前页面全部展示内容组成的原始 JSON");
    expect(readOutputContent(longTaskOutput)).toContain("\"workflowName\": \"output-showcase\"");
    expect(readOutputContent(longTaskOutput)).toContain("\"confirmed\": true");
    expect(longTaskItems.some((item) =>
      item.id === "output-showcase-finished" &&
      stringifyOutputItemContent(item.content).includes("计时 ID"),
    )).toBe(true);
    // 长任务分支所有 4 个 output 节点都应当已经流式 emit 过 chunks。
    expectStreamingChunksForNodes(longTaskEvents, [
      "pre-task-output",
      "finished-output",
    ]);
    expect(longTaskEvents.some((event) => {
      if (event.type !== "node_chunk") return false;
      const meta = (event as { metadata?: { title?: string } }).metadata;
      return meta?.title === "intro-output" ||
        meta?.title === "tool-output" ||
        meta?.title === "post-tool-output";
    })).toBe(false);
    // timer should be success status with a non-trivial duration
    expect(longTaskReport.timers).toHaveLength(1);
    expect(longTaskReport.timers?.[0]?.status).toBe("success");
    expect(longTaskReport.timers?.[0]?.message).toBe("业务阶段已显式结束");
    expect(longTaskReport.timers?.[0]?.durationMs).toBeGreaterThanOrEqual(15);

    const skippedEvents: WorkflowRuntimeEvent[] = [];
    const skippedReport = await resumeOutputShowcaseWorkflow({
      args,
      runId: waitingReport.runId,
      requestId: waitingReport.pendingUserInput?.requestId ?? "",
      confirmed: false,
      submittedAt,
      onRuntimeEvent(event) {
        skippedEvents.push(event);
      },
    });
    expect(skippedReport.status).toBe("success");
    expect(skippedReport.result.ok).toBe(true);
    if (!skippedReport.result.ok) {
      return;
    }

    const skippedData = skippedReport.result.data as {
      errCode: number;
      errMessage: string;
      output: unknown;
    };
    const skippedOutput = readOutputObject(skippedData.output);
    expect(skippedData.errCode).toBe(0);
    expect(skippedOutput.confirmed).toBe(false);
    expect(skippedOutput.longTaskTimerId).toBe("");
    expect(isRecord(skippedOutput.pageSnapshot)).toBe(true);
    const skippedItems = readOutputItems(skippedOutput);
    expect(skippedItems[skippedItems.length - 1]?.title).toBe("Output");
    expect(skippedItems[skippedItems.length - 1]?.id).toBe("output-showcase-raw-json");
    expect(readOutputContent(skippedOutput)).toContain("你选择了不执行长任务");
    expect(readOutputContent(skippedOutput)).toContain("当前页面全部展示内容组成的原始 JSON");
    expect(readOutputContent(skippedOutput)).toContain("\"confirmed\": false");
    // 跳过分支不进入计时任务,只流式 emit skipped-output。
    expectStreamingChunksForNodes(skippedEvents, ["skipped-output"]);
    expect(skippedEvents.some((event) => {
      if (event.type !== "node_chunk") return false;
      const meta = (event as { metadata?: { title?: string } }).metadata;
      return meta?.title === "intro-output" ||
        meta?.title === "tool-output" ||
        meta?.title === "post-tool-output";
    })).toBe(false);
    expect(skippedEvents.some((event) => {
      if (event.type !== "node_started") return false;
      const meta = (event as { metadata?: { title?: string } }).metadata;
      return meta?.title === "pre-task-output";
    })).toBe(false);
    expect(skippedReport.timers ?? []).toHaveLength(0);
  });

  it("interrupts the simulated tool wait as soon as the run is cancelled", async () => {
    const controller = new AbortController();
    const events: WorkflowRuntimeEvent[] = [];
    let abortedDuringTool = false;
    const reportPromise = runLocalWorkflowWithReport({
      workflowDir: workflowDirectory("output-showcase"),
      workflowName: "output-showcase",
      args: [
        "--tool-delay-ms",
        "6000",
        "--stream-delay-ms",
        "0",
      ],
      abortSignal: controller.signal,
      userInput: createFixtureUserInputContext("output-showcase"),
      onRuntimeEvent(event) {
        events.push(event);
        const metadata = (event as { metadata?: { title?: string } }).metadata;
        if (event.type === "node_chunk" && metadata?.title === "tool-output" && !controller.signal.aborted) {
          abortedDuringTool = true;
          controller.abort(new Error("Cancelled from the output showcase test."));
        }
      },
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const report = await Promise.race([
        reportPromise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Timed out waiting for tool cancellation.")), 750);
        }),
      ]);

      expect(abortedDuringTool).toBe(true);
      expect(report.status).toBe("aborted");
      expect(events.some((event) => event.type === "workflow_aborted")).toBe(true);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  });
});

function resumeHumanInputWorkflow(options: {
  args: string[];
  runId: string;
  requestId: string;
  allowed: boolean;
  submittedAt: Date;
  onRuntimeEvent?(event: WorkflowRuntimeEvent): void;
}) {
  const requestId = options.requestId;
  return runLocalWorkflowWithReport({
    workflowDir: workflowDirectory("human-input"),
    workflowName: "human-input",
    args: options.args,
    runId: options.runId,
    userInput: {
      __workflowResumeRuntimeEventAfterRequestId: requestId,
      getResolvedInput(requestId) {
        if (requestId !== options.requestId) {
          return undefined;
        }
        return {
          requestId,
          nodeName: "network-permission",
          values: {
            allowed: options.allowed,
          },
          submittedAt: options.submittedAt,
        };
      },
      requestInput() {
        throw new Error("requestInput should not run after the fixture answer is resolved.");
      },
    },
    onRuntimeEvent: options.onRuntimeEvent,
  });
}

function resumeOutputShowcaseWorkflow(options: {
  args: string[];
  runId: string;
  requestId: string;
  confirmed: boolean;
  submittedAt: Date;
  onRuntimeEvent?(event: WorkflowRuntimeEvent): void;
}) {
  const requestId = options.requestId;
  return runLocalWorkflowWithReport({
    workflowDir: workflowDirectory("output-showcase"),
    workflowName: "output-showcase",
    args: options.args,
    runId: options.runId,
    userInput: {
      __workflowResumeRuntimeEventAfterRequestId: requestId,
      getResolvedInput(requestId) {
        if (requestId !== options.requestId) {
          return undefined;
        }
        // The wire form of the confirmation node is a radio whose
        // `decision` value is "enter" or "skip"; the workflow normalizes
        // it back to a `confirmed` boolean internally.
        return {
          requestId,
          nodeName: "run-confirmation",
          values: {
            decision: options.confirmed ? "enter" : "skip",
          },
          submittedAt: options.submittedAt,
        };
      },
      requestInput() {
        throw new Error("requestInput should not run after the fixture answer is resolved.");
      },
    },
    onRuntimeEvent: options.onRuntimeEvent,
  });
}

function expectStreamingChunksForNodes(events: WorkflowRuntimeEvent[], configuredNames: string[]): void {
  for (const configuredName of configuredNames) {
    // runtime events 的 nodeName 是 standard name (output / user-input / timer),
    // 真正能区分节点的是 metadata.title,这里就是 workflow.createOutputNode
    // 配的 name。
    const chunks = events.filter((event) => {
      if (event.type !== "node_chunk") return false;
      const meta = (event as { metadata?: { title?: string } }).metadata;
      return meta?.title === configuredName;
    });
    expect(chunks.length, `node_chunk events for ${configuredName}`).toBeGreaterThan(0);
    const startChunk = chunks.find((event) => isOutputItemStartChunk((event as { chunk?: unknown }).chunk));
    expect(startChunk, `output_item_start chunk for ${configuredName}`).toBeDefined();
    const deltaChunk = chunks.find((event) => {
      const chunk = (event as { chunk?: unknown }).chunk;
      return isRecord(chunk) && chunk.type === "output_item_delta";
    });
    expect(deltaChunk, `output_item_delta chunk for ${configuredName}`).toBeDefined();
    const endChunk = chunks.find((event) => {
      const chunk = (event as { chunk?: unknown }).chunk;
      return isRecord(chunk) && chunk.type === "output_item_end";
    });
    expect(endChunk, `output_item_end chunk for ${configuredName}`).toBeDefined();
  }
}

function expectOutputNodeStreamedSlowText(events: WorkflowRuntimeEvent[], configuredName: string): void {
  const chunks = events.filter((event) => {
    if (event.type !== "node_chunk") return false;
    const meta = (event as { metadata?: { title?: string } }).metadata;
    if (meta?.title !== configuredName) return false;
    const chunk = (event as { chunk?: unknown }).chunk;
    return isRecord(chunk) && chunk.type === "output_item_delta" && typeof chunk.delta === "string";
  });

  expect(chunks.length, `delta chunk count for ${configuredName}`).toBeGreaterThan(2);
  const combined = chunks
    .map((event) => String((event as { chunk: { delta: unknown } }).chunk.delta))
    .join("");
  expect(combined.length).toBeGreaterThan(20);
}

function expectToolOutputStatusTransition(events: WorkflowRuntimeEvent[]): void {
  const toolChunks = events.filter((event) => {
    if (event.type !== "node_chunk") return false;
    const meta = (event as { metadata?: { title?: string } }).metadata;
    return meta?.title === "tool-output";
  });

  const startChunk = toolChunks.find((event) => isOutputItemStartChunk((event as { chunk?: unknown }).chunk));
  expect(startChunk).toBeDefined();
  const startItem = startChunk && isOutputItemStartChunk((startChunk as { chunk?: unknown }).chunk)
    ? (startChunk as { chunk: { item: Record<string, unknown> } }).chunk.item
    : undefined;
  expect(startItem?.title).toBe("工具调用中");
  expect(startItem?.iconPreset).toBe("warning");
  expect(isRecord(startItem?.metadata) ? startItem.metadata.status : undefined).toBe("running");

  const successPatch = toolChunks.find((event) => {
    const chunk = (event as { chunk?: unknown }).chunk;
    return isRecord(chunk) &&
      chunk.type === "output_item_delta" &&
      isRecord(chunk.item) &&
      chunk.item.title === "工具调用成功";
  });
  expect(successPatch).toBeDefined();
  const successItem = successPatch && isRecord((successPatch as { chunk?: unknown }).chunk)
    ? (((successPatch as { chunk: { item?: Record<string, unknown> } }).chunk.item) ?? undefined)
    : undefined;
  expect(successItem?.iconPreset).toBe("success");
  expect(isRecord(successItem?.metadata) ? successItem.metadata.status : undefined).toBe("success");
}

function createFixtureRuntimeEventRecorder(workflowName: WorkflowName) {
  if (workflowName !== "deltaforce-openai-agent") {
    return undefined;
  }

  const outputItemIds: string[] = [];
  let nestedOutputStartedBeforeNestedWorkflowFinished = false;

  return (event: WorkflowRuntimeEvent) => {
    if (event.type === "workflow_succeeded") {
      expect(outputItemIds).toContain("openai-agents-tool-1-get_api_guns");
      expect(outputItemIds).toContain("openai-agents-answer");
      expect(outputItemIds.indexOf("openai-agents-tool-1-get_api_guns")).toBeLessThan(outputItemIds.indexOf("openai-agents-answer"));
      expect(nestedOutputStartedBeforeNestedWorkflowFinished).toBe(true);
      return;
    }
    if (event.type === "node_finished" && event.nodeName === "run-workflow") {
      expect(outputItemIds).toContain("openai-agents-tool-1-get_api_guns");
      expect(outputItemIds).toContain("openai-agents-answer");
      expect(outputItemIds.indexOf("openai-agents-tool-1-get_api_guns")).toBeLessThan(outputItemIds.indexOf("openai-agents-answer"));
      nestedOutputStartedBeforeNestedWorkflowFinished = true;
      return;
    }
    if (event.type !== "node_chunk" || !isOutputItemStartChunk(event.chunk)) {
      return;
    }

    outputItemIds.push(event.chunk.item.id ?? "");
  };
}

function createMemoryKVStore(): WorkflowKVStore & {
  values: Map<string, unknown>;
} {
  const values = new Map<string, unknown>();
  const namespaceTails = new Map<string, Promise<void>>();
  function createKey(input: {
    storageKind: string;
    scope: string;
    projectId: string;
    conversationId?: string;
    key: string;
  }): string {
    return [input.storageKind, input.scope, input.projectId, input.conversationId ?? "", input.key].join(":");
  }

  return {
    values,
    async getValue(input) {
      return values.get(createKey(input));
    },
    async setValue(input) {
      values.set(createKey(input), input.value);
    },
    async updateValue(input, updater) {
      const key = createKey(input);
      const next = updater(values.get(key));
      values.set(key, next);
      return next;
    },
    async withNamespaceLock(input, operation) {
      const namespace = [input.storageKind, input.scope, input.projectId, input.conversationId ?? ""].join(":");
      const previous = namespaceTails.get(namespace) ?? Promise.resolve();
      let release!: () => void;
      const completion = new Promise<void>((resolve) => {
        release = resolve;
      });
      namespaceTails.set(namespace, completion);
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
}

function summarizeStructure(report: WorkflowStructureReport) {
  // keep structure snapshots stable across Windows and POSIX hosts.
  const workflowFiles = report.workflow.files.map((file) => file.replaceAll("\\", "/"));

  const summary = {
    workflowName: report.workflow.name,
    projectType: report.projectType,
    files: workflowFiles.filter((file) => !file.includes("/__fixtures__/") && !file.includes("/__snapshots__/")),
    nodes: Object.values(report.definitions.nodes).map((node) => ({
      id: node.id,
      factory: node.factory,
      standardName: node.standardName,
      configuredName: node.configuredName,
    })),
  };

  if (report.projectType === "workflow") {
    return {
      ...summary,
      defaultEntrypoint: report.defaultEntrypoint,
      entrypoints: (report.entrypoints ?? []).map((entrypoint) => ({
        id: entrypoint.id,
        title: entrypoint.title,
        ...dropUndefined({
          description: entrypoint.description,
          workflowName: entrypoint.workflowName,
          paramResolver: entrypoint.paramResolver,
          tools: entrypoint.tools,
          tokenUsage: entrypoint.tokenUsage,
        }),
        params: summarizeParams(entrypoint.params),
        registry: summarizeRegistry(entrypoint.registry),
        execution: summarizeExecution(entrypoint.execution),
      })),
    };
  }

  return {
    ...summary,
    // drop `undefined` values: structure snapshots are stored in
    // JSON files which have no representation for `undefined`, so the
    // snapshot reader always parses them as missing keys. `toEqual`
    // counts explicit `undefined` keys as differences and would otherwise
    // fail every time a new optional field lands in the report.
    params: summarizeParams(report.params),
    ...dropUndefined({
      conversation: report.conversation,
      tokenUsage: report.tokenUsage,
    }),
    registry: summarizeRegistry(report.registry),
    execution: summarizeExecution(report.execution!),
  };
}

function summarizeParams(params: WorkflowStructureReport["params"]) {
  return (params ?? []).map((param) => dropUndefined({
    name: param.name,
    flag: param.flag,
    shortFlag: param.shortFlag,
    type: param.type,
    required: param.required,
    defaultValue: param.defaultValue,
    control: param.control,
    multiple: param.multiple,
    format: param.format,
    panel: param.panel,
  }));
}

function summarizeRegistry(registry: WorkflowStructureReport["registry"]) {
  return (registry ?? []).map((entry) => ({
    name: entry.name,
    type: entry.metadata.type,
    title: entry.metadata.title,
    version: entry.metadata.version,
  }));
}

function dropUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      (result as Record<string, unknown>)[key] = item;
    }
  }
  return result;
}

function summarizeExecution(execution: WorkflowStructureExecution) {
  const state = {
    kind: execution.kind,
    counts: {} as Record<string, number>,
    callees: [] as string[],
    branchLabels: [] as string[],
    loopLabels: [] as string[],
  };

  walkExecution(execution, state);

  return {
    kind: state.kind,
    counts: state.counts,
    callees: Array.from(new Set(state.callees)),
    branchLabels: Array.from(new Set(state.branchLabels)),
    loopLabels: Array.from(new Set(state.loopLabels)),
  };
}

function walkExecution(
  item:
    | WorkflowStructureExecution
    | WorkflowStructureExecutionItem
    | WorkflowStructureExecutionBranchPath,
  state: {
    counts: Record<string, number>;
    callees: string[];
    branchLabels: string[];
    loopLabels: string[];
  },
): void {
  const kind = item.kind;
  state.counts[kind] = (state.counts[kind] ?? 0) + 1;

  if (isExecutionNode(item)) {
    state.callees.push(item.callee);
  }

  if (isExecutionLoop(item) && item.label !== undefined) {
    state.loopLabels.push(item.label);
  } else if (isExecutionBranchPath(item) && item.label !== undefined) {
    state.branchLabels.push(item.label);
  }

  if (isExecutionBranch(item)) {
    for (const branch of item.branches) {
      walkExecution(branch, state);
    }
  }

  for (const child of readExecutionChildren(item)) {
    walkExecution(child, state);
  }
}

async function readSmokeFixture(workflowName: WorkflowName): Promise<WorkflowSmokeFixture> {
  return JSON.parse(await readWorkflowFile(workflowName, "__fixtures__/smoke.json")) as WorkflowSmokeFixture;
}

async function createFixtureStorage(
  workflowName: WorkflowName,
): Promise<WorkflowExecutionStorageOptions> {
  const packageJson = JSON.parse(await readWorkflowFile(workflowName, "package.json")) as {
    workflowCode?: { projectInfo?: { dataStorage?: { mode?: unknown } } };
  };
  const mode = packageJson.workflowCode?.projectInfo?.dataStorage?.mode;
  if (mode === "server") {
    return {
      host: "server",
      server: { kvStore: createMemoryKVStore() },
    };
  }
  return {
    host: "local",
    local: { kvStoreDir: await createTempDir(`${workflowName}-kv-`) },
  };
}

async function readStructureSnapshot(workflowName: WorkflowName) {
  return JSON.parse(await readWorkflowFile(workflowName, "__snapshots__/structure.json")) as unknown;
}

async function writeStructureSnapshot(workflowName: WorkflowName, structure: unknown): Promise<void> {
  await writeFile(
    path.join(workflowDirectory(workflowName), "__snapshots__/structure.json"),
    `${JSON.stringify(structure, null, 2)}\n`,
    "utf8",
  );
}

async function readWorkflowFile(workflowName: WorkflowName, relativePath: string): Promise<string> {
  return readFile(path.join(workflowDirectory(workflowName), relativePath), "utf8");
}

function workflowDirectory(workflowName: string): string {
  return path.join(WORKFLOW_ROOT, workflowName);
}

function resolveExpectedRunText(value: string, report: WorkflowExecutionReport): string {
  return value.replaceAll("{RUN_ID}", report.runId);
}

function createFixtureUserInputContext(workflowName: WorkflowName): WorkflowUserInputContext | undefined {
  if (!isUserInputFixtureWorkflow(workflowName)) {
    return undefined;
  }

  return {
    getResolvedInput() {
      return undefined;
    },
    requestInput(request) {
      throw new WorkflowError({
        type: "user_input_required",
        message: `Workflow "${workflowName}" is waiting for user input "${request.requestId}".`,
        nodeName: request.nodeName,
        metadata: { request },
      });
    },
  };
}

function isUserInputFixtureWorkflow(workflowName: WorkflowName): workflowName is "human-input" | "output-showcase" {
  return workflowName === "human-input" || workflowName === "output-showcase";
}

async function resolveFixtureArgs(workflowName: WorkflowName, args: string[]): Promise<string[]> {
  if (workflowName === "gpt-image") {
    const imagePath = path.join(workflowDirectory("gpt-image"), "__fixtures__", "pixel.png");
    const imageReference: WorkflowFileReference = {
      id: "gpt-image-pixel",
      name: "pixel.png",
      mimeType: "image/png",
      size: 68,
      kind: "image",
      storage: "path",
      path: imagePath,
      createdAt: "2026-06-02T00:00:00.000Z",
    };

    return args.map((arg) => arg === "__GPT_IMAGE_IMAGE_JSON__" ? JSON.stringify([imageReference]) : arg);
  }

  if (workflowName !== "conversation") {
    return args;
  }

  const imagePath = path.join(workflowDirectory("conversation"), "__fixtures__", "pixel.svg");
  const imageReference: WorkflowFileReference = {
    id: "conversation-pixel",
    name: "pixel.svg",
    mimeType: "image/svg+xml",
    size: 116,
    kind: "image",
    storage: "path",
    path: imagePath,
    createdAt: "2026-05-26T00:00:00.000Z",
  };
  const fileReference: WorkflowFileReference = {
    id: "conversation-file",
    name: "pixel.svg",
    mimeType: "application/pdf",
    size: 32,
    kind: "file",
    storage: "path",
    path: imagePath,
    createdAt: "2026-05-26T00:00:00.000Z",
  };

  return args.map((arg) => {
    if (arg === "__CONVERSATION_IMAGE_JSON__") {
      return JSON.stringify([imageReference]);
    }
    if (arg === "__CONVERSATION_FILE_JSON__") {
      return JSON.stringify([fileReference]);
    }
    return arg;
  });
}

function createFixtureLLMProvider(workflowName: WorkflowName): MockLLMProvider {
  let deltaforeThoughtCount = 0;

  return new MockLLMProvider({
    chunkSize: 8,
    text(input) {
      if (input.prompt?.includes("只允许输出 true 或 false")) {
        return "true";
      }
      if (input.prompt?.includes("uniapp-x") || input.prompt?.includes("uni-app x")) {
        return "uni-app x";
      }
      if (workflowName === "deltafore-agent") {
        if (input.prompt?.includes("请按 ReAct 协议决定下一步")) {
          deltaforeThoughtCount += 1;
          if (deltaforeThoughtCount === 1) {
            return JSON.stringify({
              phase: "action",
              thought: {
                summary: "先查询 M7 的线上枪械条目，确认 objectId 和关键字段。",
                hypothesis: "用户说的 M7 应该是 M7 战斗步枪。",
                evidenceGap: "还缺准确 objectId。",
                nextActionReason: "枪械列表能快速确认候选项。",
              },
              action: {
                toolName: "get_api_guns",
                args: {
                  q: "M7",
                  limit: 3,
                },
              },
            });
          }
        }

        if (input.prompt?.includes("请写一段自然的工作状态更新")) {
          return "我先把 M7 的枪械条目对上号，拿到准确的 objectId 后再继续看它能怎么改。";
        }

        if (input.prompt?.includes("请写一段自然的工具后状态更新")) {
          return "已经确认命中的是 M7 战斗步枪，列表里同时混进了 M700；后面会围绕 M7 的 objectId 继续判断。";
        }

        return JSON.stringify({
          phase: "final_answer",
          thought: {
            summary: "已经拿到 M7 的线上条目，可以基于观察给出离线 mock 推荐。",
          },
          finalAnswer: [
            "**离线 mock 推荐**",
            "",
            "- 武器：M7",
            "- 重点：推荐高操控 M7 配置，优先稳定后坐力。",
          ].join("\n"),
          confidence: "high",
          usedObjectIDs: [],
        });
      }
      if (workflowName === "conversation" && Array.isArray(input.messages)) {
        return `离线回复:${readLastUserText(input)}`;
      }
      return `离线 mock ${workflowName}: ${readPromptPreview(input)}`;
    },
  });
}

function createFixtureEnv(workflowName: WorkflowName): NodeJS.ProcessEnv | undefined {
  if (workflowName === "gpt-image") {
    return {
      ...process.env,
      GPT_IMAGE_MOCK: "1",
      GPT_IMAGE_MOCK_B64: "Z3B0LWltYWdlLWZpeHR1cmU=",
    };
  }

  if (!isDeltaforceFixtureWorkflow(workflowName)) {
    return undefined;
  }

  return {
    ...process.env,
    DELTAFORE_OPENAPI_URL: "http://hookcode.win:7222/openapi.json",
    DELTAFORE_API_BASE_URL: "http://hookcode.win:7222",
    OPENAI_API_KEY: "fixture-openai-key",
    ...(workflowName === "deltaforce-openai-agent" ? { DELTAFORCE_OPENAI_AGENT_MOCK: "1" } : {}),
  };
}

function isDeltaforceFixtureWorkflow(workflowName: WorkflowName): workflowName is "deltafore-agent" | "deltaforce-openai-agent" {
  return workflowName === "deltafore-agent" || workflowName === "deltaforce-openai-agent";
}

async function withDeltaforeFixtureFetch<T>(run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createDeltaforeFixtureFetch() as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function createDeltaforeFixtureFetch(): typeof fetch {
  const openApiDocument = {
    openapi: "3.1.0",
    info: {
      title: "三角洲数据库 API",
      version: "0.1.0",
    },
    servers: [
      {
        url: "http://hookcode.win:7222",
      },
    ],
    components: {
      parameters: {
        Limit: {
          name: "limit",
          in: "query",
          schema: {
            type: "integer",
            default: 50,
            minimum: 1,
            maximum: 200,
          },
        },
        Search: {
          name: "q",
          in: "query",
          schema: {
            type: "string",
          },
        },
        ObjectId: {
          name: "objectId",
          in: "path",
          required: true,
          schema: {
            type: "integer",
            format: "int64",
          },
        },
        DryRun: {
          name: "dryRun",
          in: "query",
          schema: {
            type: "boolean",
            default: false,
          },
        },
      },
    },
    paths: {
      "/api/guns": {
        get: {
          summary: "查询枪械列表",
          tags: ["枪械"],
          parameters: [
            { $ref: "#/components/parameters/Limit" },
            { $ref: "#/components/parameters/Search" },
          ],
        },
      },
      "/api/guns/{objectId}/attachment-options": {
        get: {
          summary: "查询枪械可用配件候选明细",
          tags: ["枪械"],
          parameters: [
            { $ref: "#/components/parameters/ObjectId" },
            {
              name: "scope",
              in: "query",
              schema: {
                type: "string",
                enum: ["accessory", "allAccessory"],
              },
            },
            {
              name: "includeEffects",
              in: "query",
              schema: {
                type: "boolean",
                default: true,
              },
            },
            {
              name: "limitPerSlot",
              in: "query",
              schema: {
                type: "integer",
                default: 200,
                minimum: 1,
                maximum: 500,
              },
            },
          ],
        },
      },
      "/api/sync/object-list": {
        post: {
          summary: "从远程物品列表全量同步数据库",
          tags: ["数据同步"],
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: {
                type: "integer",
                default: 2000,
                minimum: 1,
                maximum: 2000,
              },
            },
            { $ref: "#/components/parameters/DryRun" },
          ],
        },
      },
    },
  };
  const objectConfigDocument = {
    data: {
      gunSlots: [
        {
          slotId: "6",
          slotName: "枪口",
          accType: "accMuzzle",
          sortOrder: 1,
        },
        {
          slotId: "5",
          slotName: "弹匣",
          accType: "accMagazine",
          sortOrder: 24,
        },
      ],
      objectMappings: {
        acc: [
          {
            type: "accMuzzle",
            typeName: "枪口",
            sourceOrder: 0,
          },
          {
            type: "accMagazine",
            typeName: "弹匣",
            sourceOrder: 1,
          },
        ],
      },
      exchange: [],
      maps: {},
      keyTypes: [],
    },
  };

  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/openapi.json") {
      return jsonResponse(openApiDocument);
    }
    if (url.pathname === "/api/object-config") {
      return jsonResponse(objectConfigDocument);
    }
    if (url.pathname === "/api/guns") {
      return jsonResponse({
        total: 1,
        data: [
          {
            objectId: 18010000016,
            objectName: "M7 战斗步枪",
            primaryClass: "gun",
            grade: 5,
            avgPrice: 68000,
            gunDetail: {
              controlSpeed: 62,
              recoil: 48,
              stable: 55,
            },
          },
        ],
      });
    }
    if (url.pathname === "/api/guns/18010000016/attachment-options") {
      return jsonResponse({
        data: {
          gun: {
            item: {
              objectId: 18010000016,
              objectName: "M7 战斗步枪",
              primaryClass: "gun",
            },
          },
          slots: [
            {
              slotId: "6",
              slotName: "枪口",
              accType: "accMuzzle",
              optionCount: 1,
              options: [
                {
                  item: {
                    objectId: 13130000182,
                    objectName: "余烬消音器",
                    secondClassCn: "枪口",
                  },
                  attachment: {
                    recoil: 10,
                    control_speed: -4,
                  },
                  effects: [
                    {
                      effectType: "advantage",
                      valueText: "后坐力控制+10",
                    },
                  ],
                },
              ],
            },
          ],
        },
      });
    }

    return jsonResponse({
      error: {
        message: `Unhandled fixture request: ${init?.method ?? "GET"} ${url.pathname}`,
      },
    }, 404);
  }) as typeof fetch;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function readPromptPreview(input: LLMChatInput): string {
  const source = input.prompt ?? readLastUserText(input);
  return source.replace(/\s+/g, " ").slice(0, 48);
}

function readLastUserText(input: LLMChatInput): string {
  const messages = input.messages ?? [];
  const user = [...messages].reverse().find((message) => message.role === "user");
  const content = user?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => isRecord(part) && part.type === "text")
      .map((part) => readString((part as { text?: unknown }).text) ?? "")
      .join(" ");
  }
  return "";
}

function readExecutionChildren(
  item:
    | WorkflowStructureExecution
    | WorkflowStructureExecutionItem
    | WorkflowStructureExecutionBranchPath,
): WorkflowStructureExecutionItem[] {
  if (item.kind === "sequence" || item.kind === "loop" || isExecutionBranchPath(item)) {
    return item.children;
  }

  return [];
}

function isExecutionNode(
  item:
    | WorkflowStructureExecution
    | WorkflowStructureExecutionItem
    | WorkflowStructureExecutionBranchPath,
): item is WorkflowStructureExecutionNode {
  return item.kind === "node";
}

function isExecutionLoop(
  item:
    | WorkflowStructureExecution
    | WorkflowStructureExecutionItem
    | WorkflowStructureExecutionBranchPath,
): item is WorkflowStructureExecutionLoop {
  return item.kind === "loop";
}

function isExecutionBranch(
  item:
    | WorkflowStructureExecution
    | WorkflowStructureExecutionItem
    | WorkflowStructureExecutionBranchPath,
): item is WorkflowStructureExecutionBranch {
  return item.kind === "branch";
}

function isExecutionBranchPath(
  item:
    | WorkflowStructureExecution
    | WorkflowStructureExecutionItem
    | WorkflowStructureExecutionBranchPath,
): item is WorkflowStructureExecutionBranchPath {
  return item.kind === "if" || item.kind === "else-if" || item.kind === "else" || item.kind === "case";
}

function readOutputObject(value: unknown): Record<string, unknown> {
  expect(isRecord(value)).toBe(true);
  return value as Record<string, unknown>;
}

function readOptionalOutputObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readOutputItems(output: Record<string, unknown>): Array<Record<string, unknown>> {
  const items = output.items;
  expect(Array.isArray(items)).toBe(true);
  return (items as unknown[]).filter(isRecord);
}

function readOutputContent(output: Record<string, unknown>): string {
  return readOutputItems(output)
    .map((item) => stringifyOutputItemContent(item.content))
    .join("\n");
}

function readReportOutputContent(report: WorkflowExecutionReport): string {
  return readReportOutputItems(report)
    .map((item) => stringifyOutputItemContent(item.content))
    .join("\n");
}

function readReportOutputItems(report: WorkflowExecutionReport): Array<Record<string, unknown>> {
  return report.outputs
    .flatMap((entry) => entry.output.items)
    .filter(isRecord);
}

function expectPlainTextOutputItem(
  item: Record<string, unknown> | undefined,
  content: string,
): void {
  expect(item).toBeDefined();
  if (item === undefined) {
    return;
  }

  expect(item.title).toBe("Output");
  expect(item.content).toBe(content);
  expect(item.contentType).toBe("text");
  expect(item.icon).toBeUndefined();
  expect(item.iconPreset).toBeUndefined();
  expect(item.collapsed).toBeUndefined();
  expect(item.metadata).toBeUndefined();
}

function expectMergedRuntimeItemsToAvoidDuplicateContent(
  events: WorkflowRuntimeEvent[],
  finalItems: Array<Record<string, unknown>>,
): void {
  const liveItems = readLiveOutputItems(events);
  const mergedItems = mergeOutputItems(liveItems, finalItems);

  for (let index = 0; index < mergedItems.length; index += 1) {
    const item = mergedItems[index];
    const content = normalizeOutputItemContentForDuplicateCheck(item.content);
    if (content === "") {
      continue;
    }

    const duplicateIndex = mergedItems.findIndex((candidate, candidateIndex) =>
      candidateIndex !== index &&
      candidate.id !== item.id &&
      candidate.title === item.title &&
      candidate.contentType === item.contentType &&
      normalizeOutputItemContentForDuplicateCheck(candidate.content) === content
    );

    expect(duplicateIndex, `duplicate output item content for ${String(item.id)}`).toBe(-1);
  }
}

function readLiveOutputItems(events: WorkflowRuntimeEvent[]): Array<Record<string, unknown>> {
  return events.reduce((items, event) => {
    if (event.type !== "node_chunk") {
      return items;
    }

    if (isRecord(event.chunk)) {
      return applyOutputItemChunk(items, event.chunk);
    }

    const content = stringifyOutputItemContent(event.chunk);
    if (content === "") {
      return items;
    }

    // Mirror App's legacy string-chunk fallback path. This intentionally uses a
    // host-local id so tests fail when a workflow streams text but finalizes the
    // same content under a different report item id.
    return appendStringChunkOutputItem(items, content, event.chunkOrder === 1);
  }, [] as Array<Record<string, unknown>>);
}

function appendStringChunkOutputItem(
  items: Array<Record<string, unknown>>,
  content: string,
  separate: boolean,
): Array<Record<string, unknown>> {
  const last = items.at(-1);
  if (last !== undefined && last.contentType === "markdown" && last.collapsed !== true) {
    const separator = separate &&
      stringifyOutputItemContent(last.content).trim() !== "" &&
      !stringifyOutputItemContent(last.content).endsWith("\n")
      ? "\n"
      : "";
    return [
      ...items.slice(0, -1),
      {
        ...last,
        content: `${stringifyOutputItemContent(last.content)}${separator}${content}`,
      },
    ];
  }

  return [
    ...items,
    {
      id: "test-live-string-output",
      title: "Output",
      content,
      contentType: "markdown",
      collapsed: false,
    },
  ];
}

function applyOutputItemChunk(
  items: Array<Record<string, unknown>>,
  chunk: Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (chunk.type === "output_item_start" && isRecord(chunk.item)) {
    const item = normalizeOutputItem(chunk.item);
    return [
      ...items.filter((candidate) => candidate.id !== item.id),
      item,
    ];
  }

  if (chunk.type !== "output_item_delta" || typeof chunk.itemId !== "string") {
    return items;
  }

  return items.map((item) => item.id === chunk.itemId
    ? {
        ...item,
        content: mergeOutputItemContent(item.content, chunk.delta),
        ...normalizeOutputItemPatch(chunk.item),
      }
    : item);
}
function mergeOutputItems(
  liveItems: Array<Record<string, unknown>>,
  finalItems: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return finalItems.reduce((items, item) => {
    const existingIndex = items.findIndex((candidate) => candidate.id === item.id);
    if (existingIndex < 0) {
      return [...items, item];
    }

    return items.map((candidate, index) => index === existingIndex ? item : candidate);
  }, liveItems);
}

function normalizeOutputItem(item: Record<string, unknown>): Record<string, unknown> {
  return {
    id: typeof item.id === "string" && item.id.trim() !== "" ? item.id : "test-output-item",
    title: typeof item.title === "string" && item.title.trim() !== "" ? item.title : "Output",
    content: Object.hasOwn(item, "content") ? item.content : "",
    icon: item.icon,
    iconPreset: item.iconPreset,
    contentType: typeof item.contentType === "string" ? item.contentType : inferOutputContentType(item.content),
    collapsed: item.collapsed,
    metadata: item.metadata,
  };
}

function normalizeOutputItemPatch(value: unknown): Partial<WorkflowOutputItem> {
  if (!isRecord(value)) {
    return {};
  }

  const patch: Partial<WorkflowOutputItem> = {};
  if (typeof value.title === "string") patch.title = value.title;
  if (typeof value.icon === "string") patch.icon = value.icon;
  if (typeof value.iconPreset === "string") patch.iconPreset = value.iconPreset as WorkflowOutputItem["iconPreset"];
  if (typeof value.contentType === "string") patch.contentType = value.contentType as WorkflowOutputItem["contentType"];
  if (typeof value.collapsed === "boolean") patch.collapsed = value.collapsed;
  if (isRecord(value.metadata)) patch.metadata = value.metadata;
  return patch;
}

function mergeOutputItemContent(current: unknown, delta: unknown): unknown {
  if (typeof current === "string" || typeof delta === "string") {
    return `${stringifyOutputItemContent(current)}${stringifyOutputItemContent(delta)}`;
  }

  if (Array.isArray(current) && Array.isArray(delta)) {
    return [...current, ...delta];
  }

  if (isRecord(current) && isRecord(delta)) {
    return { ...current, ...delta };
  }

  return delta;
}

function inferOutputContentType(value: unknown): WorkflowOutputItem["contentType"] {
  return typeof value === "object" && value !== null ? "json" : "markdown";
}

function normalizeOutputItemContentForDuplicateCheck(value: unknown): string {
  return stringifyOutputItemContent(value).trim();
}

function expectOutputItem(
  items: Array<Record<string, unknown>>,
  expectedItem: WorkflowOutputItemExpectation,
  fallbackIndex: number,
): void {
  const index = expectedItem.index ?? fallbackIndex;
  const item = items[index];
  expect(item, `output item at index ${index}`).toBeDefined();
  if (item === undefined) {
    return;
  }

  const {
    index: _index,
    contentIncludes,
    contentMatches,
    metadata,
    ...exactProperties
  } = expectedItem;

  for (const [key, value] of Object.entries(exactProperties)) {
    expect(item[key], `output item ${index}.${key}`).toEqual(value);
  }

  if (metadata !== undefined) {
    expect(item.metadata, `output item ${index}.metadata`).toMatchObject(metadata);
  }

  if (contentMatches !== undefined) {
    if (isRecord(contentMatches) || Array.isArray(contentMatches)) {
      expect(item.content, `output item ${index}.content`).toMatchObject(contentMatches);
    } else {
      expect(item.content, `output item ${index}.content`).toEqual(contentMatches);
    }
  }

  for (const expectedContent of contentIncludes ?? []) {
    expect(stringifyOutputItemContent(item.content), `output item ${index}.content`).toContain(expectedContent);
  }
}

function expectTimerRecord(
  timer: WorkflowExecutionReport["timers"] extends Array<infer Timer> ? Timer | undefined : never,
  expectedTimer: WorkflowTimerExpectation,
  index: number,
): void {
  expect(timer, `timer at index ${index}`).toBeDefined();
  if (timer === undefined) {
    return;
  }

  const { metadata, minDurationMs, ...exactProperties } = expectedTimer;
  for (const [key, value] of Object.entries(exactProperties)) {
    expect(timer[key as keyof typeof timer], `timer ${index}.${key}`).toEqual(value);
  }

  if (metadata !== undefined) {
    expect(timer.metadata, `timer ${index}.metadata`).toMatchObject(metadata);
  }

  expect(timer.errCode, `timer ${index}.errCode`).toBe(0);
  expect(timer.errMessage, `timer ${index}.errMessage`).toBe("");
  expect(timer.startedAt, `timer ${index}.startedAt`).toEqual(expect.any(String));
  if (timer.status !== "running") {
    expect(timer.endedAt, `timer ${index}.endedAt`).toEqual(expect.any(String));
    expect(timer.durationMs, `timer ${index}.durationMs`).toEqual(expect.any(Number));
    if (minDurationMs !== undefined) {
      expect(timer.durationMs, `timer ${index}.durationMs`).toBeGreaterThanOrEqual(minDurationMs);
    }
  }
}

function stringifyOutputItemContent(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(value, null, 2);
}

function isOutputItemStartChunk(value: unknown): value is {
  type: "output_item_start";
  item: {
    id?: string;
  };
} {
  return isRecord(value) &&
    value.type === "output_item_start" &&
    isRecord(value.item);
}

async function createTempDir(prefix: string): Promise<string> {
  const resolved = await mkdtemp(path.join(os.tmpdir(), `workflow-code-${prefix}`));
  tempDirs.push(resolved);
  return resolved;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
