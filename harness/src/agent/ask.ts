import type { UserInputRequest, UserInputResolved } from "../types/context";
import type { ParamDefinition } from "../executor/types";
import type { NodeMetadata } from "../types/index";
import type { AgentQuestion } from "./types";
import { readRuntimeLocaleSafe } from "./plan";

/**
 * The agent asking the user something mid-turn.
 *
 * A plan is a conversation, and the answer to "which of these two approaches?"
 * is not something a model should guess. Planning is the mode that confirms
 * what is about to happen, so it is the mode where the question is asked — the
 * same rule that keeps a tool approval from stopping a build turn.
 */
export const AGENT_ASK_TOOL_NAME = "ask_user";

export const AGENT_ASK_NODE_NAME = "ask-user";

export const AGENT_ASK_REQUEST_ID_PREFIX = "agent-question";

/**
 * Names one ask.
 *
 * Keyed by the tool call that raised it, so a turn that asks twice asks two
 * different questions — while the run that resumes reads the id back from the
 * state the paused turn left, rather than recomputing it.
 */
export function createAgentAskRequestId(toolCallId: string): string {
  const normalized = toolCallId.trim().replace(/[^A-Za-z0-9_.:-]+/g, "-");
  return `${AGENT_ASK_REQUEST_ID_PREFIX}:${normalized === "" ? "question" : normalized}`;
}

const MAX_QUESTIONS = 8;
const MAX_QUESTION_CHARS = 2_000;
const MAX_OPTIONS = 12;

/**
 * The questions in a tool call, or nothing when they are not askable.
 *
 * The model writes this JSON, so it is read defensively: a question with no
 * options is still a question (it is answered in words), but a call without a
 * single usable question is refused rather than shown to the user as an empty
 * form.
 */
export function readAgentQuestions(value: unknown): AgentQuestion[] {
  const raw = isRecord(value) ? value["questions"] : undefined;
  if (!Array.isArray(raw)) {
    return [];
  }

  const questions: AgentQuestion[] = [];
  for (const entry of raw.slice(0, MAX_QUESTIONS)) {
    if (!isRecord(entry)) continue;
    const question = readText(entry["question"]);
    if (question === undefined) continue;

    const options = readQuestionOptions(entry["options"]);
    questions.push({
      question: question.slice(0, MAX_QUESTION_CHARS),
      ...(readText(entry["header"]) === undefined
        ? {}
        : { header: readText(entry["header"]) as string }),
      ...(options.length === 0 ? {} : { options }),
      ...(entry["multiple"] === true ? { multiple: true } : {}),
      ...(entry["custom"] === true && options.length > 0 ? { custom: true } : {}),
    });
  }

  return questions;
}

function readQuestionOptions(value: unknown): { label: string; description?: string }[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const options: { label: string; description?: string }[] = [];
  for (const entry of value.slice(0, MAX_OPTIONS)) {
    const label = isRecord(entry)
      ? readText(entry["label"]) ?? readText(entry["value"])
      : readText(entry);
    if (label === undefined) continue;

    const description = isRecord(entry) ? readText(entry["description"]) : undefined;
    options.push({ label, ...(description === undefined ? {} : { description }) });
  }

  return options;
}

interface AgentAskText {
  title: string;
  description: string;
  customOptionLabel: string;
  customOptionDescription: string;
  customFieldSuffix: string;
}

function readAgentAskText(): AgentAskText {
  return readRuntimeLocaleSafe() === "zh-CN"
    ? {
        title: "需要你的确认",
        description: "计划里的这一步需要你先定下来，回答后它会继续。",
        customOptionLabel: "我来写",
        customOptionDescription: "不用上面的选项，直接在下面填写。",
        customFieldSuffix: "自定义回答",
      }
    : {
        title: "Your call",
        description: "The plan needs this decided before it goes on. Answer and it continues.",
        customOptionLabel: "I'll write it",
        customOptionDescription: "None of the options fit — answer in the field below.",
        customFieldSuffix: "custom answer",
      };
}

const OPTION_VALUE_PREFIX = "option:";
const CUSTOM_OPTION_VALUE = "custom";

export function agentAskAnswerParamName(index: number): string {
  return `question_${index + 1}`;
}

function agentAskCustomParamName(index: number): string {
  return `${agentAskAnswerParamName(index)}_custom`;
}

