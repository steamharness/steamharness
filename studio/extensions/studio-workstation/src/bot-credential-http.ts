import { request } from 'node:https';
import { BOT_CREDENTIAL_USE_MAX_DATA_BYTES, validBotCredentialQueryData, type BotCredentialHostResult } from '../../../../harness/src/types/bot-credential-use';
import { containsCredentialValue, CredentialTargetBlocked, resolveCredentialAddress } from './bot-credential-network';
import type { BotCredentialHttpRequest } from './bot-credential-operations';

export type StoredHttpCredential = string | Readonly<Record<string, string>>;

function credentialHeaders(auth: BotCredentialHttpRequest['auth'], stored: StoredHttpCredential): Record<string, string> | undefined {
  const field = (key: string) => typeof stored !== 'string' && Object.hasOwn(stored, key) ? stored[key] : undefined;
  const text = typeof stored === 'string' ? auth.kind === 'api-key' ? stored.trim() : stored : undefined;
  if (auth.scheme === 'header') return text ? { [auth.header]: text } : undefined;
  if (auth.scheme === 'bearer') {
    const token = 'field' in auth ? field(auth.field) : text;
    return token ? { authorization: `Bearer ${token}` } : undefined;
  }
  if (auth.scheme === 'basic') {
    const username = 'username' in auth ? auth.username : field(auth.usernameField);
    const password = 'passwordField' in auth ? field(auth.passwordField) : text;
    return username && !username.includes(':') && password ? { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` } : undefined;
  }
  const pairs = Object.entries(auth.headers).map(([header, key]) => [header, field(key)] as const);
  return pairs.every(([, value]) => !!value) ? Object.fromEntries(pairs) as Record<string, string> : undefined;
}

/** An exact, approved GET. No redirects, proxies, raw errors, or response headers cross the host boundary. */
export async function runBotCredentialHttpQuery(use: BotCredentialHttpRequest, stored: StoredHttpCredential, signal: AbortSignal,
  httpsRequest = request, resolveAddress = resolveCredentialAddress): Promise<BotCredentialHostResult> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  try {
    const headers = credentialHeaders(use.auth, stored);
    if (!headers) return { status: 'missing-fields' };
    if (Object.values(headers).some(value => !/^[\x20-\x7e]+$/.test(value) || value.trim() !== value)) return { status: 'failed', reason: 'invalid-credential' };
    const url = new URL(use.url);
    const { address, family } = await resolveAddress(url.hostname, deadline);
    deadline.throwIfAborted();
    return await new Promise<BotCredentialHostResult>((resolve, reject) => {
      const req = httpsRequest({ hostname: url.hostname, port: Number(url.port || 443), path: `${url.pathname}${url.search}`, method: 'GET',
        signal: deadline, agent: false, rejectUnauthorized: true,
        lookup: (_hostname, options, callback) => options.all ? callback(null, [{ address, family }]) : callback(null, address, family),
        headers: { ...headers, accept: 'application/json', 'accept-encoding': 'identity' } }, res => {
        void (async (): Promise<BotCredentialHostResult> => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status > 299) {
            res.destroy();
            return { status: status === 401 || status === 403 ? 'denied' : 'failed', reason: status >= 300 && status < 400 ? 'redirect' : 'http-error',
              ...(status >= 100 && status <= 599 && { httpStatus: status }) };
          }
          if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|\s*$)/i.test(res.headers['content-type'] ?? '')) {
            res.destroy();
            return { status: 'failed', reason: 'invalid-response', httpStatus: status };
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of res) {
            bytes += chunk.length;
            if (bytes > BOT_CREDENTIAL_USE_MAX_DATA_BYTES) return { status: 'failed', reason: 'response-too-large', httpStatus: status };
            chunks.push(chunk);
          }
          deadline.throwIfAborted();
          let body: unknown;
          try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
          catch { return { status: 'failed', reason: 'invalid-response', httpStatus: status }; }
          if (!validBotCredentialQueryData(body)) return { status: 'failed', reason: 'invalid-response', httpStatus: status };
          const data = { httpStatus: status, body };
          if (!validBotCredentialQueryData(data)) return { status: 'failed', reason: 'response-too-large', httpStatus: status };
          const values = [...(typeof stored === 'string' ? [stored] : Object.values(stored)), ...Object.values(headers),
            ...(headers.authorization?.startsWith('Basic ') || headers.authorization?.startsWith('Bearer ') ? [headers.authorization.slice(headers.authorization.indexOf(' ') + 1)] : [])];
          return containsCredentialValue(data.body, values, 1) ? { status: 'failed', reason: 'unsafe-response', httpStatus: status } : { status: 'ok', data };
        })().then(resolve, reject);
      });
      req.once('error', reject);
      req.end();
    });
  } catch (error) {
    if (deadline.aborted) return { status: 'failed', reason: 'timeout' };
    if (error instanceof CredentialTargetBlocked) return { status: 'failed', reason: 'target-blocked' };
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return { status: 'failed', reason: typeof code === 'string' && /CERT|TLS|SSL|UNABLE_TO_VERIFY/.test(code) ? 'tls' : 'network' };
  }
}
