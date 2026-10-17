import type {
  NodeDefinition,
  StreamNodeDefinition,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowNodeMetadata,
  WorkflowNodeMetadataInput,
} from "../types/index";
import type { WorkflowTokenUsageDefinition } from "../token-usage/index";
import type {
  WorkflowToolPermissionDefinition,
  WorkflowToolPermissionPolicyMap,
} from "../tool-permissions/index";

export type ExecutorProviderName = "llm";

export type WorkflowParamType = "string" | "number" | "boolean" | "positional" | "file";
export type WorkflowParamControl =
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
export type WorkflowParamPanel = "main" | "auxiliary" | "quick" | "mode" | "slash";
export type WorkflowDateParamControl = Extract<
  WorkflowParamControl,
  "date" | "time" | "datetime" | "date-range"
>;
export type WorkflowParamValue = string | string[];
export type WorkflowParamValues = Record<string, WorkflowParamValue>;

export type WorkflowParamResolveTrigger =
  | { kind: "init" }
  | { kind: "input" }
  | { kind: "param"; paramName: string };

export interface WorkflowParamResolveRequest {
  draftText: string;
  args: string[];
  inputMode: "form" | "raw";
  trigger: WorkflowParamResolveTrigger;
}

export interface WorkflowParamOptionStatePatch {
  visible?: boolean;
  disabled?: boolean;
}

export interface WorkflowParamStatePatch {
  value?: WorkflowParamValue | null;
  visible?: boolean;
  disabled?: boolean;
  /** Replaces the static option list for this resolved state. Null restores static options. */
  resolvedOptions?: WorkflowParamOption[] | null;
  options?: Record<string, WorkflowParamOptionStatePatch>;
}

export interface WorkflowParamResolveResult {
  params?: Record<string, WorkflowParamStatePatch>;
}

export interface WorkflowParamOption {
  value: string;
  label?: string;
  description?: string;
  /** Slash menu command without the leading slash. Defaults to the option value. */
  command?: string;
}

export interface WorkflowAudioParamOptions {
  maxDurationSeconds?: number;
  maxBytes?: number;
}

