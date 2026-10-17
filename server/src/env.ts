import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";
import type { ServerPathRoots } from "./paths";
import { resolveServerPathRoots } from "./paths";

export interface LoadServerEnvOptions {
  mode?: "development" | "production";
  roots?: ServerPathRoots;
}

export function loadServerEnv(options: LoadServerEnvOptions = {}): void {
  if (shouldSkipServerEnvFiles()) {
    return;
  }
  const mode = options.mode ?? inferServerEnvMode();
  const initialRoots = options.roots ?? resolveServerPathRoots();
  const initialRepoRoot = initialRoots.repoRoot;

  loadEnvFiles(resolveServerEnvFiles(initialRoots, mode));

  const resolvedRoots = options.roots ?? resolveServerPathRoots();

  if (resolvedRoots.repoRoot !== initialRepoRoot) {
    loadEnvFiles(resolveServerEnvFiles(resolvedRoots, mode));
  }
}

/**
 * Internal aggregate runtimes pass an explicit, allowlisted environment to the
 * linked public Server. Do not let a developer checkout's `.env` reintroduce
 * private provider or database settings into that process.
 */
export function shouldSkipServerEnvFiles(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STEAMHARNESS_SKIP_ENV_FILES === "1";
}

export function resolveServerEnvFiles(
  roots: ServerPathRoots,
  mode: "development" | "production",
): string[] {
  // Keep release/deploy startup on explicit .env.production files so a
  // checked-in dev .env does not silently pull production back to 7126.
  if (mode === "production") {
    return unique([
      path.join(roots.serverRoot, ".env.production"),
      path.join(roots.repoRoot, ".env.production"),
      path.join(roots.serverRoot, ".env"),
      path.join(roots.repoRoot, ".env"),
    ]);
  }

  return unique([
    path.join(roots.serverRoot, ".env"),
    path.join(roots.repoRoot, ".env"),
  ]);
}

export function inferServerEnvMode(
  env: NodeJS.ProcessEnv = process.env,
): "development" | "production" {
  if (env.STEAMHARNESS_SERVER_DEV === "1" || env.NODE_ENV === "development") {
    return "development";
  }
  return "production";
}

function loadEnvFiles(filePaths: string[]): void {
  for (const filePath of unique(filePaths)) {
    if (!existsSync(filePath)) {
      continue;
    }

    const values = parse(readFileSync(filePath));

    for (const [key, value] of Object.entries(values)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
