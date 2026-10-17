export type WorkflowRuntimePlatform = "cli" | "desktop";

export const STEAMHARNESS_RUNTIME_PLATFORM_ENV = "STEAMHARNESS_RUNTIME_PLATFORM";

export function getRuntimePlatform(): WorkflowRuntimePlatform {
  return normalizeRuntimePlatform(readRuntimePlatformMarker());
}

export function isCli(): boolean {
  return getRuntimePlatform() === "cli";
}

export function isDesktop(): boolean {
  return getRuntimePlatform() === "desktop";
}

function readRuntimePlatformMarker(): string | undefined {
  const globalWithProcess = globalThis as typeof globalThis & {
    process?: {
      env?: Record<string, string | undefined>;
    };
  };

  return globalWithProcess.process?.env?.[STEAMHARNESS_RUNTIME_PLATFORM_ENV];
}

function normalizeRuntimePlatform(value: string | undefined): WorkflowRuntimePlatform {
  const normalized = value?.trim().toLowerCase();

  if (normalized === "desktop" || normalized === "cli") {
    return normalized;
  }

  if (normalized === "app") {
    throw new TypeError('STEAMHARNESS_RUNTIME_PLATFORM="app" is no longer supported; use "desktop".');
  }

  if (normalized) throw new TypeError(`Unsupported STEAMHARNESS_RUNTIME_PLATFORM: ${normalized}`);

  return "cli";
}