interface WorkflowParamDefinitionBase {
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
  audio?: WorkflowAudioParamOptions;
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

export interface WorkflowDateParamDefinition extends WorkflowParamDefinitionBase {
  type: "string";
  control: WorkflowDateParamControl;
  panel?: "main" | "auxiliary";
  multiple?: false;
  options?: never;
}

export interface WorkflowStandardParamDefinition extends WorkflowParamDefinitionBase {
  type: WorkflowParamType;
  // lets Run workspace render enum-style controls from static params.
  control?: Exclude<WorkflowParamControl, WorkflowDateParamControl>;
  panel?: WorkflowParamPanel;
  multiple?: boolean;
  options?: WorkflowParamOption[];
}

export type WorkflowParamDefinition = WorkflowDateParamDefinition | WorkflowStandardParamDefinition;

export type WorkflowParamFieldDeclaration = WorkflowParamDefinition & { panel?: never };

export interface WorkflowAuxiliaryParamGroupDefinition {
  kind: "auxiliary";
  id: string;
  label: string;
  fields: WorkflowParamFieldDeclaration[];
}

export interface WorkflowQuickParamGroupDefinition {
  kind: "quick";
  id: string;
  label: string;
  /** Codicon name for the trigger. Defaults to settings. */
  icon?: string;
  /** Field names to show in this group's trigger, in display order. */
  summary: string[];
  fields: Array<WorkflowStandardParamDefinition & { panel?: never }>;
}

export interface WorkflowModeParamDefinition extends Omit<WorkflowStandardParamDefinition, "type" | "control" | "panel" | "multiple" | "kind"> {
  kind: "mode";
  flag: string;
  options: WorkflowParamOption[];
}

export interface WorkflowSlashParamDefinition extends Omit<WorkflowStandardParamDefinition, "type" | "control" | "panel" | "multiple" | "kind"> {
  kind: "slash";
  type: "string" | "boolean";
  flag: string;
}

export type WorkflowParamDeclaration =
  | WorkflowParamFieldDeclaration
  | WorkflowAuxiliaryParamGroupDefinition
  | WorkflowQuickParamGroupDefinition
  | WorkflowModeParamDefinition
  | WorkflowSlashParamDefinition;

export type WorkflowConversationParamDeclaration =
  | WorkflowAuxiliaryParamGroupDefinition
  | WorkflowQuickParamGroupDefinition
  | WorkflowModeParamDefinition
  | WorkflowSlashParamDefinition;

export interface WorkflowParamLayout {
  actions: Array<
    | { kind: "auxiliary"; id: string; label: string; params: string[] }
    | { kind: "quick"; id: string; label: string; icon?: string; summary: string[]; params: string[] }
    | { kind: "mode"; name: string }
    | { kind: "slash"; name: string }
  >;
}

export interface WorkflowExecutorContext {
  workflowName: string;
  workflowDir: string;
  entrypointId?: string;
  entrypointTitle?: string;
  args: string[];
  paramValues: WorkflowParamValues;
  env: NodeJS.ProcessEnv;
  abortSignal: AbortSignal;
  /** Host-owned structured input that is intentionally separate from argv and persisted run metadata. */
  hostInput?: unknown;
  conversationId?: string;
  toolPermissionPolicies?: WorkflowToolPermissionPolicyMap;
}

export interface WorkflowParamResolverContext extends WorkflowExecutorContext {
  draftText: string;
  inputMode: "form" | "raw";
  trigger: WorkflowParamResolveTrigger;
}

export type WorkflowConversationFooterItem = (
  | { text: string; localizedText?: Record<string, string>; param?: never }
  | { param: string; text?: never; localizedText?: never }
) & { when?: { param: string; value: string } };

export interface WorkflowConversationCommandDefinition {
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

export interface WorkflowConversationUserInputDefinition {
  /** Hide the standard composer while a user-input request is pending. Defaults to true. */
  hideComposer?: boolean;
  /** Apply matching effects once the runtime accepts an answer, in declaration order. */
  effects?: {
    when: { type?: string; nodeName?: string; values?: Record<string, string | number | boolean | string[]> };
    params: WorkflowParamValues;
  }[];
}

export interface WorkflowConversationDefinition {
  /** Execution commands alongside Slash parameters in the standard input menu. */
  commands?: WorkflowConversationCommandDefinition[];
  /** Plain text beneath, and outside, the standard message input. */
  footer?: WorkflowConversationFooterItem[];
  userInput?: WorkflowConversationUserInputDefinition;
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

export interface WorkflowExecutionDefinition<Input, Output> {
  workflow: WorkflowDefinition<Input, Output>;
  requiredProviders?: ExecutorProviderName[];
  params?: WorkflowParamDeclaration[];
  tools?: WorkflowToolPermissionDefinition[];
  tokenUsage?: WorkflowTokenUsageDefinition;
  registry?: WorkflowNodeRegistryEntry[];
  createInput(
    context: WorkflowExecutorContext,
  ): Promise<Input> | Input;
  resolveParams?(
    context: WorkflowParamResolverContext,
  ): Promise<WorkflowParamResolveResult> | WorkflowParamResolveResult;
  createContext?(
    context: WorkflowExecutorContext,
  ): Promise<Partial<Omit<WorkflowContext, "storage" | "conversation" | "files">>> |
    Partial<Omit<WorkflowContext, "storage" | "conversation" | "files">>;
}

export interface WorkflowEntrypointGroupDefinition {
  id: string;
  title: string;
  order?: number;
}

export interface WorkflowEntrypointDefinition<Input = unknown, Output = unknown>
  extends WorkflowExecutionDefinition<Input, Output> {
  id: string;
  title: string;
  description?: string;
  group?: WorkflowEntrypointGroupDefinition;
}

export interface WorkflowNodeRegistryEntry<
  Input = unknown,
  Output = unknown,
> {
  name: string;
  node:
    | NodeDefinition<Input, Output>
    | StreamNodeDefinition<Input, unknown, Output>;
  metadata?: WorkflowNodeMetadataInput;
  stream?: boolean;
  createInput?(
    context: WorkflowExecutorContext,
  ): Promise<Input> | Input;
}

export interface WorkflowNodeRegistryItem {
  name: string;
  standardName?: string;
  metadata: WorkflowNodeMetadata;
}

export interface WorkflowProjectExecutorDefinition {
  projectType: "workflow";
  defaultEntrypoint: string;
  entrypoints: readonly WorkflowEntrypointDefinition<any, any>[];
  conversation?: never;
}

export type WorkflowConversationExecutorDefinition<Input, Output> =
  Omit<WorkflowExecutionDefinition<Input, Output>, "params"> & {
    projectType: "conversation";
    params?: WorkflowConversationParamDeclaration[];
    conversation?: WorkflowConversationDefinition;
    defaultEntrypoint?: never;
    entrypoints?: never;
  };

export type WorkflowExecutorDefinition<Input = unknown, Output = unknown> =
  | WorkflowProjectExecutorDefinition
  | WorkflowConversationExecutorDefinition<Input, Output>;

export interface WorkflowExecutorModule<Input = unknown, Output = unknown> {
  default?: unknown;
  executor?: WorkflowExecutorDefinition<Input, Output>;
}
