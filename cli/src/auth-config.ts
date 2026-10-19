import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  createEmptyProjectAuthConfig,
  normalizeProjectAuthConfig,
  resolveProjectCliAuthDir,
  resolveProjectCliAuthFilePath,
  type AuthConfig,
} from "@steamharness/auth-config";

export async function readCliAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AuthConfig> {
  try {
    const raw = await readFile(resolveProjectCliAuthFilePath(env), "utf8");
    return normalizeProjectAuthConfig(JSON.parse(raw));
  } catch {
    return createEmptyProjectAuthConfig();
  }
}

export function readCliAuthConfigSync(
  env: NodeJS.ProcessEnv = process.env,
): AuthConfig {
  try {
    const raw = readFileSync(resolveProjectCliAuthFilePath(env), "utf8");
    return normalizeProjectAuthConfig(JSON.parse(raw));
  } catch {
    return createEmptyProjectAuthConfig();
  }
}

export async function writeCliAuthConfig(
  config: AuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const directory = resolveProjectCliAuthDir(env);
  const filePath = resolveProjectCliAuthFilePath(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // `mode` is ignored when an existing directory is reused. The file now
  // contains the separate AI service credential as well, so repair the
  // directory before writing it.
  await chmod(directory, 0o700);
  await writeFile(
    filePath,
    `${JSON.stringify(normalizeProjectAuthConfig(config), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  // `mode` is ignored when an existing file is overwritten, so repair a file
  // created by an older CLI before returning.
  await chmod(filePath, 0o600);
}

export async function clearCliAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await rm(resolveProjectCliAuthFilePath(env), { force: true });
}
