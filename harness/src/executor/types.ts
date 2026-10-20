import type {
  NodeDefinition,
  StreamNodeDefinition,
  RunContext,
  Definition,
  NodeMetadata,
  NodeMetadataInput,
} from "../types/index";
import type { TokenUsageDefinition } from "../token-usage/index";
import type {
  ToolPermissionDefinition,
  ToolPermissionPolicyMap,
} from "../tool-permissions/index";

export type ExecutorProviderName = "llm";

export type ParamType = "string" | "number" | "boolean" | "positional" | "file";
export type ParamControl =
  | "text"
  | "audio"
  | "textarea"
  | "radio"
  | "select"
  | "checkboxes"
  | "date"
  | "time"
  | "datetime"
  | "date-range";
export type ParamPanel = "main" | "auxiliary" | "quick" | "mode" | "slash";
export type DateParamControl = Extract<
  ParamControl,
  "date" | "time" | "datetime" | "date-range"
>;
export type ParamValue = string | string[];
export type ParamValues = Record<string, ParamValue>;

export type ParamResolveTrigger =
  | { kind: "init" }
  | { kind: "input" }
  | { kind: "param"; paramName: string };

export interface ParamResolveRequest {
  draftText: string;
  args: string[];
  inputMode: "form" | "raw";
  trigger: ParamResolveTrigger;
}

export interface ParamOptionStatePatch {
  visible?: boolean;
  disabled?: boolean;
}

export interface ParamStatePatch {
  value?: ParamValue | null;
  visible?: boolean;
  disabled?: boolean;
  /** Replaces the static option list for this resolved state. Null restores static options. */
  resolvedOptions?: ParamOption[] | null;
  options?: Record<string, ParamOptionStatePatch>;
}

export interface ParamResolveResult {
  params?: Record<string, ParamStatePatch>;
}

export interface ParamOption {
  value: string;
  label?: string;
  description?: string;
  /** Slash menu command without the leading slash. Defaults to the option value. */
  command?: string;
}

export interface AudioParamOptions {
  maxDurationSeconds?: number;
  maxBytes?: number;
}

interface ParamDefinitionBase {
  name: string;
  flag?: string;
  shortFlag?: string;
  required?: boolean;
  label?: string;
  description?: string;
  /** Command for a boolean Slash parameter. Defaults to the parameter name. */
  command?: string;
  defaultValue?: string;
  /** Re-run resolveParams when the main composer input changes. Defaults to false. */
  resolveOnInput?: boolean;
  accept?: string[];
  audio?: AudioParamOptions;
  format?: "json";
  /**
   * The step this field is asked in, starting at 1. Fields sharing a step are
   * asked together, and a host that presents a prompt one step at a time shows
   * them on one page, in ascending order.
   *
   * Use it when one request carries several separate questions — a caller that
   * asks the user three things at once declares three steps and gets three
   * pages — rather than for the fields of a single question, which read better
   * as one form.
   */
  step?: number;
}

export interface DateParamDefinition extends ParamDefinitionBase {
  type: "string";
  control: DateParamControl;
  panel?: "main" | "auxiliary";
  multiple?: false;
  options?: never;
}

export interface StandardParamDefinition extends ParamDefinitionBase {
  type: ParamType;
  // lets Run workspace render enum-style controls from static params.
  control?: Exclude<ParamControl, DateParamControl>;
  panel?: ParamPanel;
  multiple?: boolean;
  options?: ParamOption[];
}

export type ParamDefinition = DateParamDefinition | StandardParamDefinition;

export type ParamFieldDeclaration = ParamDefinition & { panel?: never };

export interface AuxiliaryParamGroupDefinition {
  kind: "auxiliary";
  id: string;
  label: string;
  fields: ParamFieldDeclaration[];
}

export interface QuickParamGroupDefinition {
  kind: "quick";
  id: string;
  label: string;
  /** Codicon name for the trigger. Defaults to settings. */
  icon?: string;
  /** Field names to show in this group's trigger, in display order. */
  summary: string[];
  fields: Array<StandardParamDefinition & { panel?: never }>;
}

export interface ModeParamDefinition extends Omit<StandardParamDefinition, "type" | "control" | "panel" | "multiple" | "kind"> {
  kind: "mode";
  flag: string;
  options: ParamOption[];
}

export interface SlashParamDefinition extends Omit<StandardParamDefinition, "type" | "control" | "panel" | "multiple" | "kind"> {
  kind: "slash";
  type: "string" | "boolean";
  flag: string;
}

export type ParamDeclaration =
  | ParamFieldDeclaration
  | AuxiliaryParamGroupDefinition
  | QuickParamGroupDefinition
  | ModeParamDefinition
  | SlashParamDefinition;

export type ConversationParamDeclaration =
  | AuxiliaryParamGroupDefinition
  | QuickParamGroupDefinition
  | ModeParamDefinition
  | SlashParamDefinition;

