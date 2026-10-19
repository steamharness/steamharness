import { t } from './localization';
import dagre from '@dagrejs/dagre';
import type { ExecutionItem, Project } from './workflow-types';
import type { RunRecord } from './workflow-workspace';

export interface GraphNode { id: string; label: string; kind: string; status?: string; detail?: unknown; executionId?: string; x: number; y: number; width: number; height: number }
export interface GraphEdge { from: string; to: string; label?: string; points: { x: number; y: number }[] }
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function callTitle(item: Extract<ExecutionItem, { kind: 'node' }>): string | undefined {
  for (const argument of Array.isArray(item.arguments) ? item.arguments : []) {
    const value = record(record(record(argument).value).value);
    const name = record(value.name);
    if (name.kind === 'literal' && typeof name.value === 'string') { return name.value; }
  }
  return undefined;
}
export function layoutWorkflowGraph(project: Project, entrypointId?: string, run?: Pick<RunRecord, 'nodes'>) {
  const nodes: GraphNode[] = [], edges: GraphEdge[] = [], diagnostics: string[] = [];
  const execution = project.entrypoints.find(entry => entry.id === entrypointId)?.execution ?? project.execution;
  const used = new Set<string>();
  const add = (id: string, label: string, kind: string, detail?: unknown, status?: string, executionId?: string) => {
    nodes.push({ id, label, kind, detail, status, executionId, x: 0, y: 0, width: 200, height: 62 }); return id;
  };
  const edge = (from: string, to: string, label?: string) => edges.push({ from, to, label, points: [] });
  const sequence = (items: ExecutionItem[], inputs: string[], prefix: string): string[] => {
    let previous = inputs;
    for (const [index, item] of items.entries()) {
      const key = `${prefix}-${index}`;
      if (item.kind === 'node') {
        const definition = project.definitions?.nodes?.[item.nodeId];
        const name = String(definition?.configuredName ?? definition?.name ?? callTitle(item) ?? item.nodeId);
        const instances = (run?.nodes ?? []).filter(node => (record(node.metadata).title === name || node.name === name || node.nodeName === name)
          && typeof node.executionId === 'string' && !used.has(node.executionId));
        const ids = instances.length ? instances.map((node, iteration) => {
          used.add(String(node.executionId));
          return add(`execution:${node.executionId}`, `${name}${instances.length > 1 ? ` #${iteration + 1}` : ''}`, 'node', node, String(node.status), String(node.executionId));
        }) : [add(key, name, 'node', { definition, call: item })];
        for (const input of previous) { edge(input, ids[0]); }
        for (let i = 1; i < ids.length; i++) { edge(ids[i - 1], ids[i]); }
        previous = [ids.at(-1)!];
      } else if (item.kind === 'branch') {
        if (item.decision) { previous = sequence([item.decision], previous, `${key}-decision`); }
        const start = add(key, item.label ?? item.condition ?? t("Branch"), 'branch', item), end = add(`${key}-end`, t("Merge"), 'join');
        for (const input of previous) { edge(input, start); }
        for (const [branchIndex, branch] of item.branches.entries()) {
          const label = add(`${key}-path-${branchIndex}`, branch.label ?? branch.condition ?? branch.kind, 'path', branch);
          edge(start, label);
          for (const tail of sequence(branch.children, [label], `${key}-path-${branchIndex}`)) { edge(tail, end); }
        }
        previous = [end];
      } else if (item.kind === 'loop') {
        const start = add(key, item.label ?? item.condition ?? t("Loop"), 'loop', item);
        for (const input of previous) { edge(input, start); }
        const decisions = item.decision ? sequence([item.decision], [start], `${key}-decision`) : [start];
        for (const tail of sequence(item.children, decisions, `${key}-body`)) { edge(tail, start, t("Loop")); }
        const end = add(`${key}-end`, t("Loop end"), 'join'); edge(start, end, t("Complete")); previous = [end];
      } else { diagnostics.push('Unknown execution structure.'); }
    }
    return previous;
  };
  if (execution?.children?.length) { sequence(execution.children, [], 'structure'); }
  else { diagnostics.push(t("No static workflow structure is available. Showing recorded execution nodes.")); }
  let previous: string | undefined;
  for (const node of run?.nodes ?? []) {
    const executionId = String(node.executionId ?? '');
    if (executionId && used.has(executionId)) { continue; }
    const id = add(`runtime:${executionId || nodes.length}`, String(record(node.metadata).title ?? node.name ?? node.nodeName ?? 'Node'), 'node', node, String(node.status), executionId);
    if (previous) { edge(previous, id); } previous = id;
    if (execution?.children?.length) { diagnostics.push(t("Node {0} does not match the static structure.", String(node.name))); }
  }
  diagnostics.push(...(project.diagnostics?.warnings ?? []).map(item => item.message), ...(project.diagnostics?.violations ?? []).map(item => item.message));
  const graph = new dagre.graphlib.Graph({ multigraph: true }).setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 48, marginx: 28, marginy: 28 }).setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) { graph.setNode(node.id, { width: node.width, height: node.height }); }
  for (const [index, item] of edges.entries()) { graph.setEdge(item.from, item.to, { label: item.label, width: item.label ? 60 : 0, height: item.label ? 16 : 0 }, String(index)); }
  if (nodes.length) { dagre.layout(graph); }
  for (const node of nodes) { Object.assign(node, graph.node(node.id)); }
  for (const [index, item] of edges.entries()) { item.points = graph.edge({ v: item.from, w: item.to, name: String(index) }).points; }
  return { nodes, edges, diagnostics: [...new Set(diagnostics)], width: graph.graph().width || 400, height: graph.graph().height || 160 };
}
