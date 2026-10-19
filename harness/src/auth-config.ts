import { readFileSync } from "node:fs";
import {
  createEmptyProjectAuthConfig,
  normalizeProjectAuthConfig,
  resolveProjectCliAuthFilePath,
  type AuthConfig,
} from "@steamharness/auth-config";

export function readProjectCliAuthConfigSync(
  env: NodeJS.ProcessEnv = process.env,
): AuthConfig {
  try {
    const raw = readFileSync(resolveProjectCliAuthFilePath(env), "utf8");
    return normalizeProjectAuthConfig(JSON.parse(raw));
  } catch {
    return createEmptyProjectAuthConfig();
  }
}
