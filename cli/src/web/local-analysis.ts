import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { webProjectDataDirectory } from './kanban-data';
import type { ConversationSession, WorkflowProject } from './workflow-types';
import type { WorkflowRunRecord } from './workflow-workspace';

export interface LocalRunSummary {
  id: string; title: string; status: string; createdAt?: number; durationMs?: number; entrypointId?: string; sessionId?: string;
}
interface Activity { version: 1; projectId: string; projectType: string; pid: number; updatedAt: number; runs: Array<LocalRunSummary & { changedAt?: number }>; queued: number; queuedInputIds?: string[] }
export interface LocalAnalysisProject { id: string; name: string; folderPath: string; uri: string; inWorkspace?: boolean; projectType?: string }

const activeStatus = (status: string): boolean => ['running', 'waiting_for_input'].includes(status);
const runStatuses = new Set(['running', 'waiting_for_input', 'success', 'failed', 'aborted', 'timed_out', 'interrupted', 'unknown']);
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const timestamp = (value: unknown): number | undefined => number(value) !== undefined && Number(value) <= 8_640_000_000_000_000 ? Number(value) : undefined;
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const projectType = (value: unknown): string | undefined => typeof value === 'string' && ['workflow', 'conversation', 'kanban'].includes(value) ? value : undefined;
const sameProjectId = (value: unknown, id: string): boolean => typeof value === 'string' && value.toLowerCase() === id.toLowerCase();

function summary(value: Record<string, any>, fallback: string): LocalRunSummary {
  const status = value.pendingInput ? 'waiting_for_input' : value.status ?? value.report?.status;
  return { id: String(value.id ?? value.runId ?? fallback), title: typeof value.title === 'string' ? value.title : fallback,
    status: typeof status === 'string' && runStatuses.has(status) ? status : 'unknown',
    createdAt: timestamp(value.createdAt), durationMs: number(value.durationMs ?? value.report?.durationMs),
    entrypointId: typeof value.entrypointId === 'string' ? value.entrypointId : undefined,
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}) };
}

export function summarizeLocalRuns(runs?: WorkflowRunRecord[], sessions?: ConversationSession[]): LocalRunSummary[] {
  if (runs) { return runs.map(run => summary(run, run.id)); }
  return (sessions ?? []).flatMap(session => session.messages.flatMap((message, index) => message.role !== 'assistant' ? []
    : [{ ...summary({ ...message, createdAt: message.createdAt ?? session.createdAt }, `legacy-${session.id}-${index}`), id: message.runId ?? message.id ?? `legacy-${session.id}-${index}`, title: session.title, sessionId: session.id }]));
}

// A separate lease per service keeps another Studio window's live status intact.
export function createLocalActivityWriter(directory: string, project: Pick<WorkflowProject, 'id' | 'projectType'>,
  state: () => { runs: LocalRunSummary[]; queued: number; queuedInputIds?: string[] }, log: (message: string) => void) {
  const filename = path.join(directory, 'activity', `${randomUUID()}.json`);
  // Idle windows must not republish runs completed or deleted by another window.
  const runVersion = (run: LocalRunSummary): string => JSON.stringify([run.status, run.durationMs]);
  const runVersions = new Map(state().runs.map(run => [run.id, runVersion(run)]));
  const changedRuns = new Map<string, number>();
  let closed = false, metadataPublished = false, pending = Promise.resolve();
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  const publish = (): Promise<void> => {
    if (closed) { return pending; }
    const current = state();
    for (const run of current.runs) {
      const version = runVersion(run);
      if (runVersions.get(run.id) !== version) { changedRuns.set(run.id, performance.timeOrigin + performance.now()); runVersions.set(run.id, version); }
    }
    const value: Activity = { version: 1, projectId: project.id, projectType: project.projectType, pid: process.pid, updatedAt: Date.now(),
      runs: current.runs.filter(run => activeStatus(run.status) || changedRuns.has(run.id))
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).filter((run, index) => index < 100 || activeStatus(run.status))
        .map(run => ({ ...run, changedAt: changedRuns.get(run.id) })),
      queued: current.queued, queuedInputIds: current.queuedInputIds };
    pending = pending.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(filename), { recursive: true });
      if (!metadataPublished) {
        const temp = `${filename}.metadata.tmp`;
        await writeFile(temp, JSON.stringify({ version: 1, projectId: project.id, projectType: project.projectType }), { mode: 0o600 });
        await rename(temp, path.join(directory, 'project.json')); metadataPublished = true;
      }
      const temp = `${filename}.tmp`;
      await writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await rename(temp, filename);
    });
    return pending;
  };
  const changed = (): void => {
    if (closed || changeTimer) return;
    changeTimer = setTimeout(() => { changeTimer = undefined; void publish().catch(error => log(`Local activity: ${String(error)}`)); }, 150);
  };
  const timer = setInterval(changed, 5_000); timer.unref();
  return { publish, changed, close: async () => { closed = true; clearInterval(timer); clearTimeout(changeTimer); await pending.catch(() => undefined); await rm(filename, { force: true }); } };
}

