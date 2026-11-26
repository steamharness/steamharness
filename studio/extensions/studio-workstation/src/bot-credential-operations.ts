import { parseBotCredentialSlot } from '../../../../harness/src/types/bot-credential';
import type { BotCredentialHostResult, BotCredentialHostUse, BotCredentialUseOperation } from '../../../../harness/src/types/bot-credential-use';
import type { BotCredentialSlot } from './bot-credential-vault';
import { runBotCredentialHttpQuery, type StoredHttpCredential } from './bot-credential-http';
import { runBotCredentialSshQuery } from './bot-credential-ssh';
import { botCredentialCommandSupported, runBotCredentialCommand, type BotCredentialCommand } from './bot-credential-command';
import { t } from './localization';

type TextKind = 'api-key' | 'password';
type FieldsKind = 'structured' | 'access-key-pair';
export type BotCredentialHttpAuth =
  | { kind: TextKind; scheme: 'bearer' }
  | { kind: TextKind; scheme: 'basic'; username: string }
  | { kind: TextKind; scheme: 'header'; header: string }
  | { kind: FieldsKind; scheme: 'bearer'; field: string }
  | { kind: FieldsKind; scheme: 'basic'; usernameField: string; passwordField: string }
  | { kind: FieldsKind; scheme: 'headers'; headers: Record<string, string> };
export type BotCredentialHttpRequest = { url: string; auth: BotCredentialHttpAuth };
export type BotCredentialSshRequest = { host: string; port: number; username: string; fingerprint: string; passphraseAlias?: string }
  & ({ operation: 'authenticate' } | { operation: 'list-directory'; path: string });

export const botCredentialTransports = { https: runBotCredentialHttpQuery, ssh: runBotCredentialSshQuery };

interface PreparedUse {
  delivery?: 'command';
  target: string;
  detail: string;
  binding: object;
  slots: readonly BotCredentialSlot[];
  run(values: readonly StoredHttpCredential[], signal: AbortSignal, cwd: string): Promise<BotCredentialHostResult>;
}

type RegistryEntry = BotCredentialUseOperation & { prepare(use: BotCredentialHostUse, transports: typeof botCredentialTransports): PreparedUse | { list: true; query?: string } };
const invalid = () => new Error('Invalid Studio credential operation.');
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const only = (value: Record<string, unknown>, ...keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const hostName = (name: string) => name.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label)) && !/(?:^|\.)localhost$/i.test(name);
const fieldNames = (...fields: unknown[]) => parseBotCredentialSlot({ name: 'fields', kind: 'structured', fields });

// Custom authentication headers cannot override method, routing, or framing.
const forbiddenHeaders = /^(?:host|connection|accept(?:-.+)?|content(?:-.+)?|cookie2?|te|trailer|transfer-encoding|upgrade|expect|forwarded|via|referer|origin|sudo|proxy-.+|sec-.+|x-(?:forwarded-.+|real-ip|http-method(?:-override)?|method-override|original-.+|rewrite-.+))$/i;
function headerName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/i.test(value) || forbiddenHeaders.test(value)) throw invalid();
  return value.toLowerCase();
}

