import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';

const prefix = 'STEAMHARNESS_STUDIO_WEB_';
export function portRange(raw, name) {
  const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(raw);
  const first = Number(match?.[1]), last = Number(match?.[2] ?? match?.[1]);
  if (!match || first < 1 || last > 65_535 || last < first || last - first > 100) throw new Error(`Invalid ${name}.`);
  return { first, last };
}

export async function webConfig(env = process.env, localPort) {
  const get = key => env[prefix + key]?.trim() || undefined;
  const parseOrigin = key => {
    const value = get(key);
    let url;
    try { url = new URL(value); } catch { /* Report the setting, not its value. */ }
    if (!url || url.protocol !== 'https:' || ![url.origin, `${url.origin}/`].includes(value) ||
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error(`${prefix}${key} must be an HTTPS origin without a path or credentials.`);
    return url;
  };
  const remote = (type, previewOptional = false) => {
    const workbench = parseOrigin(`${type}_ORIGIN`), previewKey = `${type}_PREVIEW_ORIGIN`;
    const preview = !previewOptional || get(previewKey) ? parseOrigin(previewKey) : undefined;
    if (workbench.hostname === preview?.hostname) throw new Error(`${prefix}${previewKey} must use a different hostname than the workbench.`);
    return { workbench, preview };
  };
  const local = portRange(localPort ?? get('LOCAL_PORT') ?? '3030-3040', prefix + 'LOCAL_PORT');
  let proxy, lan;
  if (['PROXY_ORIGIN', 'PROXY_PREVIEW_ORIGIN', 'PROXY_PORT'].some(get)) {
    const port = portRange(get('PROXY_PORT') ?? '3041', prefix + 'PROXY_PORT');
    if (port.first !== port.last || port.first >= local.first && port.first <= local.last) throw new Error(`${prefix}PROXY_PORT must be outside the local port range.`);
    proxy = { ...remote('PROXY', true), host: '127.0.0.1', port: port.first };
  }
  if (['LAN_HOST', 'LAN_ORIGIN', 'LAN_PREVIEW_ORIGIN', 'TLS_CERT_FILE', 'TLS_KEY_FILE'].some(get)) {
    const host = get('LAN_HOST');
    if (isIP(host) !== 4 || host.startsWith('127.')) throw new Error(`${prefix}LAN_HOST must be a non-loopback IPv4 address (or 0.0.0.0).`);
    const origins = remote('LAN');
    const ports = [origins.workbench, origins.preview].map(value => Number(value.port || 443));
    if (ports.some(port => port >= local.first && port <= local.last || port === proxy?.port) ||
        [origins.workbench, origins.preview].some(origin => [proxy?.workbench, proxy?.preview].some(proxyOrigin => origin.hostname === proxyOrigin?.hostname))) {
      throw new Error('Studio Web listener ports or origins overlap.');
    }
    let cert, key;
    try { [cert, key] = await Promise.all([readFile(get('TLS_CERT_FILE')), readFile(get('TLS_KEY_FILE'))]); }
    catch { throw new Error(`Set readable ${prefix}TLS_CERT_FILE and ${prefix}TLS_KEY_FILE files for LAN HTTPS.`); }
    lan = { ...origins, host, ports: [...new Set(ports)], tls: { cert, key } };
  }
  return { local, proxy, lan };
}
