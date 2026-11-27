import { lookup, type LookupAddress } from 'node:dns';
import { BlockList } from 'node:net';
import type { BotCredentialQueryData } from '../../../../harness/src/types/bot-credential-use';

// Intranet servers can be approved by the user. Loopback, link-local (including
// cloud metadata), multicast and special-use addresses are not credential targets.
const blockedIPv4 = new BlockList(), blockedIPv6 = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 3]] as const) {
  blockedIPv4.addSubnet(address, prefix, 'ipv4');
}
// BlockList also matches IPv4 queries against IPv4-mapped IPv6 subnets.
for (const [address, prefix] of [['::', 96], ['::ffff:0:0', 96], ['fe80::', 10], ['ff00::', 8]] as const) {
  blockedIPv6.addSubnet(address, prefix, 'ipv6');
}

export class CredentialTargetBlocked extends Error {}

export async function resolveCredentialAddress(hostname: string, signal: AbortSignal): Promise<LookupAddress> {
  signal.throwIfAborted();
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    lookup(hostname, { all: true }, (error, addresses) => {
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(addresses);
    });
  });
  signal.throwIfAborted();
  const address = addresses.find(({ address, family }) => family === 4 ? !blockedIPv4.check(address, 'ipv4') : family === 6 && !blockedIPv6.check(address, 'ipv6'));
  if (!address) throw new CredentialTargetBlocked('No eligible network address for credential use.');
  return address;
}

/** Reject common reflections, including keys and encoded authorization data. */
export function containsCredentialValue(data: BotCredentialQueryData, values: string[], minSubstringLength = 4): boolean {
  // A client may trim a pasted token even though the vault preserves it verbatim.
  const normalized = new Set(values.flatMap(value => [value, value.trim()]));
  const needles = [...new Set([...normalized].flatMap(value => value ? [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'),
    new URLSearchParams({ v: value }).toString().slice(2), JSON.stringify(value).slice(1, -1)] : []))];
  const match = (text: string) => needles.some(value => value.length < minSubstringLength ? text === value : text.includes(value));
  const check = (value: BotCredentialQueryData): boolean => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return match(String(value));
    if (Array.isArray(value)) return value.some(check);
    return !!value && typeof value === 'object' && Object.entries(value).some(([key, child]) => match(key) || check(child));
  };
  return check(data);
}