function parseHttpAuth(value: unknown): BotCredentialHttpAuth {
  const auth = record(value);
  if (!auth) throw invalid();
  const { kind, scheme } = auth;
  if (kind === 'api-key' || kind === 'password') {
    if (scheme === 'bearer' && only(auth, 'kind', 'scheme')) return { kind, scheme };
    if (scheme === 'basic' && only(auth, 'kind', 'scheme', 'username') && text(auth.username, 256) && !auth.username.includes(':')) return { kind, scheme, username: auth.username };
    if (scheme === 'header' && only(auth, 'kind', 'scheme', 'header')) return { kind, scheme, header: headerName(auth.header) };
  }
  if (kind === 'structured' || kind === 'access-key-pair') {
    if (scheme === 'bearer' && only(auth, 'kind', 'scheme', 'field') && typeof auth.field === 'string') {
      fieldNames(auth.field);
      return { kind, scheme, field: auth.field };
    }
    if (scheme === 'basic' && only(auth, 'kind', 'scheme', 'usernameField', 'passwordField') && typeof auth.usernameField === 'string' && typeof auth.passwordField === 'string') {
      fieldNames(auth.usernameField, auth.passwordField);
      return { kind, scheme, usernameField: auth.usernameField, passwordField: auth.passwordField };
    }
    const headers = scheme === 'headers' && only(auth, 'kind', 'scheme', 'headers') && record(auth.headers);
    if (headers) {
      const entries = Object.entries(headers).map(([header, field]) => [headerName(header), field] as const).sort(([a], [b]) => a.localeCompare(b));
      if (!entries.length || entries.length > 16 || new Set(entries.map(([header]) => header)).size !== entries.length) throw invalid();
      fieldNames(...new Set(entries.map(([, field]) => field)));
      return { kind, scheme, headers: Object.fromEntries(entries) as Record<string, string> };
    }
  }
  throw invalid();
}

