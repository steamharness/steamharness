import type { ConversationExecutorDefinition, ConversationParamDeclaration } from "../executor/types";
import { defineProjectExecutor } from "../executor/definition";
import { createOutputNode, createOutputPayload } from "../node/output/index";
import { createInputNode } from "../node/input/index";
import { parseConversationDefaultInputArgs } from "../executor/default-input";
import { parseAgentModelAttributes } from "./model-attributes";
import type { NodeContext } from "../types/index";
import { defineProject, runNode, runStreamNode } from "../workflow/index";
import type { Definition } from "../types/index";
import { HarnessError } from "../workflow/errors";
import { createAgentProjectParamResolver } from "./system-llm";
import { normalizeProjectParamDeclarations } from "../executor/param-definition";
import { parseProjectParamValues } from "../executor/params";
import {
  createAgentNode,
  readAgentRunContextUsage,
  readAgentRunItemOrder,
  readAgentRunMode,
  recordAgentRunItemOrder,
} from "./node";
import {
  AGENT_ANSWER_ITEM_ID,
  AGENT_OUTPUT_KINDS,
  applyAgentItemOrder,
  createAgentItemOrderTracker,
} from "./output-items";
import { readAgentToolDefinitions } from "./permission";
import { readRuntimeLocaleSafe } from "./plan";
import type { FileReference } from "../files/index";
import {
  DEFAULT_AGENT_EFFORT,
  DEFAULT_AGENT_PERMISSION_POLICY,
  type AgentImageInput,
  type AgentInput,
  type AgentOutputPayload,
  type AgentProjectOptions,
} from "./types";

const DEFAULT_OUTPUT_ITEM_ID = "agent-answer";

/**
 * The workflow half of a conversation agent project.
 *
 * A project has to declare its executor as a statically analysable object
 * literal — Core's structure report reads `params`, `tools`, `conversation`
 * and `tokenUsage` straight off the AST of the project's `index.ts`, and a
 * factory that returns the whole executor hides all four. So the *logic* lives
 * here and the project composes the declaration around it.
 */
export function createAgentConversationProject(
  options: AgentProjectOptions = {},
): Definition<AgentInput, AgentOutputPayload> {
  const executorName = options.executorName ?? "agent";
  const outputItemId = options.outputItemId ?? DEFAULT_OUTPUT_ITEM_ID;
  const node = createAgentNode({ ...options, name: `${executorName}-agent` });

  const inputNode = createInputNode<AgentInput, AgentInput>({
    name: `${executorName}-input`,
    async parse(input, context) {
      const resolved = await resolveAgentImageFiles(input, context, `${executorName}-input`);
      const prompt = typeof resolved.prompt === "string" ? resolved.prompt : "";
      // An attachment is a question of its own: a run that carries one and no
      // text is a user showing the agent something, not an empty turn.
      if (prompt.trim() === "" && (resolved.images?.length ?? 0) === 0) {
        throw new HarnessError({
          type: "input_validation",
          message: "Prompt is required.",
          nodeName: `${executorName}-input`,
        });
      }

      return resolved;
    },
  });

  const outputNode = createOutputNode<AgentInput, AgentOutputPayload>({
    name: `${executorName}-output`,
    async *stream(input, context) {
      // The rows are ordered by where each one finished, not by where it
      // started: an answer that keeps streaming after a tool call would
      // otherwise stay above the tool it followed.
      const tracker = createAgentItemOrderTracker();
      for await (const chunk of runAgentNode(node, input, context)) {
        tracker.observe(chunk);
        yield chunk;
      }
      recordAgentRunItemOrder(input, tracker.ids());
    },
    async format(stream, input, context) {
      const items = applyAgentItemOrder(stream.items, readAgentRunItemOrder(input));
      const answer = readAssistantAnswer(items, outputItemId);
      // Kept for API consumers; the node emits the display as a standard item.
      const contextUsage = readAgentRunContextUsage(input);

      // A run driven by a host input — the OpenAI/Responses gateway — keeps its
      // transcript on the host side, exactly as the built-in conversation
      // project leaves it out of the workflow conversation.
      if (input.hostInput === undefined) {
        const turnText = readConversationTurnText(input);
        const turnId = input.requestId ?? String(context.metadata?.["runId"]);
        if (turnText !== undefined) {
          await context.conversation.appendMessage({ id: `${executorName}:${turnId}:user`, role: "user", content: turnText });
        }
        // A turn that only called tools has no answer; an empty assistant
        // message would read as a reply that said nothing.
        if (answer !== "") {
          await context.conversation.appendMessage({
            id: `${executorName}:${turnId}:assistant`,
            role: "assistant",
            content: answer,
            metadata: { agent: readAgentRunMode(input) ?? input.agent ?? "build" },
          });
        }
      }

      return {
        ...createOutputPayload({ items }),
        prompt: input.prompt,
        workdir: input.workdir ?? options.workdir ?? "",
        ...(input.provider ?? options.provider) === undefined
          ? {}
          : { provider: input.provider ?? options.provider },
        ...(input.model ?? options.model) === undefined ? {} : { model: input.model ?? options.model },
        effort: input.effort ?? options.effort ?? DEFAULT_AGENT_EFFORT,
        agent: readAgentRunMode(input) ?? input.agent ?? options.mode ?? "build",
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(contextUsage === undefined ? {} : { contextUsage }),
        toolCallCount: items.filter(isToolItem).length,
      } satisfies AgentOutputPayload;
    },
  });

  return defineProject<AgentInput, AgentOutputPayload>({
    name: executorName,
    async run(input, context) {
      const parsed = await runNode(inputNode, input, context);
      const result = await runStreamNode(outputNode, parsed, context);

      if (result.output === undefined) {
        throw new HarnessError({
          type: "execution",
          message: `Workflow "${executorName}" did not produce output.`,
        });
      }

      return result.output;
    },
  });
}

