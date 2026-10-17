import { t } from './localization';
import { readCliAuthConfig, writeCliAuthConfig } from '../auth-config';

export async function loginWebAccount(serverUrl: string, email: string, password: string): Promise<void> {
  if (!email.trim() || !password) { throw new Error(t("Enter your email and password.")); }
  let token = '';
  let cookie = '';
  let apiKeyId = '';
  let saved = false;
  const request = async (endpoint: string, options: RequestInit = {}) => {
    const response = await fetch(`${serverUrl}${endpoint}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    const result = await response.json();
    if (!response.ok || result.errCode !== 0 || !result.data) {
      const message = response.status === 401 ? t("Incorrect email or password, or sign-in expired.") : result.errMessage || 'Workflow Server login failed.';
      throw new Error(String(message).replaceAll(password, '[redacted]').replaceAll(token || '\u0000', '[redacted]'));
    }
    return { response, data: result.data };
  };
  try {
    const result = await request('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password, source: 'cli', clientName: 'Workflow CLI Web' }),
    });
    cookie = result.response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
    token = typeof result.data.accessToken === 'string' ? result.data.accessToken : '';
    apiKeyId = typeof result.data.apiKey?.id === 'string' ? result.data.apiKey.id : '';
    if (!result.data.authenticated || !token || !apiKeyId) { throw new Error('Workflow Server did not return CLI login credentials.'); }
    const { data: me } = await request('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    if (typeof me.profile?.userId !== 'string' || !me.profile.userId || typeof me.profile.email !== 'string' || typeof me.profile.displayName !== 'string') { throw new Error('Workflow Server did not return an account profile.'); }
    const existing = await readCliAuthConfig();
    await writeCliAuthConfig({ ...existing, serverUrl, apiKey: token, expiresAt: me.principal?.expiresAt ?? result.data.expiresAt, user: me.profile, source: 'password' });
    saved = true;
  } finally {
    if (cookie) {
      if (!saved && apiKeyId) { await request(`/api/auth/api-keys/${encodeURIComponent(apiKeyId)}`, { method: 'DELETE', headers: { Cookie: cookie } }).catch(() => undefined); }
      await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } }).catch(() => undefined);
    }
  }
}
