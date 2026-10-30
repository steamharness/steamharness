import { realpath } from 'node:fs/promises';
import type { WebSession } from './workflow-cli-types';

/** Inspect an existing host. Its capability URL never crosses into tool output. */
export async function readStudioKanbanDiagnostics(
  sessions: ReadonlyMap<WebSession, string>,
  input: { projectDir: string; projectId: string; entryId: string; call?: unknown },
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  signal.throwIfAborted();
  const matches: WebSession[] = [];
  for (const [session, directory] of sessions) {
    if (session.ready.project.id === input.projectId && await realpath(directory) === input.projectDir
      && session.ready.project.entries.some(entry => entry.entryId === input.entryId && entry.type === 'kanban')) matches.push(session);
  }
  if (!matches.length) return { available: false, reason: 'preview-not-open', projectId: input.projectId, entryId: input.entryId, instances: [], requests: [] };
  if (matches.length !== 1) throw new Error('Multiple Kanban hosts match this project. Close duplicate hosts and inspect again.');
  const url = new URL(matches[0].ready.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) throw new Error('Invalid local Kanban host.');
  const token = new URLSearchParams(url.hash.slice(1)).get('session');
  if (!token) throw new Error('Local Kanban host has no session capability.');
  const response = await fetchImpl(new URL(`/entries/${encodeURIComponent(input.entryId)}/api/message`, url.origin), {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, redirect: 'error',
    body: JSON.stringify({ type: 'kanban-diagnostics', applicationId: `${input.projectId}:${input.entryId}`, ...(input.call === undefined ? {} : { call: input.call }) }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) throw new Error('Kanban runtime query failed. Read diagnostics again and use a current readOnly method.');
  const result = await response.json().catch(() => { throw new Error('Kanban runtime diagnostics are unavailable. Update the project CLI and reopen its preview.'); }) as { messages?: Array<{ type?: string; value?: Record<string, unknown> }> };
  const value = result?.messages?.find((message: { type?: unknown }) => message.type === 'kanban-diagnostics-result')?.value;
  if (value?.projectId !== input.projectId || value?.entryId !== input.entryId) throw new Error('Kanban runtime diagnostics are unavailable. Update the project CLI and reopen its preview.');
  signal.throwIfAborted();
  return value;
}
