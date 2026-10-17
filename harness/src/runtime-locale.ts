export type WorkflowRuntimeLocale = "zh-CN" | "en";

/**
 * The host injects this marker for a workflow execution. Projects should use
 * getRuntimeLocale() instead of reading process.env directly.
 */
export const WORKFLOW_RUNTIME_LOCALE_ENV = "WORKFLOW_RUNTIME_LOCALE";

export function getRuntimeLocale(): WorkflowRuntimeLocale {
  return normalizeRuntimeLocale(readRuntimeLocaleMarker());
}

export function normalizeRuntimeLocale(value: string | undefined): WorkflowRuntimeLocale {
  const normalized = value?.trim().toLowerCase().replaceAll("_", "-");

  if (normalized?.startsWith("en")) return "en";

  // Workflow projects are Chinese by default. Hosts that support a different
  // language must explicitly inject it rather than relying on machine locale.
  return "zh-CN";
}

function readRuntimeLocaleMarker(): string | undefined {
  const globalWithProcess = globalThis as typeof globalThis & {
    process?: {
      env?: Record<string, string | undefined>;
    };
  };

  return globalWithProcess.process?.env?.[WORKFLOW_RUNTIME_LOCALE_ENV];
}
