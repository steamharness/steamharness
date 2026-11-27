import type { PlatformConnection, PlatformConnections } from 'steamharness';
import { normalizeAuthServer } from '@steamharness/server-auth';
import { i18n } from '@steamharness/i18n';
import { cliAuthIsUsable, readCliAuthConfig, type AuthPurpose } from './auth-config';
export { resolveLocalStorageAccountKey as resolveOnlineAccountKey } from 'steamharness';

export function parseOnlinePurpose(value: string | undefined): AuthPurpose {
  if (value !== 'project' && value !== 'ai') throw new Error('--online requires project or ai.');
  return value;
}

export function parseOnlineOptions(argv: string[]): { argv: string[]; online: AuthPurpose[] } {
  const args: string[] = [], online: AuthPurpose[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--') { args.push(...argv.slice(index)); break; }
    if (argv[index] === '--online') online.push(parseOnlinePurpose(argv[++index]));
    else args.push(argv[index]!);
  }
  return { argv: args, online };
}

export async function readOnlineConnection(purpose: AuthPurpose, env = process.env): Promise<PlatformConnection | undefined> {
  const names = purpose === 'ai' ? ['STEAMHARNESS_AI_SERVER_URL', 'STEAMHARNESS_AI_API_KEY'] as const
    : ['STEAMHARNESS_SERVER_URL', 'STEAMHARNESS_SERVER_ADMIN_KEY'] as const;
  const address = env[names[0]]?.trim(), token = env[names[1]]?.trim();
  if (token) {
    if (!address) throw new Error(`${names[0]} is required when ${names[1]} is set.`);
    return { serverUrl: normalizeAuthServer(address), accessToken: token };
  }
  const saved = await readCliAuthConfig(env, address, purpose);
  if (!cliAuthIsUsable(saved)) return;
  return { serverUrl: normalizeAuthServer(saved.serverUrl), accessToken: saved.apiKey };
}

export async function resolveOnlineConnections(online: readonly AuthPurpose[], env = process.env): Promise<PlatformConnections> {
  const result: PlatformConnections = {};
  for (const purpose of new Set(online)) {
    const connection = await readOnlineConnection(purpose, env);
    if (!connection) {
      const login = `steamharness workspace login ${purpose === 'ai' ? '--ai ' : ''}--server <URL>`;
      throw new Error(i18n.language?.startsWith('zh') ? `需要连接服务器。请先运行 ${login}，再重试。` : `Requires a Server connection. Run ${login}, then retry.`);
    }
    result[purpose] = connection;
  }
  return result;
}

export function formatOnlineHelp(): string {
  return i18n.language?.startsWith('zh')
    ? '  --online <project|ai>  需要连接服务器，可重复指定；默认不读取平台凭证'
    : '  --online <project|ai>  Requires a Server connection; repeatable. Platform credentials are not read by default.';
}

export function withoutPlatformEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(?:STEAMHARNESS_(?:AI|LLM|SERVER|PUBLIC_SERVER|FILE_SERVER|CLI_AUTH_DIR|DESKTOP_CONFIG_DIR|STUDIO_INTERNAL)(?:_|$)|SUB2API_)/iu.test(key)));
}