function parseHttpRequest(args: BotCredentialHostUse['args']): BotCredentialHttpRequest {
  if (!only(args, 'url', 'auth') || !text(args.url, 2048) || !/^https:\/\//i.test(args.url) || /[\\#\s]/u.test(args.url)) throw invalid();
  const url = new URL(args.url);
  if (url.protocol !== 'https:' || url.username || url.password || !hostName(url.hostname) || !url.hostname.includes('.')
    || /^\d+(?:\.\d+){3}$/.test(url.hostname) || url.port === '0' || url.href.length > 2048) throw invalid();
  return { url: url.href, auth: parseHttpAuth(args.auth) };
}

function parseSshRequest(args: BotCredentialHostUse['args'], operation: BotCredentialSshRequest['operation']): BotCredentialSshRequest {
  const { host, username, fingerprint, path } = args;
  const port = args.port === undefined ? 22 : args.port;
  if (!only(args, 'host', 'port', 'username', 'fingerprint', 'path', 'passphraseAlias') || !text(host, 253) || !hostName(host)
    || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535
    || typeof username !== 'string' || !/^[a-z\d_.-]{1,64}$/i.test(username)
    || typeof fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw invalid();
  const common = { host: host.toLowerCase(), port, username, fingerprint,
    ...(args.passphraseAlias !== undefined && { passphraseAlias: parseBotCredentialSlot({ name: args.passphraseAlias, kind: 'password' }).name }) };
  if (operation === 'authenticate' && path === undefined) return { ...common, operation };
  if (operation === 'list-directory' && text(path, 1024)) return { ...common, operation, path };
  throw invalid();
}

function sshOperation(operation: BotCredentialSshRequest['operation']): RegistryEntry {
  return {
    id: `ssh.${operation}`,
    description: `${operation === 'authenticate' ? 'Check SSH public-key authentication.' : 'List an SFTP directory. Pass path to list (not a command).'} Pass host, username, optional port (default 22), and the trusted public server fingerprint SHA256:...; ask for it if unknown. Optionally pass a saved password alias as passphraseAlias for an encrypted key. Never obtain the expected fingerprint from the unverified connection.`,
    prepare(use, transports) {
      if (!use.name) throw invalid();
      const request = parseSshRequest(use.args, operation);
      const slots: BotCredentialSlot[] = [{ name: use.name, kind: 'ssh-private-key' }];
      if (request.passphraseAlias) slots.push({ name: request.passphraseAlias, kind: 'password' });
      const detail = [request.operation === 'authenticate' ? t('Verify SSH authentication') : t('List SFTP directory: {0}', request.path), request.username, request.fingerprint,
        ...(request.passphraseAlias ? [t('Passphrase alias: {0}', request.passphraseAlias)] : [])].join(' · ');
      return { target: `${request.host}:${request.port}`, detail, binding: request, slots,
        run: ([key, passphrase], signal) => typeof key === 'string' && (passphrase === undefined || typeof passphrase === 'string')
          ? transports.ssh(request, key, passphrase, signal) : Promise.resolve({ status: 'missing-fields' }) };
    },
  };
}

const operations: readonly RegistryEntry[] = [
  { id: 'https.get-json',
    description: 'Use this for read-only HTTPS API calls that return JSON; do not use a local command for them. Pass args {url,auth}. For a saved api-key or password, auth is {kind,scheme:"header",header}, {kind,scheme:"bearer"}, or {kind,scheme:"basic",username}. For structured or access-key-pair use {kind,scheme:"headers",headers:{HeaderName:"savedField"}}, {kind,scheme:"bearer",field}, or {kind,scheme:"basic",usernameField,passwordField}. Use only names, no secret values or credentials in the URL.',
    prepare(use, transports) {
      if (!use.name) throw invalid();
      const request = parseHttpRequest(use.args);
      // Show the approved authentication mapping as well as the exact URL.
      const { kind, scheme, ...mapping } = request.auth;
      const detail = t('HTTPS GET · {0} · {1}', scheme, [kind, ...Object.entries(mapping).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)].join(' · '));
      return { target: request.url, detail, binding: request, slots: [{ name: use.name, kind }],
        run: ([value], signal) => value === undefined ? Promise.resolve({ status: 'missing' }) : transports.https(request, value, signal) };
    } },
  sshOperation('authenticate'), sshOperation('list-directory'),
];

const scopedOperations: readonly RegistryEntry[] = [
  { id: 'vault.list', description: 'List the saved aliases and kinds for this Bot, never values. Omit name. Pass args {} or {query:"alias substring"}. Use this before guessing the alias or kind.',
    prepare(use) {
      const { query } = use.args;
      if (use.name !== undefined || !only(use.args, 'query') || query !== undefined && !text(query, 64)) throw invalid();
      return { list: true, ...(query && { query: query.toLowerCase() }) };
    } },
  ...(botCredentialCommandSupported ? [{ id: 'command.run', requiresTool: 'bash',
    description: 'Unavailable in Auto Approve. Use a host-managed query when offered. In an interactive run, pass name and args {kind,program,argv} for a command that needs explicit approval. The approved program can read the credential from the file descriptor path in STEAMHARNESS_BOT_CREDENTIAL_FILE; do not print, copy, or retain it.',
    prepare(use: BotCredentialHostUse): PreparedUse {
      const { kind, program, argv } = use.args;
      if (!use.name || !only(use.args, 'kind', 'program', 'argv')
        || !text(program, 256) || program.startsWith('-') || !Array.isArray(argv) || argv.length > 48
        || !argv.every((value): value is string => typeof value === 'string' && value.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value))) throw invalid();
      const slot: BotCredentialSlot = kind === 'access-key-pair' ? { name: use.name, kind } : parseBotCredentialSlot({ name: use.name, kind });
      const command: BotCredentialCommand = { program, args: argv };
      return { delivery: 'command', target: program, detail: t('Pass credential to local command: {0}', JSON.stringify(argv)),
        binding: { kind, ...command }, slots: [slot], run: ([value], signal, cwd) => value === undefined
          ? Promise.resolve({ status: 'missing' }) : runBotCredentialCommand(command, value, cwd, signal) };
    } }] : []),
];

export const botCredentialUseOperations = operations.map(({ id, description }) => ({ id, description }));
export const botCredentialScopedOperations = scopedOperations.map(({ id, description, requiresTool }) => ({ id, description, ...(requiresTool && { requiresTool }) }));

export function prepareBotCredentialOperation(use: BotCredentialHostUse, transports = botCredentialTransports): ReturnType<RegistryEntry['prepare']> {
  const operation = [...operations, ...scopedOperations].find(operation => operation.id === use.operation);
  if (!operation) throw invalid();
  return operation.prepare(use, transports);
}
