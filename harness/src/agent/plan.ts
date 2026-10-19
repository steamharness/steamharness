import type { UserInputRequest, UserInputResolved } from "../types/context";
import type { NodeMetadata } from "../types/index";
import type { AgentMode, AgentPlanApprovalResume, AgentTurnContinuationKind } from "./types";
import { AGENT_MODES, DEFAULT_AGENT_MODE } from "./types";
import { getRuntimeLocale } from "../runtime-locale";

/**
 * Plan mode is a prompt contract, not a capability: pi has no plan primitive,
 * so the mode is expressed by instructing the model and by the run refusing
 * mutating tool calls until the user approves the plan.
 */
export const AGENT_PLAN_SYSTEM_PROMPT = [
  "You are in plan mode.",
  "Investigate the workspace with the read-only tools and produce an implementation plan.",
  "Do not modify files and do not run state-changing commands; the write, edit and bash tools are unavailable.",
  "When the plan is complete, present it as a numbered list of concrete steps with the files each step touches.",
].join(" ");

export const AGENT_PLAN_APPROVAL_NODE_NAME = "plan-approval";

export const AGENT_PLAN_REQUEST_ID_PREFIX = "agent-plan-approval";

const DECISION_PARAM_NAME = "decision";
const INSTRUCTIONS_PARAM_NAME = "instructions";
const APPROVE_VALUE = "approve";
const DECLINE_VALUE = "decline";
/** The plan travels into the build turn, so it is bounded like any other prompt payload. */
const MAX_PLAN_CHARS = 20_000;

export function parseAgentMode(value: unknown): AgentMode {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    const match = AGENT_MODES.find((mode) => mode === normalized);
    if (match !== undefined) {
      return match;
    }
  }

  return DEFAULT_AGENT_MODE;
}

export function createAgentPlanRequestId(sessionId: string): string {
  const normalized = sessionId.trim().replace(/[^A-Za-z0-9_.:-]+/g, "-");
  return `${AGENT_PLAN_REQUEST_ID_PREFIX}:${normalized === "" ? "session" : normalized}`;
}

export function truncateAgentPlan(plan: string): string {
  return plan.length <= MAX_PLAN_CHARS ? plan : `${plan.slice(0, MAX_PLAN_CHARS)}\n\n[plan truncated]`;
}

interface AgentPlanApprovalText {
  title: string;
  description: string;
  decisionLabel: string;
  approveLabel: string;
  approveDescription: string;
  declineLabel: string;
  declineDescription: string;
  instructionsLabel: string;
  instructionsDescription: string;
}

/**
 * A plan-mode turn ends by asking the user to approve what it wrote.
 *
 * The decision is a radio rather than a boolean so the two outcomes can explain
 * themselves, and the instructions field is where a user redirects the plan
 * without rejecting it. Both mirror the built-in OpenCode project.
 */
export function createAgentPlanApprovalRequest(options: {
  requestId: string;
  plan: string;
}): UserInputRequest {
  const text = readAgentPlanApprovalText();
  const metadata: NodeMetadata = {
    type: "agent-plan-approval",
    title: text.title,
    version: "1.0.0",
  };

  return {
    requestId: options.requestId,
    nodeName: AGENT_PLAN_APPROVAL_NODE_NAME,
    title: text.title,
    description: text.description,
    params: [
      {
        name: DECISION_PARAM_NAME,
        type: "string",
        required: true,
        control: "radio",
        label: text.decisionLabel,
        defaultValue: APPROVE_VALUE,
        options: [
          {
            value: APPROVE_VALUE,
            label: text.approveLabel,
            description: text.approveDescription,
          },
          {
            value: DECLINE_VALUE,
            label: text.declineLabel,
            description: text.declineDescription,
          },
        ],
      },
      {
        name: INSTRUCTIONS_PARAM_NAME,
        type: "string",
        required: false,
        control: "textarea",
        label: text.instructionsLabel,
        description: text.instructionsDescription,
      },
    ],
    defaultValues: { [DECISION_PARAM_NAME]: APPROVE_VALUE },
    metadata,
    createdAt: new Date(),
  };
}

