import type { AgentSessionCommand, AgentSessionReceipt } from "./session-types";

type Handler = (command: AgentSessionCommand) => Promise<AgentSessionReceipt>;
const handlers = new Map<string, Handler>();
const hosts = new Map<string, { released: Promise<void>; release(): void; resume: boolean }>();

/** Keep the workflow's tools and provider alive between inputs. Close before disposing the worker. */
export function createAgentSessionHost(scopeId: string, options: { resume?: boolean } = {}): { close(): void } {
  if (hosts.has(scopeId)) throw new Error("The agent session already has a host.");
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const host = { released, release, resume: options.resume === true };
  hosts.set(scopeId, host);
  return { close: () => { if (hosts.get(scopeId) === host) hosts.delete(scopeId); release(); } };
}

export function agentSessionLease(scopeId: string): Promise<void> | undefined { return hosts.get(scopeId)?.released; }
export function agentSessionResuming(scopeId: string): boolean { return hosts.get(scopeId)?.resume === true; }

/** The host addresses the original workflow conversation, never a database filename. */
export async function controlAgentSession(scopeId: string, command: AgentSessionCommand): Promise<AgentSessionReceipt> {
  const handler = handlers.get(scopeId);
  if (!handler) throw Object.assign(new Error("The agent session is not ready."), { code: "AGENT_NOT_READY" });
  return handler(command);
}

export function bindAgentSessionControl(scopeId: string, handler: Handler): () => void {
  if (handlers.has(scopeId)) throw new Error("The agent session already has a control owner.");
  handlers.set(scopeId, handler);
  return () => { if (handlers.get(scopeId) === handler) handlers.delete(scopeId); };
}
