// Slim type slice for the kanban inlined subset of run-workspace-input.
// Keep this list aligned with the references reachable from the files under
// ./form, ./ui, ./utils, and ./hooks. New fields belong here only when a
// retained file needs them; do not pull in unrelated run-workspace types.

import type { RefObject } from "react";

export type ParamType = "string" | "number" | "boolean" | "positional" | "file";

// The full control union, not just the subset the inlined ParamsForm renders.
// Kanban manifests only declare the first five, but `ParamDefinition`
// has to stay structurally identical to the canonical one in
// `desktop/packages/run-workspace-input` so hosts can pass the same param
// arrays to both without a nominal type conflict.
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

export type ParamPanel = "main" | "auxiliary" | "quick";

export type ParamValue = string | string[];

export interface ParamOption {
  value: string;
  label?: string;
  description?: string;
}

export interface AudioParamOptions {
  maxDurationSeconds?: number;
  maxBytes?: number;
}

export type FileObjectsUploader = (
  param: ParamDefinition,
  files: File[],
  options: { signal: AbortSignal },
) => Promise<ManagedFileReference[]>;

export interface ParamDefinition {
  name: string;
  flag?: string;
  shortFlag?: string;
  type: ParamType;
  required?: boolean;
  description?: string;
  defaultValue?: string;
  multiple?: boolean;
  control?: ParamControl;
  panel?: ParamPanel;
  resolveOnInput?: boolean;
  options?: ParamOption[];
  accept?: string[];
  audio?: AudioParamOptions;
  format?: "json";
  label?: string;
}

export interface ParamOptionStatePatch { visible?: boolean; disabled?: boolean }

export interface ParamStatePatch {
  value?: ParamValue | null;
  visible?: boolean;
  disabled?: boolean;
  resolvedOptions?: ParamOption[] | null;
  options?: Record<string, ParamOptionStatePatch>;
}

export interface ManagedFileReference {
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