export interface ParamLayout {
  actions: Array<
    | { kind: "auxiliary"; id: string; label: string; params: string[] }
    | { kind: "quick"; id: string; label: string; icon?: string; summary: string[]; params: string[] }
    | { kind: "mode"; name: string }
    | { kind: "slash"; name: string }
  >;
}

export interface ExecutorContext {
  projectName: string;
  projectDir: string;
  entrypointId?: string;
  entrypointTitle?: string;
  args: string[];
  paramValues: ParamValues;
  config: import("../configuration").ConfigurationValues;
  abortSignal: AbortSignal;
  /** Host-owned structured input that is intentionally separate from argv and persisted run metadata. */
  hostInput?: unknown;
  conversationId?: string;
  toolPermissionPolicies?: ToolPermissionPolicyMap;
}

export interface ParamResolverContext extends ExecutorContext {
  draftText: string;
  inputMode: "form" | "raw";
  trigger: ParamResolveTrigger;
}

export type ConversationFooterItem = (
  | { text: string; localizedText?: Record<string, string>; param?: never }
  | { param: string; text?: never; localizedText?: never }
) & { when?: { param: string; value: string } };

export interface ConversationCommandDefinition {
  /** Unique command name without the leading slash. */
  command: string;
  label: string;
  description?: string;
  localizedLabel?: Record<string, string>;
  localizedDescription?: Record<string, string>;
  action:
    | { kind: "prompt"; text: string }
    | { kind: "export" };
}

export interface ConversationUserInputDefinition {
  /** Hide the standard composer while a user-input request is pending. Defaults to true. */
  hideComposer?: boolean;
  /** Apply matching effects once the runtime accepts an answer, in declaration order. */
  effects?: {
    when: { type?: string; nodeName?: string; values?: Record<string, string | number | boolean | string[]> };
    params: ParamValues;
  }[];
}

export interface ConversationDefinition {
  /** Execution commands alongside Slash parameters in the standard input menu. */
  commands?: ConversationCommandDefinition[];
  /** Plain text beneath, and outside, the standard message input. */
  footer?: ConversationFooterItem[];
  userInput?: ConversationUserInputDefinition;
  attachments?: {
    images?: boolean;
    videos?: boolean;
    files?: boolean;
  };
  inputQueue?: {
    enabled?: boolean;
  };
  /** Host may restart this workflow with the original run ID and resolved inputs. */
  recovery?: { enabled: true };
  /** Host keeps one durable agent owner and uses its session control protocol. */
  durable?: { enabled: true };
  openai?: {
    enabled: true;
    outputItemId: string;
  };
}

export interface ExecutionDefinition<Input, Output> {
  workflow: Definition<Input, Output>;
  requiredProviders?: ExecutorProviderName[];
  params?: ParamDeclaration[];
  tools?: ToolPermissionDefinition[];
  tokenUsage?: TokenUsageDefinition;
  registry?: NodeRegistryEntry[];
  createInput(
    context: ExecutorContext,
  ): Promise<Input> | Input;
  resolveParams?(
    context: ParamResolverContext,
  ): Promise<ParamResolveResult> | ParamResolveResult;
  createContext?(
    context: ExecutorContext,
  ): Promise<Partial<Omit<RunContext, "storage" | "conversation" | "files">>> |
    Partial<Omit<RunContext, "storage" | "conversation" | "files">>;
}

export interface EntrypointGroupDefinition {
  id: string;
  title: string;
  order?: number;
}

export interface EntrypointDefinition<Input = unknown, Output = unknown>
  extends ExecutionDefinition<Input, Output> {
  id: string;
  title: string;
  description?: string;
  group?: EntrypointGroupDefinition;
}

export interface NodeRegistryEntry<
  Input = unknown,
  Output = unknown,
> {
  name: string;
  node:
    | NodeDefinition<Input, Output>
    | StreamNodeDefinition<Input, unknown, Output>;
  metadata?: NodeMetadataInput;
  stream?: boolean;
  createInput?(
    context: ExecutorContext,
  ): Promise<Input> | Input;
}

export interface NodeRegistryItem {
  name: string;
  standardName?: string;
  metadata: NodeMetadata;
}

export interface ProjectExecutorDefinition {
  projectType: "workflow";
  defaultEntrypoint: string;
  entrypoints: readonly EntrypointDefinition<any, any>[];
  conversation?: never;
}

export type ConversationExecutorDefinition<Input, Output> =
  Omit<ExecutionDefinition<Input, Output>, "params"> & {
    projectType: "conversation";
    params?: ConversationParamDeclaration[];
    conversation?: ConversationDefinition;
    defaultEntrypoint?: never;
    entrypoints?: never;
  };

export type ExecutorDefinition<Input = unknown, Output = unknown> =
  | ProjectExecutorDefinition
  | ConversationExecutorDefinition<Input, Output>;

export interface ExecutorModule<Input = unknown, Output = unknown> {
  default?: unknown;
  executor?: ExecutorDefinition<Input, Output>;
}
