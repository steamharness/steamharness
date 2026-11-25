import { createHash, createHmac, randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { domainToASCII } from 'node:url';
import { ALIBABA_DNS_HOST, BOT_CREDENTIAL_DNS_PAGE_SIZE, parseBotCredentialUseResult, type BotCredentialUse, type BotCredentialUseResult } from '../../../../harness/src/types/bot-credential-use';

const MAX_RESPONSE_BYTES = 256 * 1024;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const emptyPayload = sha256('');
const algorithm = 'ACS3-HMAC-SHA256';
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Read-only RPCs only; the alias and field mappings cannot choose a host, path, or method. */
export async function runBotCredentialDnsQuery(use: BotCredentialUse, stored: Readonly<Record<string, string>>, signal: AbortSignal, httpsRequest = request): Promise<BotCredentialUseResult> {
  const field = (name: string) => Object.hasOwn(stored, name) ? stored[name] : undefined;
  const key = field(use.fields.accessKeyId), secret = field(use.fields.accessKeySecret);
  const token = use.fields.securityToken === undefined ? undefined : field(use.fields.securityToken);
  if (!key || !secret || use.fields.securityToken !== undefined && !token) return { status: 'missing-fields' };
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(key) || token !== undefined && !/^[\x21-\x7e]+$/.test(token)) return { status: 'failed' };

  try {
    signal.throwIfAborted();
    const query = new URLSearchParams({ PageNumber: String(use.page), PageSize: String(BOT_CREDENTIAL_DNS_PAGE_SIZE) });
    if (use.operation === 'list-records') query.set('DomainName', use.domain);
    query.sort();
    const headers: Record<string, string> = {
      host: ALIBABA_DNS_HOST,
      'x-acs-action': use.operation === 'list-domains' ? 'DescribeDomains' : 'DescribeDomainRecords',
      'x-acs-content-sha256': emptyPayload,
      'x-acs-date': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      'x-acs-signature-nonce': randomUUID(),
      'x-acs-version': '2015-01-09',
      ...(token && { 'x-acs-security-token': token }),
    };
    const signed = Object.keys(headers).sort();
    const canonical = ['POST', '/', query.toString(), signed.map(name => `${name}:${headers[name]}\n`).join(''), signed.join(';'), emptyPayload].join('\n');
    const signature = createHmac('sha256', secret).update(`${algorithm}\n${sha256(canonical)}`).digest('hex');
    const authorization = `${algorithm} Credential=${key},SignedHeaders=${signed.join(';')},Signature=${signature}`;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const reply = await new Promise<BotCredentialUseResult>((resolve, reject) => {
      const req = httpsRequest({ hostname: ALIBABA_DNS_HOST, port: 443, path: `/?${query}`, method: 'POST', signal: deadline,
        rejectUnauthorized: true, agent: false, headers: { ...headers, authorization, accept: 'application/json', 'content-length': '0' } }, res => {
        void (async (): Promise<BotCredentialUseResult> => {
          // node:https does not follow redirects. Only the allowlisted provider receives signed headers.
          if (res.statusCode !== 200) { res.destroy(); return { status: res.statusCode === 401 || res.statusCode === 403 ? 'denied' : 'failed' }; }
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of res) {
            bytes += chunk.length;
            if (bytes > MAX_RESPONSE_BYTES) return { status: 'failed' };
            chunks.push(chunk);
          }
          const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          const total = body?.TotalCount;
          if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || body?.Code !== undefined) return { status: 'failed' };
          const rows = use.operation === 'list-domains' ? object(body?.Domains)?.Domain : object(body?.DomainRecords)?.Record;
          if (rows === undefined && total <= (use.page - 1) * BOT_CREDENTIAL_DNS_PAGE_SIZE) return { status: 'ok', page: use.page, total, rows: [] };
          if (!Array.isArray(rows) || rows.length > BOT_CREDENTIAL_DNS_PAGE_SIZE) return { status: 'failed' };

          // DNS record data can echo caller-controlled text. Do not forward vault values, signed headers, or provider errors.
          const sensitive = [...Object.values(stored), signature, authorization].flatMap(value => [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'), new URLSearchParams({ x: value }).toString().slice(2)]);
          const selected = rows.flatMap<Record<string, unknown>>(value => {
            const row = object(value);
            if (!row) return [];
            if (use.operation === 'list-domains') {
              const name = row.DomainName;
              if (typeof name !== 'string' || sensitive.some(part => name.includes(part))) return [];
              const domain = domainToASCII(name);
              return domain && !sensitive.some(part => domain.includes(part)) ? [{ domain }] : [];
            }
            const { RR: name, Type: type, Value: data, TTL: ttl } = row;
            if ([name, type, data, String(ttl)].some(text => typeof text === 'string' && sensitive.some(part => text.includes(part)))) return [];
            return [{ name, type, value: data, ttl }];
          });
          return parseBotCredentialUseResult({ status: 'ok', page: use.page, total, rows: selected }, use) ?? { status: 'failed' };
        })().then(resolve, reject);
      });
      req.once('error', reject);
      req.end();
    });
    signal.throwIfAborted();
    return reply;
  } catch { return { status: 'failed' }; }
}
