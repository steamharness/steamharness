import { readFileSync } from "node:fs";
import {
  createEmptyWorkflowAuthConfig,
  normalizeWorkflowAuthConfig,
  resolveWorkflowCliAuthFilePath,
  type WorkflowAuthConfig,
} from "@workflow-code/auth-config";

export function readWorkflowCliAuthConfigSync(
  env: NodeJS.ProcessEnv = process.env,
): WorkflowAuthConfig {
  try {
    const raw = readFileSync(resolveWorkflowCliAuthFilePath(env), "utf8");
    return normalizeWorkflowAuthConfig(JSON.parse(raw));
  } catch {
    return createEmptyWorkflowAuthConfig();
  }
}
