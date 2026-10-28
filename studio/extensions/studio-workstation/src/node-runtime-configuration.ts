import * as vscode from 'vscode';
import { resolveNodeRuntime, type NodeRuntime } from './node-runtime';

let cached: { key: string; value: Promise<NodeRuntime> } | undefined;
export function configuredNodeRuntime(storageDirectory?: string): Promise<NodeRuntime> {
  const configuration = vscode.workspace.getConfiguration('studio');
  const selected = configuration.inspect?.<string>('project.nodeSource')?.globalValue;
  const source = selected === 'auto' || selected === 'local' ? selected : undefined;
  const nodePath = configuration.get<string>('project.nodePath') || '';
  const key = JSON.stringify([source, nodePath, storageDirectory, process.env.STEAMHARNESS_STUDIO_NODE_RUNTIME]);
  if (cached?.key === key) return cached.value;
  const value = resolveNodeRuntime({ source, nodePath, storageDirectory });
  cached = { key, value };
  // Share concurrent callers, then revalidate for the next session/status
  // request: local installations and repaired bundles can change in place.
  const clear = () => { if (cached?.value === value) cached = undefined; };
  void value.then(clear, clear);
  return value;
}
export function resetNodeRuntime(): void { cached = undefined; }
