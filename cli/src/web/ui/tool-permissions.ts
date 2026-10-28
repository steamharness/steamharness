import { t } from '../localization';
import type { Tool, ToolPolicies } from '../workflow-types';
import { iconHtml } from './ui';

const categories: [string, RegExp][] = [
  ['File tools', /^(read|write|edit|grep|find|ls)$/],
  ['Shell commands', /^bash$/],
  ['Agent tools', /^(update_plan|subagent|tool_search|codemode|ask_user)$/],
  ['Knowledge', /^(kb_|workflow-knowledge_|knowledge_documents$)/],
  ['Data storage', /^(kv_|db_|workflow-kv_|kv_store$)/],
  ['Memory', /^(workflow-memory_|global_memory$)/],
  ['Studio', /^workflow-studio_/],
  ['Resource cards', /^workflow-ui_/],
];

function groupFor(name: string): { id: string; title: string } {
  const category = categories.find(([, pattern]) => pattern.test(name));
  if (category) { return { id: `category:${category[0]}`, title: t(category[0]) }; }
  // MCP IDs use <server>_<tool>; custom tool prefixes also make useful sections.
  const namespace = name.match(/^mcp__(.+?)__/u)?.[1] ?? name.slice(0, Math.max(0, name.indexOf('_')));
  return namespace ? { id: `namespace:${namespace}`, title: namespace } : { id: 'other', title: t("Other tools") };
}

export interface ToolPermissionsPanel {
  element: HTMLElement;
  update(policies: ToolPolicies, readOnly: boolean): void;
}

export function toolPermissions(tools: Tool[], policies: ToolPolicies, changed: (policies: ToolPolicies) => void,
  expanded: Map<string, boolean>): ToolPermissionsPanel {
  const root = document.createElement('div'); root.className = 'tool-permissions';
  const count = document.createElement('p'); count.className = 'tool-count'; count.setAttribute('role', 'status');
  const empty = document.createElement('p'); empty.textContent = t("No tools declared by this project");
  if (!tools.length) { count.textContent = t("{0} tools", 0); root.append(count, empty); return { element: root, update() {} }; }
  const search = document.createElement('input'); search.type = 'search'; search.className = 'tool-search';
  search.ariaLabel = t("Search tools"); search.placeholder = t("Search tools...");
  root.append(search, count);
  const draft: ToolPolicies = {};
  const controls: { tool: Tool; property: 'enabled' | 'autoApprove'; checkbox: HTMLInputElement }[] = [];
  let policySnapshot = JSON.stringify(policies);
  const groups = new Map<string, { details: HTMLDetailsElement; count: HTMLElement; rows: { element: HTMLTableRowElement; text: string }[] }>();
  for (const tool of tools) {
    draft[tool.name] = { enabled: policies[tool.name]?.enabled ?? tool.enabled ?? true, autoApprove: policies[tool.name]?.autoApprove ?? tool.autoApprove ?? false };
    const group = groupFor(tool.name);
    let view = groups.get(group.id);
    if (!view) {
      const details = document.createElement('details'); details.className = 'tool-permission-section'; details.dataset.group = group.id;
      details.open = expanded.get(group.id) ?? false;
      details.addEventListener('toggle', () => { if (!search.value.trim()) { expanded.set(group.id, details.open); } });
      const summary = document.createElement('summary'); summary.innerHTML = iconHtml('chevron-right');
      const title = document.createElement('span'); title.className = 'tool-group-title'; title.textContent = group.title;
      const groupCount = document.createElement('span'); groupCount.className = 'tool-group-count'; summary.append(title, groupCount);
      const table = document.createElement('table'); table.className = 'permissions-table'; table.setAttribute('aria-label', group.title);
      table.innerHTML = `<thead><tr><th scope="col">${t("Tool")}</th><th scope="col">${t("Enable")}</th><th scope="col">${t("Auto-approve")}</th></tr></thead><tbody></tbody>`;
      details.append(summary, table); root.append(details);
      view = { details, count: groupCount, rows: [] }; groups.set(group.id, view);
    }
    const row = document.createElement('tr'); const label = document.createElement('td');
    const title = tool.label || tool.name; label.textContent = title; label.title = tool.description || tool.name;
    if (title !== tool.name) { const name = document.createElement('small'); name.className = 'permission-tool-name'; name.textContent = tool.name; label.append(name); }
    if (tool.description) { const description = document.createElement('p'); description.className = 'permission-tool-description'; description.textContent = tool.description; label.append(description); }
    row.append(label);
    for (const property of ['enabled', 'autoApprove'] as const) {
      const cell = document.createElement('td'), checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = draft[tool.name][property]!;
      checkbox.ariaLabel = `${title === tool.name ? title : `${title} (${tool.name})`} ${property === 'enabled' ? t("Enable") : t("Auto-approve")}`;
      checkbox.addEventListener('change', () => { draft[tool.name][property] = checkbox.checked; changed(structuredClone(draft)); });
      controls.push({ tool, property, checkbox });
      cell.append(checkbox); row.append(cell);
    }
    view.details.querySelector('tbody')!.append(row);
    view.rows.push({ element: row, text: `${group.title} ${tool.name} ${title} ${tool.description ?? ''}`.toLowerCase() });
  }
  empty.textContent = t("No matching tools"); root.append(empty);
  let filtering = false;
  const filter = () => {
    const query = search.value.trim().toLowerCase(); let total = 0;
    // Capture the actual state before search changes it, including queued native toggle events.
    if (query && !filtering) { for (const [id, group] of groups) { expanded.set(id, group.details.open); } }
    filtering = !!query;
    for (const [id, group] of groups) {
      let matches = 0;
      for (const row of group.rows) { row.element.hidden = !!query && !row.text.includes(query); if (!row.element.hidden) { matches++; } }
      group.details.hidden = matches === 0; group.count.textContent = t("{0} tools", matches);
      group.details.open = query ? matches > 0 : expanded.get(id) ?? false; total += matches;
    }
    count.textContent = query ? t("{0} of {1} tools", total, tools.length) : t("{0} tools", tools.length);
    empty.hidden = total > 0;
  };
  search.addEventListener('input', filter); filter();
  return {
    element: root,
    update(next, readOnly) {
      const snapshot = JSON.stringify(next), updated = snapshot !== policySnapshot;
      policySnapshot = snapshot;
      for (const { tool, property, checkbox } of controls) {
        checkbox.disabled = readOnly;
        // Keep optimistic edits until a different authoritative state arrives.
        if (updated) checkbox.checked = draft[tool.name][property] = next[tool.name]?.[property] ?? tool[property] ?? (property === 'enabled');
      }
    },
  };
}