/**
 * The input half of a conversation agent project.
 *
 * Meant to be handed to `params`-driven executors as `createInput`, so it
 * reads as a value rather than a factory the structure analyser has to see
 * through.
 */
export function createAgentProjectInput(
  args: string[],
  options: AgentProjectOptions = {},
): AgentInput {
  return createAgentInputFromArgs(args, options);
}

/**
 * The whole project in one call.
 *
 * Convenience for callers that are not a project — an embedding host, or a
 * test — and therefore never go through structure validation. A project that
 * has to pass the structure contract composes `createAgentConversationProject`
 * and `createAgentProjectInput` into its own inline executor instead.
 */
export function defineAgentConversationExecutor(
  options: AgentProjectOptions = {},
): ConversationExecutorDefinition<AgentInput, AgentOutputPayload> {
  const executorName = options.executorName ?? "agent";
  const outputItemId = options.outputItemId ?? DEFAULT_OUTPUT_ITEM_ID;

  // Annotated before validation so the returned definition keeps the narrower
  // conversation type — a builtin that receives the union would lose `workflow`.
  const definition: ConversationExecutorDefinition<AgentInput, AgentOutputPayload> = {
    projectType: "conversation",
    workflow: createAgentConversationProject(options),
    conversation: {
      collapseIntermediate: options.collapseIntermediate ?? true,
      recovery: { enabled: true },
      ...(options.session ? { durable: { enabled: true as const } } : {}),
      inputQueue: { enabled: true },
      openai: { enabled: true, outputItemId },
    },
    tokenUsage: { enabled: true, display: true },
    tools: options.toolDefinitions ?? [...readAgentToolDefinitions(undefined), ...(options.session ? [
      { name: "update_plan", label: "Task plan", enabled: true, autoApprove: true },
      ...(options.session.subagents ? [{ name: "subagent", label: "Delegate task", enabled: true, autoApprove: true }] : []),
    ] : [])],
    params: options.params ?? createAgentProjectParams(options),
    async resolveParams(context) {
      const result = await createAgentProjectParamResolver({ modelSource: options.modelSource })(context);
      const names = new Set(normalizeProjectParamDeclarations(definition.params).params.map(param => param.name));
      return { params: Object.fromEntries(Object.entries(result.params ?? {}).filter(([name]) => names.has(name))) };
    },
    createInput({ args }) {
      return createAgentProjectInput(args, options);
    },
  };

  defineProjectExecutor<AgentInput, AgentOutputPayload>(definition);
  return definition;
}

/**
 * Drives the agent node and forwards its chunks.
 *
 * The node is where a `user_input_required` pause is raised; it is re-thrown
 * unchanged so the workflow runtime owns the pause and can resume the run
 * through the same request id.
 */
