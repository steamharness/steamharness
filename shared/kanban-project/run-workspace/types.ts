// Slim type slice for the kanban inlined subset of run-workspace-input.
// Keep this list aligned with the references reachable from the files under
// ./form, ./ui, ./utils, and ./hooks. New fields belong here only when a
// retained file needs them; do not pull in unrelated run-workspace types.

import type { RefObject } from "react";

export type WorkflowParamType = "string" | "number" | "boolean" | "positional" | "file";

// The full control union, not just the subset the inlined ParamsForm renders.
// Kanban manifests only declare the first five, but `WorkflowParamDefinition`
// has to stay structurally identical to the canonical one in
// `desktop/packages/run-workspace-input` so hosts can pass the same param
// arrays to both without a nominal type conflict.
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

export type WorkflowParamPanel = "main" | "auxiliary" | "quick";

export type WorkflowParamValue = string | string[];

export interface WorkflowParamOption {
  value: string;
  label?: string;
  description?: string;
}

export interface WorkflowAudioParamOptions {
  maxDurationSeconds?: number;
  maxBytes?: number;
}

export type WorkflowFileObjectsUploader = (
  param: WorkflowParamDefinition,
  files: File[],
  options: { signal: AbortSignal },
) => Promise<WorkflowManagedFileReference[]>;

export interface WorkflowParamDefinition {
  name: string;
  flag?: string;
  shortFlag?: string;
  type: WorkflowParamType;
  required?: boolean;
  description?: string;
  defaultValue?: string;
  multiple?: boolean;
  control?: WorkflowParamControl;
  panel?: WorkflowParamPanel;
  resolveOnInput?: boolean;
  options?: WorkflowParamOption[];
  accept?: string[];
  audio?: WorkflowAudioParamOptions;
  format?: "json";
  label?: string;
}

export interface WorkflowParamOptionStatePatch { visible?: boolean; disabled?: boolean }

export interface WorkflowParamStatePatch {
  value?: WorkflowParamValue | null;
  visible?: boolean;
  disabled?: boolean;
  resolvedOptions?: WorkflowParamOption[] | null;
  options?: Record<string, WorkflowParamOptionStatePatch>;
}

export interface WorkflowManagedFileReference {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  storage: "local" | "server";
  workflowId?: string;
  conversationId?: string;
  createdAt: string;
}

// Unused here but referenced by other retained files via index signatures.
export type { RefObject };