/**
 * The form the user answers.
 *
 * One step per question, so a host that presents a prompt one step at a time
 * asks one question at a time, and a question's own answer box travels with
 * it. The parameter shape — a radio, a checkbox group, an optional free-text
 * field — is the one every host already renders.
 */
export function createAgentAskRequest(options: {
  requestId: string;
  questions: AgentQuestion[];
}): UserInputRequest {
  const text = readAgentAskText();
  const params = options.questions.flatMap((question, index) => {
    const answer: ParamDefinition = {
      name: agentAskAnswerParamName(index),
      type: "string",
      required: true,
      label: question.question,
      control: question.multiple === true ? "checkboxes" : "radio",
      multiple: question.multiple === true,
      step: index + 1,
      ...(question.header === undefined ? {} : { description: question.header }),
      options: [
        ...(question.options ?? []).map((option, optionIndex) => ({
          value: `${OPTION_VALUE_PREFIX}${optionIndex}`,
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
        })),
        ...(question.custom === true
          ? [{
              value: CUSTOM_OPTION_VALUE,
              label: text.customOptionLabel,
              description: text.customOptionDescription,
            }]
          : []),
      ],
    };

    // A question with nothing to choose from is answered in words; one that
    // offers a custom option gets a field for those words.
    if ((question.options ?? []).length === 0) {
      return [{ ...answer, control: "textarea" as const, options: undefined }];
    }
    if (question.custom !== true) {
      return [answer];
    }

    return [
      answer,
      {
        name: agentAskCustomParamName(index),
        type: "string",
        required: false,
        label: `${question.header ?? `Question ${String(index + 1)}`} ${text.customFieldSuffix}`,
        description: text.customOptionDescription,
        control: "textarea",
        step: index + 1,
      } satisfies ParamDefinition,
    ];
  });

  const metadata: NodeMetadata = {
    type: "agent-ask",
    title: text.title,
    version: "1.0.0",
  };

  return {
    requestId: options.requestId,
    nodeName: AGENT_ASK_NODE_NAME,
    title: options.questions.length === 1
      ? options.questions[0]?.header ?? text.title
      : text.title,
    description: text.description,
    params,
    metadata,
    createdAt: new Date(),
  };
}

/**
 * What the user answered, question by question, as the model should read it.
 *
 * An answer the model can act on is the option the user picked, written the way
 * they saw it, or the words they typed — not the value the form stored
 * ("option:0").
 */
export function readAgentAskAnswers(
  resolved: UserInputResolved,
  questions: AgentQuestion[],
): string[] {
  return questions.map((question, index) => {
    const selected = readSelectedValues(resolved.values[agentAskAnswerParamName(index)]);
    const custom = readText(resolved.values[agentAskCustomParamName(index)]);
    const labels = selected
      .map((value) => {
        const optionIndex = value.startsWith(OPTION_VALUE_PREFIX)
          ? Number.parseInt(value.slice(OPTION_VALUE_PREFIX.length), 10)
          : Number.NaN;
        return Number.isInteger(optionIndex)
          ? question.options?.[optionIndex]?.label ?? value
          : undefined;
      })
      .filter((label): label is string => label !== undefined && label !== "");

    if (custom !== undefined) {
      return [...labels, custom].join(", ");
    }
    return labels.join(", ");
  });
}

function readSelectedValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? entry : "" )).filter((entry) => entry !== "");
  }
  return typeof value === "string" && value.trim() !== "" ? [value.trim()] : [];
}

/**
 * The prompt that carries the answers into the turn that resumes.
 *
 * The paused turn ended in a tool call that never returned, so the answers have
 * to arrive as words: the model reads them and picks the plan back up, without
 * asking again.
 */
export function createAgentAskResumePrompt(options: {
  prompt: string;
  questions: AgentQuestion[];
  answers: string[];
}): string {
  const exchanges = options.questions.map((question, index) => {
    const answer = options.answers[index]?.trim();
    return `- ${question.question}\n  Answer: ${answer === undefined || answer === "" ? "(no answer)" : answer}`;
  });

  return [
    "The user answered the questions you asked:",
    "",
    ...exchanges,
    "",
    "Carry on with the request you were working on, still in plan mode. Do not ask these again.",
    "",
    options.prompt,
  ].join("\n");
}

function readText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