async function* runAgentNode(
  node: ReturnType<typeof createAgentNode>,
  input: AgentInput,
  context: NodeContext,
) {
  for await (const chunk of node.stream(input, context)) {
    yield chunk;
  }
}

export function createAgentProjectParams(options: AgentProjectOptions = {}): ConversationParamDeclaration[] {
  return [
    {
      kind: "auxiliary",
      id: "workspace",
      label: "工作目录",
      fields: [
        {
          name: "workdir",
          flag: "--workdir",
          shortFlag: "-C",
          type: "string",
          required: false,
          label: "工作目录",
          description: "代理操作的工作目录。",
          defaultValue: options.workdir ?? ".",
        },
      ],
    },
    {
      kind: "quick",
      id: "ai",
      label: "AI",
      icon: "sparkle",
      summary: ["model", "effort"],
      fields: [
        {
          // Hidden by the resolver; retained for existing project declarations.
          name: "provider",
          flag: "--provider",
          type: "string",
          required: true,
          control: "select",
          label: "AI 配置",
          description: "SteamHarness Server 的系统 AI 配置。",
          options: [],
        },
        {
          name: "model",
          flag: "--model",
          shortFlag: "-m",
          type: "string",
          required: true,
          control: "select",
          label: "模型",
          description: options.modelSource !== "project" ? "从用户设置中选择模型，默认使用第一个可用模型。" : "先在项目配置中添加模型。默认使用列表中的第一项。",
          ...(options.modelSource !== "project" ? { userSetting: { key: "agent.model" as const, mode: "default" as const } } : {}),
          options: [],
        },
        {
          // Sits beside the AI configuration, like the built-in OpenCode project's
          // Effort: it belongs to the model choice, not to the advanced options.
          name: "effort",
          flag: "--effort",
          type: "string",
          required: false,
          label: "Effort",
          description: "思考强度。超出模型支持范围时会自动收敛到该模型支持的档位。",
          defaultValue: options.effort ?? DEFAULT_AGENT_EFFORT,
          control: "select",
          options: [
            // The wording is part of the published catalogue the built-in projects
            // declare inline and compare against, so it changes only with a Core
            // release. The empty value resolves to pi's `off` — no reasoning level
            // is sent, which is what "let the model decide" asks for.
            { value: "", label: "模型默认", description: "交给模型决定。" },
            { value: "off", label: "Off", description: "不做推理。" },
            { value: "minimal", label: "Minimal" },
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra high" },
            { value: "max", label: "Max", description: "仅部分模型支持。" },
          ],
        },
      ],
    },
    {
      kind: "mode",
      name: "agent",
      flag: "--agent",
      required: false,
      label: "代理模式",
      description: "build 直接执行，plan 只输出计划等待批准。",
      defaultValue: options.mode ?? "build",
      options: [
        { value: "build", label: "Build", description: "直接修改工作区。" },
        { value: "plan", label: "Plan", description: "先给出计划，批准后再执行。" },
      ],
    },
    {
      kind: "auxiliary",
      id: "model-settings",
      label: "模型设置",
      fields: [
        {
          name: "contextWindow",
          flag: "--context-window",
          type: "number",
          required: false,
          label: "上下文窗口",
          description: "上下文用量一栏使用的分母（tokens）。留空时取模型自身的窗口。",
        },
        {
          // Only meaningful for an endpoint this project reaches directly. A run on
          // the account's system AI takes the Server catalogue's record instead, so
          // the field says as much rather than inviting a value nothing reads.
          name: "modelAttributes",
          flag: "--model-attributes",
          type: "string",
          required: false,
          label: "模型属性（JSON）",
          description: "自定义端点模型的属性：input / reasoning / webSearch / contextWindow / maxTokens / cost / thinkingLevelMap。使用系统 AI 时由目录提供，无需填写。",
        },
        {
          name: "webSearch", flag: "--web-search", type: "string", required: false,
          label: "联网搜索", description: "自动跟随模型能力；可显式开启或关闭 OpenAI / Anthropic 原生搜索。",
          control: "select", defaultValue: options.webSearch === undefined ? "" : String(options.webSearch),
          options: [{ value: "", label: "自动" }, { value: "true", label: "开启" }, { value: "false", label: "关闭" }],
        },
      ],
    },
    {
      kind: "quick",
      id: "permission",
      label: "权限",
      icon: "shield",
      summary: ["permissionPolicy"],
      fields: [
        {
          name: "permissionPolicy",
          flag: "--permission-policy",
          type: "string",
          required: false,
          label: "Permission",
          description: "工具权限策略，与内置 OpenCode 项目一致。",
          ...(options.permissionPolicy === "inherit"
            ? { userSetting: { key: "agent.permissionPolicy" as const, mode: "default" as const } }
            : { defaultValue: options.permissionPolicy ?? DEFAULT_AGENT_PERMISSION_POLICY }),
          control: "select",
          options: [
            { value: "read-only", label: "Read only", description: "隐藏写入与命令工具。" },
            // The old wording promised that every path outside the workspace is
            // refused, which a shell command is not bound by; the panel says what
            // actually holds. The built-in projects declare this list inline and
            // compare it against the published Core, so the wording travels with a
            // release.
            {
              value: "workspace",
              label: "Workspace",
              description: "工作区内自动批准编辑和命令；读写与检索工具只能访问工作区与挂载目录，shell 命令不受此限制。",
            },
            { value: "auto", label: "Auto approve", description: "批准一切未被显式拒绝的权限，包括工作区之外的路径。" },
          ],
        },
      ],
    },
  ];
}

