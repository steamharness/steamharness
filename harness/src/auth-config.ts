import { readFileSync } from "node:fs";
import {
  createEmptyWorkflowAuthConfig,
  normalizeWorkflowAuthConfig,
  resolveWorkflowCliAuthFilePath,
  type AuthConfig,
} from "@steamharness/auth-config";

export function readWorkflowCliAuthConfigSync(
  env: NodeJS.ProcessEnv = process.env,
): AuthConfig {
  try {
    const raw = readFileSync(resolveWorkflowCliAuthFilePath(env), "utf8");
    return normalizeWorkflowAuthConfig(JSON.parse(raw));
  } catch {
    return createEmptyWorkflowAuthConfig();
  }
}
