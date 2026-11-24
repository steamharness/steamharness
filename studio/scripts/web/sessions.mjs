import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const PAIR_MS = 5 * 60_000;
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const digest = value => createHash('sha256').update(value).digest();
export const secret = () => randomBytes(32).toString('base64url');
export const isSecret = value => typeof value === 'string' && /^[\w-]{43}$/.test(value);
export const equalSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(digest(a), digest(b));

export async function writePrivate(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export async function openSessions(directory, onEnd, now = Date.now) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'paired-devices.json');
  const sessions = new Map();
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.devices)) throw new Error('Unsupported Studio Web device store.');
    for (const device of saved.devices) {
      if (device.expiresAt > now()) sessions.set(device.hash, device);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  let pair, expires;
  let pending = Promise.resolve();
  const cookieHash = token => digest(token).toString('hex');
  const publicly = ({ hash: _, origin: __, ...device }) => device;
  function save() {
    const snapshot = { version: 1, devices: [...sessions.values()] };
    const write = pending.then(() => writePrivate(file, snapshot));
    pending = write.catch(() => undefined);
    return write;
  }
  function remove(device) {
    sessions.delete(device.hash);
    onEnd(device.id);
  }
  function schedule() {
    clearTimeout(expires);
    const deadline = Math.min(...[...sessions.values()].map(device => device.expiresAt));
    if (Number.isFinite(deadline)) expires = setTimeout(() => {
      let changed = false;
      for (const device of sessions.values()) if (device.expiresAt <= now()) { remove(device); changed = true; }
      if (changed) void save().catch(() => undefined);
      schedule();
    }, Math.max(1, Math.min(2 ** 31 - 1, deadline - now()))).unref();
  }
  schedule();

  return {
    issue(origin) {
      const code = [...randomBytes(12)].map(value => alphabet[value % alphabet.length]).join('').match(/.{4}/g).join('-');
      pair = { hash: digest(code.replaceAll('-', '')), expiresAt: now() + PAIR_MS, origin };
      return { code, expiresAt: pair.expiresAt };
    },
    async redeem(input, origin, userAgent) {
      const code = typeof input === 'string' && input.length <= 32 ? input.trim().toUpperCase().replace(/[\s-]/g, '') : '';
      if (!pair || pair.expiresAt <= now() || pair.origin !== origin || !timingSafeEqual(pair.hash, digest(code))) return;
      // Invalidate before the first asynchronous boundary, even if storing fails.
      pair = undefined;
      if (sessions.size >= 128) return;
      const token = secret(), hash = cookieHash(token), issued = now();
      const device = { id: randomUUID(), hash, origin, label: deviceLabel(userAgent), createdAt: issued, lastSeenAt: issued,
        expiresAt: issued + SESSION_SECONDS * 1000 };
      sessions.set(hash, device);
      try { await save(); }
      catch (error) { remove(device); throw error; }
      schedule();
      return token;
    },
    check(token, origin) {
      if (!isSecret(token)) return;
      const device = sessions.get(cookieHash(token)), time = now();
      if (!device || device.origin !== origin || device.expiresAt <= time) return;
      if (time - device.lastSeenAt >= 60_000) {
        device.lastSeenAt = time;
        void save().catch(() => undefined);
      }
      return device;
    },
    has(id) { return [...sessions.values()].some(device => device.id === id && device.expiresAt > now()); },
    pairExpiresAt: () => pair && pair.expiresAt > now() ? pair.expiresAt : undefined,
    list: () => [...sessions.values()].filter(device => device.expiresAt > now()).map(publicly).sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    async revoke(id) {
      const device = [...sessions.values()].find(device => device.id === id);
      if (!device) return;
      remove(device); schedule(); await save();
    },
    async close() { clearTimeout(expires); pair = undefined; await pending; },
  };
}

function deviceLabel(value = '') {
  const ua = value.slice(0, 512);
  const browser = /(?:Edg|EdgA|EdgiOS)\//.test(ua) ? 'Edge' : /(?:Firefox|FxiOS)\//.test(ua) ? 'Firefox' :
    /(?:Chrome|CriOS)\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : undefined;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' :
    /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : undefined;
  return [browser, os].filter(Boolean).join(' · ');
}