export function readAgentPlanDecision(
  resolved: UserInputResolved,
): AgentPlanApprovalResume {
  const instructions = readOptionalText(resolved.values[INSTRUCTIONS_PARAM_NAME]);
  return {
    requestId: resolved.requestId,
    approved: resolved.values[DECISION_PARAM_NAME] === APPROVE_VALUE,
    ...(instructions === undefined ? {} : { instructions }),
  };
}

/**
 * Said when a turn ends without producing anything at all.
 *
 * The model returned an empty message: no answer, no tool call, no reasoning.
 * A host that closes a turn when its output arrives would otherwise wait on
 * output that is never coming.
 */
export function createAgentEmptyTurnText(): { title: string; content: string } {
  return readRuntimeLocaleSafe() === "zh-CN"
    ? {
        title: "本次运行没有返回内容",
        content: "模型这一轮没有给出回答，也没有调用工具。可以重试，或换一个模型再试。",
      }
    : {
        title: "Nothing was returned",
        content: "The model answered with neither text nor a tool call. Try again, or try another model.",
      };
}

/** Announces the hand-off, so the transcript shows the session moved to the build agent. */
export function createAgentPlanApprovalHandoffText(): { title: string; content: string } {
  return readRuntimeLocaleSafe() === "zh-CN"
    ? {
        title: "已切换到 build 执行计划",
        content: "计划已获批准，本会话现在由 build agent 执行，计划的完整内容随本轮提示一起传入。",
      }
    : {
        title: "Switched to the build agent",
        content: "The plan is approved, so this session now runs with the build agent and travels with this turn's prompt.",
      };
}

/**
 * Prompt used to carry on a turn that was cut off mid-answer.
 *
 * A cut that lands after the model has already spoken cannot be replayed — the
 * text it produced is in the transcript, and re-sending the request would put a
 * second copy beside it. It is resumed instead, and what the prompt says
 * depends on why it was cut and on whether that half-written message survived:
 * a message whose tool call was never answered is dropped before the request
 * goes out, so the model has to be told that it cannot see its own last
 * sentence.
 *
 * The reason matters to the model, not just to the reader. A dropped stream is
 * bad luck and the answer can simply be carried on. An output limit is a
 * property of the request: whatever it was composing did not fit, so it has to
 * be told to send that action on its own instead of writing its way up to it
 * again — otherwise the continuation stops at the same ceiling.
 */
export function createAgentStreamResumePrompt(options: {
  kind: AgentTurnContinuationKind;
  reason: string;
  keptPartial: boolean;
}): string {
  if (options.kind === "length") {
    return [
      "Your previous response hit this model's output token limit and was cut off before it finished.",
      ...(options.keptPartial
        ? ["Everything you had already written is still in this conversation."]
        : ["The unfinished part could not be kept, because it ended in a tool call that never ran."]),
      "Send the action you were about to take now — the tool call on its own — and keep the output short, so it fits in what is left.",
    ].join("\n");
  }

  if (options.kind === "lost-call") {
    return [
      "Your previous response said it was calling a tool, but no tool call arrived and nothing ran.",
      ...(options.keptPartial
        ? ["The text you had already written is still in this conversation."]
        : ["Nothing of that response could be kept."]),
      "Make that tool call again, on its own.",
    ].join("\n");
  }

  const cut = `Your previous response was cut off by a connection error (${options.reason}) before it finished.`;

  if (options.keptPartial) {
    return [
      cut,
      "Everything you had already written is still in this conversation.",
      "Continue from exactly where you stopped. Do not repeat what you already wrote, and do not re-run a command whose result you already have.",
    ].join("\n");
  }

  return [
    cut,
    "The unfinished part could not be kept, because it ended in a tool call that never ran.",
    "Carry on with the task from the last step whose result is in this conversation. Do not start over or redo work you can see the outcome of.",
  ].join("\n");
}

/**
 * Said in the transcript when an interrupted turn is being continued.
 *
 * `kind` defaults to the dropped-stream wording so a caller written before the
 * two were told apart keeps reading the same sentence, and the progress suffix
 * always shows which budget the continuation is spending.
 */
