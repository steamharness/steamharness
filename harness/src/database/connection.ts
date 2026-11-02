import { readProjectCliAuthConfigSync } from "../auth-config";

export interface DatabaseConnection { serverUrl: string; token: string }
export function databaseConnectionFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseConnection | undefined {
  const config = readProjectCliAuthConfigSync(env);
  const serverUrl = (env.STEAMHARNESS_SERVER_URL ?? config.serverUrl).trim();
  const token = (env.STEAMHARNESS_SERVER_ADMIN_KEY ?? env.STEAMHARNESS_SERVER_TOKEN ?? config.apiKey).trim();
  return serverUrl && token ? { serverUrl: serverUrl.replace(/\/+$/, ""), token } : undefined;
}
