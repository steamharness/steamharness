import { config as loadEnvFile } from "dotenv";
import { WorkflowError } from "../workflow/errors";

export function loadWorkflowEnv(envPath: string): void {
  loadEnvFile({
    path: envPath,
    quiet: true,
  });
}

export function readRequiredEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  aliases: string[] = [],
): string {
  const value = readOptionalEnv(env, name, aliases);

  if (value === undefined) {
    throw new WorkflowError({
      type: "input_validation",
      message: `Missing required environment variable: ${name}.`,
      metadata: {
        env: name,
        aliases,
      },
    });
  }

  return value;
}

export function readOptionalEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  aliases: string[] = [],
): string | undefined {
  for (const key of [name, ...aliases]) {
    const value = env[key];

    if (value !== undefined && value.trim() !== "") {
      return value.trim();
    }
  }

  return undefined;
}
