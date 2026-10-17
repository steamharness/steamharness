import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  createEmptyWorkflowAuthConfig,
  normalizeWorkflowAuthConfig,
  resolveWorkflowCliAuthDir,
  resolveWorkflowCliAuthFilePath,
  type WorkflowAuthConfig,
} from "@steamharness/auth-config";

export async function readCliAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkflowAuthConfig> {
  try {
    const raw = await readFile(resolveWorkflowCliAuthFilePath(env), "utf8");
    return normalizeWorkflowAuthConfig(JSON.parse(raw));
  } catch {
    return createEmptyWorkflowAuthConfig();
  }
}

export function readCliAuthConfigSync(
  env: NodeJS.ProcessEnv = process.env,
): WorkflowAuthConfig {
  try {
    const raw = readFileSync(resolveWorkflowCliAuthFilePath(env), "utf8");
    return normalizeWorkflowAuthConfig(JSON.parse(raw));
  } catch {
    return createEmptyWorkflowAuthConfig();
  }
}

export async function writeCliAuthConfig(
  config: WorkflowAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const directory = resolveWorkflowCliAuthDir(env);
  const filePath = resolveWorkflowCliAuthFilePath(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // `mode` is ignored when an existing directory is reused. The file now
  // contains the separate AI service credential as well, so repair the
  // directory before writing it.
  await chmod(directory, 0o700);
  await writeFile(
    filePath,
    `${JSON.stringify(normalizeWorkflowAuthConfig(config), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  // `mode` is ignored when an existing file is overwritten, so repair a file
  // created by an older CLI before returning.
  await chmod(filePath, 0o600);
}

export async function clearCliAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await rm(resolveWorkflowCliAuthFilePath(env), { force: true });
}