/**
 * Reads a run's image attachments through the workflow file store.
 *
 * A composer stores what the user attached and passes on a reference — an id,
 * a mime type, and nothing else — because the bytes live where the workflow
 * process, not the host, can reach them. Only a node has that store, so the
 * input node is where a reference becomes the base64 the agent SDK wants, and
 * the resolved images travel on as if the caller had supplied them directly.
 *
 * A reference nothing can read is an error here rather than a silent drop: a
 * turn that quietly loses its attachments looks like a model ignoring the
 * picture it was sent.
 */
export async function resolveAgentImageFiles(
  input: AgentInput,
  context: NodeContext,
  nodeName: string,
): Promise<AgentInput> {
  const references = input.imageFiles;
  if (references === undefined || references.length === 0) {
    if (references === undefined) {
      return input;
    }
    const { imageFiles: _dropped, ...rest } = input;
    return rest;
  }

  const files = context.files;
  if (files === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: "本次运行带有图片附件，但运行环境没有配置文件存储，无法读取附件内容。",
      nodeName,
    });
  }

  const images: AgentImageInput[] = [...(input.images ?? [])];
  for (const reference of references) {
    if (!isImageReference(reference)) {
      throw new HarnessError({
        type: "input_validation",
        message: `附件 "${reference.name || reference.id}" 不是图片，无法作为图片输入。`,
        nodeName,
        metadata: { fileId: reference.id },
      });
    }

    const file = await files.resolveFile(reference);
    const data = await file.readBase64();
    const mimeType = file.mimeType === "" ? reference.mimeType : file.mimeType;
    if (data === "" || mimeType === "") {
      throw new HarnessError({
        type: "input_validation",
        message: `附件 "${reference.name || reference.id}" 没有可用的图片内容。`,
        nodeName,
        metadata: { fileId: reference.id },
      });
    }
    images.push({ data, mimeType });
  }

  const { imageFiles: _resolved, ...rest } = input;
  return { ...rest, images };
}

function isImageReference(reference: FileReference): boolean {
  return reference.kind === "image" || reference.mimeType.startsWith("image/");
}

/**
 * The user row a run leaves in the workflow conversation.
 *
 * An image-only turn still needs one: the transcript would otherwise show an
 * answer to a question that was never asked. The row names the attachments
 * rather than inventing text for the model — the agent transcript keeps the
 * real image parts, so nothing anywhere claims the user typed this.
 */
function readConversationTurnText(input: AgentInput): string | undefined {
  const prompt = input.prompt.trim();
  if (prompt !== "") {
    return input.prompt;
  }

  const imageCount = input.images?.length ?? 0;
  if (imageCount === 0) {
    return undefined;
  }

  return readRuntimeLocaleSafe() === "zh-CN"
    ? `（图片 ${imageCount} 张）`
    : `(${imageCount} image${imageCount === 1 ? "" : "s"})`;
}