export function createAgentStreamRetryText(options: {
  attempt: number;
  maxAttempts: number;
  kind?: AgentTurnContinuationKind;
}): { title: string; content: string } {
  const progress = `${options.attempt}/${options.maxAttempts}`;
  const kind = options.kind ?? "dropped";

  if (kind === "length") {
    return readRuntimeLocaleSafe() === "zh-CN"
      ? {
          title: `模型输出超出上限，正在续写（${progress}）`,
          content: "模型这一轮的回答撞上了模型的输出上限被截断。已生成的内容保留在本轮，现在让它把没说完的动作补完。",
        }
      : {
          title: `Output limit reached — continuing (${progress})`,
          content: "The model's answer hit its output token limit and was cut off. What it already produced is kept, and it is being asked to finish the action it was composing.",
        };
  }

  if (kind === "lost-call") {
    return readRuntimeLocaleSafe() === "zh-CN"
      ? {
          title: `工具调用丢失，正在重发（${progress}）`,
          content: "模型这一轮回复里宣告了工具调用，但调用没有传过来、什么都没执行。现在让它把这个调用重新发一次。",
        }
      : {
          title: `Tool call lost — re-sending (${progress})`,
          content: "The model's answer announced a tool call, but the call never arrived and nothing ran. It is being asked to make that call again.",
        };
  }

  return readRuntimeLocaleSafe() === "zh-CN"
    ? {
        title: `模型连接中断，正在续写（${progress}）`,
        content: "模型流在回答中途断开。已经生成的内容保留在本轮，现在让它从中断处继续。",
      }
    : {
        title: `Model stream dropped — continuing (${progress})`,
        content: "The model's stream was cut off mid-answer. What it already produced is kept, and it is being asked to carry on from there.",
      };
}

/**
 * Prompt used to resume a run whose plan was approved.
 *
 * The plan text is re-sent rather than read back from the transcript: a
 * compaction between the pause and the resume would otherwise drop it, and the
 * agent would start executing a plan it can no longer see.
 */
export function createAgentPlanResumePrompt(options: {
  plan: string;
  resume: AgentPlanApprovalResume;
}): string {
  const instructions = options.resume.instructions?.trim();
  const plan = truncateAgentPlan(options.plan);

  if (options.resume.approved) {
    return [
      "The user approved the plan from your previous turn, and the workflow switched this session from plan mode to the build agent.",
      ...(instructions === undefined || instructions === "" ? [] : ["", `Additional instructions from the user:\n${instructions}`]),
      "",
      "Execute the approved plan now in this session, keeping to its scope. If it turns out to need a different approach, say so before changing course.",
      "",
      "The approved plan:",
      plan,
    ].join("\n");
  }

  return [
    "The user declined to run the plan. Stay in plan mode and revise it.",
    ...(instructions === undefined || instructions === "" ? [] : ["", `Feedback to incorporate:\n${instructions}`]),
    "",
    "The plan that was declined:",
    plan,
  ].join("\n");
}

function readAgentPlanApprovalText(): AgentPlanApprovalText {
  return readRuntimeLocaleSafe() === "zh-CN"
    ? {
        title: "计划已就绪，是否执行？",
        description: "确认后会切换到 build，在同一个会话里执行上面的计划；也可以先补充要求或改成别的内容。",
        decisionLabel: "如何处理这份计划",
        approveLabel: "按计划执行",
        approveDescription: "切换到 build，并在同一会话里继续执行。",
        declineLabel: "先不执行",
        // Declining does not end the session: plan mode stays on and revises
        // the plan with whatever the user added, so the copy says so instead of
        // promising a run that stops.
        declineDescription: "本轮不执行，也不修改文件；补充要求会交回 plan，再修订一版。",
        instructionsLabel: "补充要求（可选）",
        instructionsDescription: "批准时随计划交给 build；先不执行时交回 plan 用于修订。",
      }
    : {
        title: "Plan ready — run it?",
        description: "Confirming switches to the build agent and runs the plan above in this session; you can also add instructions or replace the plan first.",
        decisionLabel: "What should happen",
        approveLabel: "Run the plan",
        approveDescription: "Switch to the build agent and continue in this session.",
        declineLabel: "Not now",
        declineDescription: "Nothing runs and no file is touched; the plan agent revises the plan with your instructions.",
        instructionsLabel: "Additional instructions (optional)",
        instructionsDescription: "Sent to the build agent with the plan, or back to the plan agent when you decline.",
      };
}

export function readRuntimeLocaleSafe(): string {
  try {
    return getRuntimeLocale();
  } catch {
    return "en";
  }
}

function readOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
