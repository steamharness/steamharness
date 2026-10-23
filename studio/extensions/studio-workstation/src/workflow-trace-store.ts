import { projectVersion, type Project } from './workflow-types';
import type { TracePanelState, TraceSnapshot, TraceSelection, TraceTarget, TraceRun } from './workflow-trace-types';
import type { TraceAgentAction } from './workflow-agent-types';

interface Source {
  project: Project; token: number; send?: (message: unknown) => void;
  snapshot?: TraceSnapshot; runs: Map<string, TraceRun>; requested: Set<string>; failed: Set<string>; status: string; error?: string;
  pending: Map<string, string>; actionErrors: Map<string, string>;
}
export class TraceStore {
  private projects: Project[] = [];
  private get sources(): Map<string, Source> { return this.shared.sources; }
  private get assistants(): Set<string> { return this.shared.assistants; }
  private preferred?: string;
  selection: TraceSelection = {};
  generation = 0;
  private reveal = 0;

  constructor(private readonly shared = { sources: new Map<string, Source>(), assistants: new Set<string>(), token: 0 }) {}

  /** Share live connections and cached runs while keeping each view's selection independent. */
  fork(): TraceStore {
    const store = new TraceStore(this.shared);
    store.projects = this.projects;
    return store;
  }

  update(projects: Project[], preferred?: Project): void {
    this.projects = projects.filter(project => !project.assistant && ['workflow', 'conversation'].includes(project.projectType));
    for (const [uri, source] of this.sources) {
      if (!source.project.assistant && !this.projects.some(project => project.uri === uri && project.id === source.project.id)) { this.sources.delete(uri); }
    }
    if (this.preferred !== preferred?.uri) {
      this.preferred = preferred?.uri;
      if (this.projects.some(project => project.uri === preferred?.uri)) { this.select(preferred!.uri); }
    }
    if (!this.availableProjects().some(project => project.uri === this.selection.projectUri)
      && this.selection.projectUri !== this.projects[0]?.uri) { this.select(this.projects[0]?.uri); }
  }
  availableProjects(): Project[] { return [...this.projects, ...[...this.assistants].flatMap(uri => this.sources.get(uri)?.project ?? [])]; }
  select(uri?: string, target: TraceTarget = {}): void {
    this.selection = { projectUri: uri, ...target }; ++this.generation;
    const source = this.sources.get(uri ?? ''); if (source) { source.error = undefined; }
  }
  bind(project: Project, version: number | undefined, send: (message: unknown) => void) {
    const token = ++this.shared.token;
    const previous = this.sources.get(project.uri);
    const source: Source = { project, token, send, snapshot: previous?.snapshot, runs: previous?.runs ?? new Map(), pending: new Map(), actionErrors: new Map(),
      requested: new Set(), failed: new Set(), status: version === 1 ? 'connecting' : 'unsupported' };
    this.sources.set(project.uri, source);
    ++this.generation;
    return {
      receive: (message: Record<string, any>): boolean => {
        if (this.sources.get(project.uri)?.token !== token || message.type !== 'workflow-trace' || message.version !== 1) { return false; }
        if (message.kind === 'state') {
          const snapshot = message.snapshot as TraceSnapshot;
          if (snapshot?.project?.id !== project.id || snapshot.project.projectType !== project.projectType) { return false; }
          source.snapshot = snapshot;
          if (project.assistant && snapshot.durable) {
            this.assistants.add(project.uri);
            if (!this.selection.projectUri) { this.select(project.uri); }
          }
          for (const run of [snapshot.run, snapshot.occupiedRun]) { if (run) { source.runs.set(run.id, run); } }
          const ids = new Set((snapshot.runs ?? []).map(run => run.id));
          if (snapshot.history && !snapshot.history.query && !snapshot.history.hasMore) {
            for (const id of source.runs.keys()) { if (!ids.has(id) && id !== snapshot.run?.id && id !== snapshot.occupiedRun?.id) { source.runs.delete(id); } }
          }
          const selectedId = this.selection.projectUri === project.uri ? this.selection.runId : undefined;
          if (selectedId && !source.runs.has(selectedId) && !source.requested.has(selectedId) && !source.failed.has(selectedId)) { this.request('run', selectedId); }
        } else if (message.kind === 'run') {
          source.requested.delete(String(message.runId));
          if (message.error) { source.failed.add(String(message.runId)); }
          if (message.run?.id && message.run.id === message.runId) { source.runs.set(message.run.id, message.run); }
          if (message.runId === this.selection.runId) { source.error = typeof message.error === 'string' ? message.error : undefined; }
        } else if (message.kind === 'command') {
          const sessionId = source.pending.get(message.requestId);
          if (!sessionId) { return false; }
          source.pending.delete(message.requestId);
          if (typeof message.error === 'string') source.actionErrors.set(sessionId, message.error);
          else source.actionErrors.delete(sessionId);
        } else if (message.kind === 'status') {
          source.status = String(message.status);
          if (source.status !== 'connected') { source.pending.clear(); }
        }
        else if (message.kind === 'open') {
          if (project.assistant) { this.assistants.add(project.uri); }
          ++this.reveal; this.select(project.uri, message.target ?? {}); return true;
        }
        return false;
      },
      dispose: () => {
        if (this.sources.get(project.uri)?.token !== token) { return; }
        source.send = undefined; source.status = 'closed';
        source.pending.clear();
        source.requested.clear();
        if (source.snapshot) {
          source.snapshot.running = false;
          for (const session of source.snapshot.sessions ?? []) { for (const message of session.messages) { if (message.status === 'running') { message.status = 'interrupted'; } } }
          for (const run of source.runs.values()) { if (run.status === 'running') { run.status = 'interrupted'; } }
        }
        if (project.assistant) { this.assistants.delete(project.uri); this.sources.delete(project.uri); }
      },
    };
  }
  request(type: 'run' | 'more', runId?: string): void {
    const source = this.sources.get(this.selection.projectUri ?? '');
    if (!source?.send) { return; }
    if (type === 'run' && runId) { source.requested.add(runId); source.failed.delete(runId); }
    source.send({ type: 'workflow-host', traceCommand: { type, runId } });
  }
  action(action: TraceAgentAction): boolean {
    const source = this.sources.get(this.selection.projectUri ?? ''), snapshot = source?.snapshot;
    const session = snapshot?.sessions?.find(session => session.id === (this.selection.sessionId ?? snapshot.activeId));
    const agent = session && snapshot?.agents?.[session.agentOwnerId ?? session.id];
    if (!source?.send || source.status !== 'connected' || !agent || session?.id !== action.sessionId
      || agent.ownerId !== action.ownerId || (session.agentConversationId ?? agent.conversationId) !== action.conversationId
      || [...source.pending.values()].includes(action.sessionId)) { return false; }
    const requestId = globalThis.crypto.randomUUID();
    source.actionErrors.delete(action.sessionId); source.pending.set(requestId, action.sessionId);
    source.send({ type: 'workflow-host', traceCommand: { ...action, requestId } });
    return true;
  }
  hasConnection(uri: string): boolean { return !!this.sources.get(uri)?.send; }
  state(): TracePanelState {
    const source = this.sources.get(this.selection.projectUri ?? '');
    const sessionId = this.selection.sessionId ?? source?.snapshot?.activeId;
    return { type: 'trace-state', generation: this.generation, reveal: this.reveal,
      projects: this.availableProjects().map(project => ({ uri: project.uri, name: project.name, projectType: project.projectType,
        ...(projectVersion(project) ? { version: projectVersion(project) } : {}) })),
      selection: this.selection, snapshot: source?.snapshot, run: source?.runs.get(this.selection.runId ?? ''),
      status: source?.status ?? 'idle', loading: !!source?.requested.has(this.selection.runId ?? ''),
      pending: [...source?.pending.values() ?? []].includes(sessionId ?? ''),
      error: source?.actionErrors.get(sessionId ?? '') ?? source?.error };
  }
}