async function readJson(filename: string): Promise<any | undefined> {
  try {
    if ((await stat(filename)).size > 64 * 1024 * 1024) { throw new Error('History exceeds the analysis read limit.'); }
    return JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error; }
}
function alive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) { return false; }
  try { process.kill(Number(pid), 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export async function readLocalStudioAnalysis(options: { storageDir: string; projects: LocalAnalysisProject[]; locale?: string; now?: number }) {
  const now = options.now ?? Date.now(), seen = new Set<string>();
  let serverExcluded = 0;
  const projects = [];
  for (const reference of [...options.projects].sort((a, b) => Number(!!b.inWorkspace) - Number(!!a.inWorkspace))) {
    const project = { ...reference, projectType: reference.projectType ?? 'unknown', availability: 'available', live: false, queued: 0, runs: [] as LocalRunSummary[] };
    try {
      const directory = await realpath(reference.folderPath);
      if (seen.has(directory)) { continue; } seen.add(directory);
      project.folderPath = directory;
      const manifest = await readJson(path.join(directory, 'package.json'));
      if (!sameProjectId(manifest?.id, reference.id)) { throw new Error('Project identity changed.'); }
      if (manifest.workflowCode?.projectInfo?.dataStorage?.mode === 'server') { serverExcluded++; continue; }
      const names = manifest.workflowCode?.projectInfo?.localizedNames;
      const language = options.locale?.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
      const name = record(names) ? Object.entries(names).find(([key]) => key.toLowerCase() === language)?.[1] : undefined;
      project.name = typeof name === 'string' && name.trim() ? name : typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name : reference.name;
      const root = webProjectDataDirectory(options.storageDir, directory);
      const metadata = await readJson(path.join(root, 'project.json'));
      const type = manifest.workflowCode?.kanban ? 'kanban' : projectType(reference.projectType) ?? projectType(manifest.workflowCode?.projectType)
        ?? (metadata?.version === 1 && sameProjectId(metadata.projectId, reference.id) ? projectType(metadata.projectType) : undefined);
      const workspace = type === 'conversation' || type === 'kanban' ? undefined : await readJson(path.join(root, 'runs.json'));
      const conversations = type !== 'kanban' && !workspace ? await readJson(path.join(root, 'conversations.json')) : undefined;
      if (workspace !== undefined && (!record(workspace) || workspace.version !== 1 || !Array.isArray(workspace.runs) || !workspace.runs.every((run: any) => record(run) && typeof run.id === 'string' && run.id))) { throw new Error('Invalid run history.'); }
      if (conversations !== undefined && (!record(conversations) || !Array.isArray(conversations.sessions) || conversations.sessions.some((session: any) => !record(session)
        || typeof session.id !== 'string' || !session.id || typeof session.title !== 'string' || !Array.isArray(session.messages)
        || !session.messages.every((message: any) => record(message) && ['user', 'assistant'].includes(message.role))))) { throw new Error('Invalid conversation history.'); }
      const historyModifiedAt = workspace || conversations ? (await stat(path.join(root, workspace ? 'runs.json' : 'conversations.json'))
        .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; }))?.mtimeMs ?? 0 : 0;
      project.projectType = type ?? (workspace ? 'workflow' : conversations ? 'conversation' : 'unknown');
      const runs = new Map(summarizeLocalRuns(workspace?.runs, conversations?.sessions).map(run => [run.id, run]));
      const leases: Activity[] = [];
      for (const file of await readdir(path.join(root, 'activity')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })) {
        if (!file.endsWith('.json')) { continue; }
        try {
          const lease = await readJson(path.join(root, 'activity', file));
          if (lease?.version === 1 && sameProjectId(lease.projectId, reference.id) && projectType(lease.projectType)
            && (project.projectType === 'unknown' || lease.projectType === project.projectType) && Array.isArray(lease.runs)
            && lease.runs.every((run: any) => record(run) && typeof run.id === 'string' && run.id && typeof run.status === 'string')) { leases.push(lease); }
        } catch { /* A malformed or concurrently removed lease cannot prove liveness. */ }
      }
      const live = leases.filter(lease => number(lease.updatedAt) !== undefined && now - lease.updatedAt >= -5_000 && now - lease.updatedAt <= 20_000 && alive(lease.pid));
      const queuedInputs = new Set<string>();
      for (const lease of live.sort((a, b) => a.updatedAt - b.updatedAt)) {
        project.projectType = lease.projectType;
        if (Array.isArray(lease.queuedInputIds) && lease.queuedInputIds.every(id => typeof id === 'string')) {
          for (const id of lease.queuedInputIds) queuedInputs.add(id);
        } else { project.queued += number(lease.queued) ?? 0; }
        for (const run of lease.runs) {
          if (!activeStatus(run.status) && (number(run.changedAt) === undefined || run.changedAt! < historyModifiedAt)) { continue; }
          if (!activeStatus(run.status) && live.some(other => other.runs.some(item => item.id === run.id && activeStatus(item.status)))) { continue; }
          runs.set(run.id, summary(run, run.id));
        }
      }
      project.queued += queuedInputs.size;
      project.live = live.length > 0;
      for (const run of runs.values()) {
        if (run.status === 'running' && !live.some(lease => lease.runs.some(item => item.id === run.id && item.status === 'running'))) {
          run.status = leases.some(lease => Number.isSafeInteger(lease.pid) && lease.pid > 0 && !alive(lease.pid)
            && lease.runs.some(item => item.id === run.id)) ? 'interrupted' : 'unknown';
        }
      }
      project.runs = [...runs.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    } catch (error) {
      project.availability = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
    }
    projects.push(project);
  }
  return { version: 1, generatedAt: now, serverExcluded, projects };
}

export async function requestStudioAnalysis(env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<unknown> {
  const unavailable = () => Object.assign(new Error('Local Studio analysis is unavailable in this host.'), { code: 'KANBAN_BRIDGE_UNAVAILABLE' });
  if (!env.WORKFLOW_STUDIO_CONTROL_BRIDGE_URL || !env.WORKFLOW_STUDIO_CONTROL_BRIDGE_TOKEN) { throw unavailable(); }
  let url: URL;
  try { url = new URL(env.WORKFLOW_STUDIO_CONTROL_BRIDGE_URL); } catch { throw unavailable(); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/studio-control' || url.username || url.password || url.search || url.hash) { throw unavailable(); }
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${env.WORKFLOW_STUDIO_CONTROL_BRIDGE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'studio.analysis.get', input: {}, permissionPolicy: 'read-only' }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000), redirect: 'error' });
  const result = await response.json();
  if (!response.ok || result.ok !== true) { throw unavailable(); }
  return result.value;
}
