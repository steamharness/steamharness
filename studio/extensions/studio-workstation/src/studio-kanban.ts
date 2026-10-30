import { realpath } from 'node:fs/promises';
import type { WebSession } from './workflow-cli-types';

export interface StudioKanbanHost { directory: string; resourceEntryId?: string }
interface RuntimeDiagnostics {
  projectId?: string; entryId?: string; available?: boolean;
  instances?: { instanceId: string }[]; requests?: { startedAt: number }[]; previews?: unknown[];
  [key: string]: unknown;
}

/** Inspect an existing host. Its capability URL never crosses into tool output. */
export async function readStudioKanbanDiagnostics(
  sessions: ReadonlyMap<WebSession, StudioKanbanHost>,
  input: { projectDir: string; projectId: string; entryId: string; call?: unknown },
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  signal.throwIfAborted();
  const matches: { session: WebSession; resourceEntryId?: string }[] = [];
  for (const [session, host] of sessions) {
    let directory: string;
    try { directory = await realpath(host.directory); } catch { continue; }
    if (directory !== input.projectDir) continue;
    if (host.resourceEntryId) matches.push({ session, resourceEntryId: host.resourceEntryId });
    else if (session.ready.project.id === input.projectId
      && session.ready.project.entries.some(entry => entry.entryId === input.entryId && entry.type === 'kanban')) matches.push({ session });
  }
  if (!matches.length) return { available: false, reason: 'preview-not-open', projectId: input.projectId, entryId: input.entryId, instances: [], requests: [] };
  if (matches.filter(match => !match.resourceEntryId).length > 1) throw new Error('Multiple Kanban hosts match this project. Close duplicate hosts and inspect again.');
  const query = async ({ session, resourceEntryId }: typeof matches[number], call?: unknown) => {
    const url = new URL(session.ready.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) throw new Error('Invalid local Kanban host.');
    const token = new URLSearchParams(url.hash.slice(1)).get('session');
    if (!token) throw new Error('Local Kanban host has no session capability.');
    const entryId = resourceEntryId ?? input.entryId;
    const response = await fetchImpl(new URL(`/entries/${encodeURIComponent(entryId)}/api/message`, url.origin), {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, redirect: 'error',
      body: JSON.stringify(resourceEntryId ? { type: 'resource-kanban-diagnostics', applicationId: `${session.ready.project.id}:${entryId}`,
        target: { projectDir: input.projectDir, projectId: input.projectId, entryId: input.entryId, ...(call === undefined ? {} : { call }) } }
        : { type: 'kanban-diagnostics', applicationId: `${input.projectId}:${input.entryId}`, ...(call === undefined ? {} : { call }) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok) throw new Error('Kanban runtime query failed. Read diagnostics again and use a current readOnly method.');
    const result = await response.json().catch(() => { throw new Error('Kanban runtime diagnostics are unavailable. Update the project CLI and reopen its preview.'); }) as { messages?: Array<{ type?: string; value?: RuntimeDiagnostics }> };
    const value = result?.messages?.find((message: { type?: unknown }) => message.type === 'kanban-diagnostics-result')?.value;
    if (value?.projectId !== input.projectId || value?.entryId !== input.entryId) throw new Error('Kanban runtime diagnostics are unavailable. Update the project CLI and reopen its preview.');
    signal.throwIfAborted();
    return value;
  };
  if (matches.length === 1) return query(matches[0]!, input.call);
  const values = await Promise.all(matches.map(match => query(match)));
  if (input.call !== undefined) {
    const instanceId = (input.call as { instanceId?: unknown })?.instanceId;
    const owners = matches.filter((_, index) => (values[index]!.instances ?? []).some(instance => instance.instanceId === instanceId));
    if (owners.length !== 1) throw new Error('Kanban method instance changed. List instances again.');
    return query(owners[0]!, input.call);
  }
  const available = values.filter(value => value!.available);
  return { ...(available[0] ?? values[0]),
    previews: available.flatMap(value => value!.previews ?? [{ source: 'workspace', ...value }]),
    instances: available.flatMap(value => value!.instances ?? []),
    requests: available.flatMap(value => value!.requests ?? []).sort((a, b) => a.startedAt - b.startedAt).slice(-50) };
}
