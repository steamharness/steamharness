import { t } from './localization';
import { createMemoryClient } from '../../../../shared/account-memory/index';
declare const __STEAMHARNESS_DEFAULT_SERVER_URL__: string;
export const DEFAULT_STEAMHARNESS_SERVER_URL = typeof __STEAMHARNESS_DEFAULT_SERVER_URL__ !== 'undefined'
  ? __STEAMHARNESS_DEFAULT_SERVER_URL__ : 'http://localhost:7126';

export interface User {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
}

export interface Connection {
  serverUrl: string;
  accessToken: string;
  /** Secret host credential. Only the CLI host receives it, never a project worker. */
  memoryToken?: string;
  /** Optional private system-AI service connection kept separate from project auth. */
  aiServerUrl?: string;
  aiAccessToken?: string;
}
export interface LoginSession extends Connection {
  user: User;
  apiKeyId: string;
  expiresAt?: string;
  sessionCookie?: string;
}

export interface AccountState {
  status: 'signed-out' | 'checking' | 'authenticated' | 'expired' | 'error';
  serverUrl: string;
  aiServerUrl?: string;
  aiConfigured?: boolean;
  user?: User;
  expiresAt?: string;
  error?: string;
  revision: number;
}

interface ApiEnvelope<T> { errCode: number; errMessage?: string; data?: T }
interface MeResponse {
  profile: User | null;
  principal?: { apiKeyId?: string; expiresAt?: string };
}
interface LoginResponse {
  memoryToken?: string;
  authenticated: boolean;
  accessToken?: string;
  apiKey?: { id?: string };
  expiresAt?: string;
}

export interface SystemAiUsage {
  balance: number;
  groups: { groupId: number; name: string; subscriptionType: string; subscription?: {
    status: string; dailyLimitUsd: number | null; dailyUsageUsd: number;
    weeklyLimitUsd: number | null; weeklyUsageUsd: number;
    monthlyLimitUsd: number | null; monthlyUsageUsd: number;
  } }[];
}

export class AuthError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export function normalizeProjectServerUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new AuthError(t("Enter a valid server address.")); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new AuthError(t("The server address must use HTTP or HTTPS and contain no credentials or query parameters."));
  }
  // `localhost` and `127.0.0.1` are the same dev server. Stored sessions match
  // on the normalized URL, so the two spellings must not invalidate each other
  // across restarts.
  if (url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]') {
    url.hostname = '127.0.0.1';
  }
  return url.toString().replace(/\/+$/, '');
}

/**
 * Remove deployment and credential material before an untrusted project
 * worker inherits the Studio process environment. Project workers receive
 * their scoped Workflow connection through the host protocol instead.
 */
export function isPrivateEnvironmentKey(key: string): boolean {
  return key === 'NODE_OPTIONS' ||
    /^(?:STEAMHARNESS_(?:AI|LLM|SERVER|PUBLIC_SERVER|STUDIO_INTERNAL)(?:_|$)|SUB2API_)/u.test(key) ||
    /(?:^|_)(?:API[_-]?KEY|ACCESS[_-]?KEY(?:_ID)?|SECRET|TOKEN|PASSWORD|PRIVATE[_-]?KEY|DATABASE_URL|REDIS_URL|CREDENTIALS?|AUTH(?:ORIZATION)?|CONFIG)(?:$|_)/iu.test(key) ||
    /^(?:DOCKER_CONFIG|KUBECONFIG|SSH_AUTH_SOCK|GIT_(?:CONFIG|SSH|ASKPASS)|NPM_CONFIG_USERCONFIG|PIP_CONFIG_FILE|CARGO_HOME|AZURE_CONFIG_DIR)$/u.test(key);
}

export function sanitizeProjectEnvironment(base: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(base).filter(([key, value]) => value !== undefined && !isPrivateEnvironmentKey(key)));
}

export class ServerClient {
  readonly serverUrl: string;
  constructor(serverUrl: string, private readonly fetcher: typeof fetch = fetch) {
    this.serverUrl = normalizeProjectServerUrl(serverUrl);
  }