function createAgentInputFromArgs(
  args: string[],
  options: AgentProjectOptions,
): AgentInput {
  const defaults = parseConversationDefaultInputArgs(args);
  const message = defaults.message.trim();
  const input: AgentInput = {
    prompt: message,
    errCode: 0,
    errMessage: "",
    // Attachments arrive as references; the input node resolves them through
    // the run's file store, which no arg parser has access to.
    ...(defaults.images.length === 0 ? {} : { imageFiles: defaults.images }),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--workdir":
      case "-C":
        input.workdir = args[++index] ?? options.workdir;
        break;
      case "--provider":
        input.provider = args[++index];
        break;
      case "--model":
      case "-m":
        input.model = args[++index];
        break;
      case "--effort":
        input.effort = (args[++index] ?? "") as AgentInput["effort"];
        break;
      case "--agent":
        input.agent = (args[++index] ?? "") as AgentInput["agent"];
        break;
      case "--permission-policy":
        input.permissionPolicy = (args[++index] ?? "") as AgentInput["permissionPolicy"];
        break;
      case "--context-window": {
        const value = Number(args[++index]);
        if (Number.isFinite(value) && value > 0) {
          input.contextWindow = Math.trunc(value);
        }
        break;
      }
      case "--model-attributes": {
        const raw = args[++index];
        if (raw !== undefined) {
          input.modelAttributes = parseAgentModelAttributes(raw);
        }
        break;
      }
      case "--web-search": {
        const value = args[++index] ?? "";
        if (value !== "" && value !== "true" && value !== "false") {
          throw new HarnessError({ type: "input_validation", message: "--web-search must be true or false." });
        }
        input.webSearch = value === "" ? undefined : value === "true";
        break;
      }
      default:
        // A flag this project does not declare is not prompt text, and neither
        // is its value: collecting both would type `--unknown value` into the
        // prompt. Only bare positional words are gathered.
        if (arg.startsWith("-")) {
          if (!arg.includes("=")) {
            index += 1;
          }
          break;
        }
        if (message === "" && arg.trim() !== "") {
          input.prompt = input.prompt === "" ? arg : `${input.prompt} ${arg}`;
        }
        break;
    }
  }

  const declarations = options.params ?? createAgentProjectParams(options);
  if (normalizeProjectParamDeclarations(declarations).params.some(param => param.name === "permissionPolicy" && param.userSetting)) {
    input.permissionPolicy = parseProjectParamValues(declarations, args).permissionPolicy as AgentInput["permissionPolicy"];
  }
  return input;
}

/**
 * The turn's text, as the conversation message.
 *
 * A conversation writes a turn's text as one row per run of text between two
 * activity rows — the answer item only exists for a host that reads the
 * response text back by id — so those rows are joined into the message. A
 * plan-mode turn can have ordinary text before its final plan, so both kinds
 * of row contribute to the conversation message in their original order.
 */
function readAssistantAnswer(
  items: Array<{ id?: string; title?: string; content: unknown; metadata?: Record<string, unknown> }>,
  outputItemId: string,
): string {
  const answer = items.filter((item) =>
    item.metadata?.["kind"] === AGENT_OUTPUT_KINDS.answer ||
    (item.id !== undefined && (item.id.endsWith(AGENT_ANSWER_ITEM_ID) || item.id === outputItemId)));
  const source = answer.length > 0
    ? answer
    : items.filter((item) => isTextItem(item) ||
      (item.metadata?.["kind"] === AGENT_OUTPUT_KINDS.notice && item.metadata["plan"] === true));

  // Text rows split one message, so they are joined with nothing between them:
  // they are where the newlines already are.
  const separator = answer.length === 0 ? "" : "\n";

  return source
    .map((item) => (typeof item.content === "string" ? item.content : JSON.stringify(item.content, null, 2)))
    .join(separator)
    .trim();
}

function isToolItem(item: { metadata?: Record<string, unknown> }): boolean {
  return item.metadata?.["kind"] === AGENT_OUTPUT_KINDS.part && item.metadata["partType"] === "tool";
}

function isTextItem(item: { metadata?: Record<string, unknown> }): boolean {
  return item.metadata?.["kind"] === AGENT_OUTPUT_KINDS.part && item.metadata["partType"] === "text";
}