  /** Account settings may reuse the authenticated login session; project keys are never accepted. */
  async accountMemory(session: LoginSession, action: string, input?: Record<string, unknown>): Promise<any> {
    if (normalizeProjectServerUrl(session.serverUrl) !== this.serverUrl || (!session.memoryToken && !session.sessionCookie)) {
      throw new AuthError(t('Sign in again to authorize account memory.'), 401);
    }
    const call = (headers: Record<string, string>) => createMemoryClient({
      baseUrl: this.serverUrl, fetch: this.fetcher, headers: () => headers,
    }).call(action, input);
    if (session.memoryToken) {
      try { return await call({ Authorization: `Bearer ${session.memoryToken}` }); }
      catch (error) {
        if ((error as { status?: number }).status !== 401 || !session.sessionCookie) { throw error; }
      }
    }
    return call({ Cookie: session.sessionCookie! });
  }

  private async request<T>(path: string, options: {
    accessToken?: string; sessionCookie?: string; body?: object; method?: string;
    headersReceived?: (headers: Headers) => void;
  } = {}): Promise<T> {
    const { accessToken, sessionCookie, body, method = body ? 'POST' : 'GET' } = options;
    let response: Response;
    try {
      response = await this.fetcher(`${this.serverUrl}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        credentials: 'omit',
        headers: {
          Accept: 'application/json', 'Accept-Language': 'zh-CN',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          ...(sessionCookie ? { Cookie: sessionCookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new AuthError(t("Cannot connect to SteamHarness Server. Check the server address and network.")); }
    options.headersReceived?.(response.headers);
    let payload: ApiEnvelope<T>;
    try { payload = await response.json() as ApiEnvelope<T>; }
    catch { throw new AuthError(t("The server returned an invalid response."), response.status); }
    if (!response.ok || payload.errCode !== 0 || payload.data === undefined) {
      const message = response.status === 401
        ? (path === '/api/auth/login' ? t("Incorrect email or password.") : t("Sign-in expired. Sign in again."))
        : response.status === 429 ? t("Too many requests. Try again later.")
          : payload.errMessage || t("SteamHarness Server request failed ({0}).", response.status);
      throw new AuthError(accessToken ? message.replaceAll(accessToken, '[redacted]') : message, response.status);
    }
    return payload.data;
  }

  async verify(connection: Connection): Promise<LoginSession> {
    if (normalizeProjectServerUrl(connection.serverUrl) !== this.serverUrl || !connection.accessToken) {
      throw new AuthError(t("Sign-in credentials do not match the server."), 401);
    }
    const me = await this.request<MeResponse>('/api/auth/me', { accessToken: connection.accessToken });
    const profile = me.profile;
    if (!profile || typeof profile.userId !== 'string' || !profile.userId || typeof profile.email !== 'string' || typeof profile.displayName !== 'string' || !me.principal?.apiKeyId) {
      throw new AuthError(t("The server did not return valid account information."));
    }
    let avatarUrl: string | undefined;
    if (typeof profile.avatarUrl === 'string' && profile.avatarUrl) {
      try {
        const url = new URL(profile.avatarUrl, `${this.serverUrl}/`);
        const imageData = /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(url.href) && url.href.length <= 1024 * 1024;
        if ((['http:', 'https:'].includes(url.protocol) || imageData) && !url.username && !url.password) { avatarUrl = url.toString(); }
      } catch { /* An invalid avatar does not invalidate the account. */ }
    }
    return {
      serverUrl: this.serverUrl, accessToken: connection.accessToken,
      ...(connection.memoryToken ? { memoryToken: connection.memoryToken } : {}),
      user: { userId: profile.userId, email: profile.email, displayName: profile.displayName, avatarUrl },
      apiKeyId: me.principal.apiKeyId, expiresAt: me.principal.expiresAt,
    };
  }

  async login(email: string, password: string): Promise<LoginSession> {
    if (!email.trim() || !password) { throw new AuthError(t("Enter your email and password.")); }
    let sessionCookie: string | undefined;
    const result = await this.request<LoginResponse>('/api/auth/login', {
      body: { email: email.trim(), password, source: 'desktop', clientName: 'SteamHarness Studio' },
      headersReceived: (headers) => {
        const cookies = headers.getSetCookie?.() ?? [];
        sessionCookie = cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ') || undefined;
      },
    });
    if (!result.authenticated || !result.accessToken || !result.apiKey?.id) {
      throw new AuthError(t("The server did not return desktop sign-in credentials."));
    }
    try { return { ...await this.verify({ serverUrl: this.serverUrl, accessToken: result.accessToken, memoryToken: result.memoryToken }), sessionCookie }; }
    catch (error) {
      if (sessionCookie) {
        await this.request(`/api/auth/api-keys/${encodeURIComponent(result.apiKey.id)}`, { sessionCookie, method: 'DELETE' }).catch(() => undefined);
        await this.request('/api/auth/logout', { sessionCookie, method: 'POST' }).catch(() => undefined);
      }
      throw error;
    }
  }

  systemAiUsage(connection: Connection): Promise<SystemAiUsage> {
    if (!connection.aiServerUrl || !connection.aiAccessToken) { throw new AuthError(t('System AI is unavailable.')); }
    const aiClient = new ServerClient(connection.aiServerUrl, this.fetcher);
    return aiClient.request('/api/ai/usage', { accessToken: connection.aiAccessToken });
  }

  async resource(connection: Connection, kind: string, target: Record<string, string>): Promise<unknown> {
    if (normalizeProjectServerUrl(connection.serverUrl) !== this.serverUrl || !target.projectId) { throw new AuthError('Invalid resource server or project.'); }
    const prefix = `/api/projects/${encodeURIComponent(target.projectId)}`;
    const auth = { accessToken: connection.accessToken };
    if (kind === 'knowledge') {
      return this.request(`${prefix}/knowledge-documents${target.documentId ? `/${encodeURIComponent(target.documentId)}` : '?pageSize=100'}`, auth);
    }
    if (kind === 'kv') {
      const query = new URLSearchParams({ scope: target.scope === 'conversation' ? 'conversation' : 'project' });
      if (target.conversationId) { query.set('conversationId', target.conversationId); }
      if (target.key) { query.set('key', target.key); }
      else { query.set('pageSize', '100'); }
      return this.request(`${prefix}/kv${target.key ? '/entry' : ''}?${query}`, auth);
    }
    if (kind === 'file') {
      const result = await this.request<{ files: { path: string; content: string; encoding?: string }[] }>(`${prefix}/files?target=${encodeURIComponent(target.target || 'latest')}&includeBinary=true`, auth);
      const file = result.files.find((file) => file.path === target.filePath);
      if (!file) { throw new AuthError(t("File does not exist.")); }
      return file;
    }
    if (kind === 'project' || kind === 'kanban') { return this.request(`${prefix}/structure`, auth); }
    throw new AuthError('Unsupported resource type.');
  }

  async revoke(session: LoginSession): Promise<void> {
    const auth = session.sessionCookie ? { sessionCookie: session.sessionCookie } : { accessToken: session.accessToken };
    // API keys cannot manage keys; revoke with the password-login session.
    if (session.sessionCookie) {
      await this.request(`/api/auth/api-keys/${encodeURIComponent(session.apiKeyId)}`, { ...auth, method: 'DELETE' });
    }
    await this.request('/api/auth/logout', { ...auth, method: 'POST' });
  }
}

interface SecretStore {
  get(): PromiseLike<string | undefined>;
  store(value: string): PromiseLike<void>;
  delete(): PromiseLike<void>;
}

export class Account {
  private session?: LoginSession;
  private verified = false;
  private stored?: string;
  private initialized = false;
  private epoch = 0;
  private writes = Promise.resolve();
  private verification?: { epoch: number; promise: Promise<void> };
  private state: AccountState;
  private aiConnection?: { serverUrl: string; accessToken: string };

  constructor(
    serverUrl: string, private readonly secrets: SecretStore,
    private readonly onChange: (state: AccountState) => void,
    private readonly client = (url: string) => new ServerClient(url),
  ) {
    this.state = { status: 'signed-out', serverUrl: normalizeProjectServerUrl(serverUrl), revision: 0 };
  }

  getState(): AccountState { return { ...this.state, user: this.state.user && { ...this.state.user } }; }
  getSession(): LoginSession | undefined { return this.verified ? this.session : undefined; }
  getConnection(): Connection | undefined {
    const session = this.getSession();
    return session ? { serverUrl: session.serverUrl, accessToken: session.accessToken, ...(session.memoryToken ? { memoryToken:session.memoryToken } : {}),
      ...(this.aiConnection ? { aiServerUrl: this.aiConnection.serverUrl, aiAccessToken: this.aiConnection.accessToken } : {}) } : undefined;
  }

  setAiConnection(connection: { serverUrl: string; accessToken: string } | undefined): void {
    if (connection && (typeof connection.accessToken !== 'string' || !connection.accessToken || connection.accessToken.length > 16_384)) {
      throw new AuthError(t('Invalid AI login.'));
    }
    const next = connection
      ? { serverUrl: normalizeProjectServerUrl(connection.serverUrl), accessToken: connection.accessToken }
      : undefined;
    if (next?.serverUrl === this.aiConnection?.serverUrl && next?.accessToken === this.aiConnection?.accessToken) { return; }
    this.aiConnection = next;
    this.state = { ...this.state, aiServerUrl: this.aiConnection?.serverUrl, aiConfigured: this.aiConnection !== undefined, revision: this.state.revision + 1 };
    this.onChange(this.getState());
  }

  private update(status: AccountState['status'], error?: string): void {
    this.state = { status, serverUrl: this.state.serverUrl, aiServerUrl: this.aiConnection?.serverUrl,
      aiConfigured: this.aiConnection !== undefined, user: this.session?.user, expiresAt: this.session?.expiresAt, error, revision: this.state.revision + 1 };
    this.onChange(this.getState());
  }

  private async save(session: LoginSession | undefined, epoch: number): Promise<void> {
    this.writes = this.writes.catch(() => undefined).then(async () => {
      if (epoch !== this.epoch) { return; }
      const encoded = session ? JSON.stringify(session) : undefined;
      const previous = this.stored;
      if (this.initialized && encoded === previous) { return; }
      this.initialized = true;
      this.stored = encoded;
      try {
        if (encoded) { await this.secrets.store(encoded); }
        else { await this.secrets.delete(); }
      } catch (error) { this.stored = previous; throw error; }
    });
    await this.writes;
  }

  async restore(): Promise<void> {
    const readingEpoch = this.epoch;
    await this.writes.catch(() => undefined);
    const encoded = await this.secrets.get();
    if (readingEpoch !== this.epoch) { return; }
    if (this.initialized && encoded === this.stored) { return; }
    this.initialized = true;
    this.stored = encoded;
    const epoch = ++this.epoch;
    const previous = this.getSession();
    this.session = undefined;
    this.verified = false;
    if (!encoded) { this.aiConnection = undefined; this.update('signed-out'); return; }
    try {
      const saved = JSON.parse(encoded) as LoginSession;
      if (typeof saved.accessToken !== 'string' || !saved.accessToken || normalizeProjectServerUrl(saved.serverUrl) !== this.state.serverUrl) {
        this.aiConnection = undefined;
        await this.save(undefined, epoch); this.update('signed-out'); return;
      }
      if (saved.expiresAt && Date.parse(saved.expiresAt) <= Date.now()) {
        this.aiConnection = undefined;
        await this.save(undefined, epoch); this.update('expired', t("Sign-in expired. Sign in again.")); return;
      }
      if (previous && !sameProjectAccount(previous, saved)) this.aiConnection = undefined;
      this.session = saved;
      this.verified = previous?.serverUrl === saved.serverUrl && previous.accessToken === saved.accessToken;
      // Shared-secret notifications must not start a write/restore loop across windows.
      await this.verifySession(false);
    } catch {
      if (epoch !== this.epoch) { return; }
      this.session = undefined;
      this.verified = false;
      this.aiConnection = undefined;
      await this.save(undefined, epoch);
      this.update('signed-out');
    }
  }

  async login(serverUrl: string, email: string, password: string): Promise<void> {
    const url = normalizeProjectServerUrl(serverUrl);
    const epoch = ++this.epoch;
    this.update('checking');
    try {
      const session = await this.client(url).login(email, password);
      if (epoch !== this.epoch) { await this.client(url).revoke(session).catch(() => undefined); return; }
      try { await this.save(session, epoch); }
      catch (error) { await this.client(url).revoke(session).catch(() => undefined); throw error; }
      if (epoch !== this.epoch) { await this.client(url).revoke(session).catch(() => undefined); return; }
      const previous = this.session;
      this.session = session;
      this.verified = true;
      this.state.serverUrl = url;
      if (!previous || !sameProjectAccount(previous, session)) this.aiConnection = undefined;
      this.update('authenticated');
      if (previous && previous.accessToken !== session.accessToken) { await this.client(previous.serverUrl).revoke(previous).catch(() => undefined); }
    } catch (error) {
      if (epoch === this.epoch) { this.update('error', error instanceof Error ? error.message : t("Sign-in failed.")); }
      throw error;
    }
  }

  async verify(): Promise<void> {
    await this.verifySession(true);
  }

  async refresh(): Promise<void> {
    if (this.verified && this.state.status !== 'checking') { await this.verifySession(true, true); }
  }

  private async verifySession(persist: boolean, background = false): Promise<void> {
    if (this.verification?.epoch === this.epoch) { return this.verification.promise; }
    const session = this.session;
    if (!session) { this.update('signed-out'); return; }
    const epoch = ++this.epoch;
    if (!background) { this.update('checking'); }
    const promise = (async () => {
      try {
        const verified = { ...await this.client(session.serverUrl).verify(session), sessionCookie: session.sessionCookie };
        if (epoch !== this.epoch) { return; }
        if (persist) { await this.save(verified, epoch); }
        if (epoch !== this.epoch) { return; }
        const changed = JSON.stringify(verified) !== JSON.stringify(session);
        this.session = verified;
        this.verified = true;
        if (!background || changed || this.state.status !== 'authenticated') { this.update('authenticated'); }
      } catch (error) {
        if (epoch !== this.epoch) { return; }
        if (error instanceof AuthError && error.status === 401) {
          this.session = undefined;
          this.verified = false;
          this.aiConnection = undefined;
          await this.save(undefined, epoch);
          if (epoch === this.epoch) { this.update('expired', error.message); }
        } else if (!background) { this.update('error', error instanceof Error ? error.message : t("Account verification failed.")); }
      }
    })();
    this.verification = { epoch, promise };
    try { await promise; }
    finally { if (this.verification?.epoch === epoch) { this.verification = undefined; } }
  }

  async invalidate(connection: Connection): Promise<void> {
    if (this.session?.accessToken !== connection.accessToken || this.session.serverUrl !== connection.serverUrl) { return; }
    const epoch = ++this.epoch;
    this.session = undefined;
    this.verified = false;
    this.aiConnection = undefined;
    await this.save(undefined, epoch);
    if (epoch === this.epoch) { this.update('expired', t("Sign-in expired. Sign in again.")); }
  }

  async logout(revoke = true): Promise<void> {
    const session = this.session;
    const epoch = ++this.epoch;
    this.session = undefined;
    this.verified = false;
    this.aiConnection = undefined;
    await this.save(undefined, epoch);
    if (epoch === this.epoch) { this.update('signed-out'); }
    if (session && revoke) {
      try { await this.client(session.serverUrl).revoke(session); }
      catch { /* Local sign-out must still work when the server is unavailable. */ }
    }
  }

  async changeServer(serverUrl: string): Promise<void> {
    const url = normalizeProjectServerUrl(serverUrl);
    if (url === this.state.serverUrl) { return; }
    await this.logout(false);
    this.state.serverUrl = url;
    this.update('signed-out');
  }
}

function sameProjectAccount(left: LoginSession, right: LoginSession): boolean {
  return left.serverUrl === right.serverUrl && left.user.userId === right.user.userId;
}

export function projectAuthEnvironment(
  base: Record<string, string | undefined>, connection: Connection | undefined, authDirectory: string,
): Record<string, string | undefined> {
  const cleanBase = sanitizeProjectEnvironment(base);
  delete cleanBase.STEAMHARNESS_LLM_SERVER_URL;
  delete cleanBase.STEAMHARNESS_LLM_SERVER_TOKEN;
  return {
    ...cleanBase, STEAMHARNESS_CLI_AUTH_DIR: authDirectory,
    STEAMHARNESS_SERVER_URL: connection?.serverUrl ?? '', STEAMHARNESS_SERVER_ADMIN_KEY: connection?.accessToken ?? '', STEAMHARNESS_SERVER_TOKEN: '',
    STEAMHARNESS_AI_SERVER_URL: connection?.aiServerUrl ?? '', STEAMHARNESS_AI_API_KEY: connection?.aiAccessToken ?? '',
  };
}
