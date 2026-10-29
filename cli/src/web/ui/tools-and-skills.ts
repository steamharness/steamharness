import type { Tool, ToolPolicies } from '../workflow-types';
import { toolPermissions } from './tool-permissions';

/** Skill guides are read through the skill tool; their actions use the other tools. */
export function toolsAndSkills(tools: Tool[], policies: ToolPolicies, changed: (policies: ToolPolicies) => void,
  expanded: Map<string, boolean>): { tools: HTMLElement; update(policies: ToolPolicies, readOnly: boolean): void } {
  const skills = tools.filter(tool => tool.name === 'skill');
  const ordinary = tools.filter(tool => tool.name !== 'skill');
  // Editing a tool must preserve any existing policy for the read-only skill registration.
  const retain = (policies: ToolPolicies) => Object.fromEntries(skills.filter(tool => policies[tool.name]).map(tool => [tool.name, structuredClone(policies[tool.name])]));
  let retained = retain(policies);
  const permissions = toolPermissions(ordinary, policies, next => changed({ ...next, ...structuredClone(retained) }), expanded);
  return { tools: permissions.element, update(next, readOnly) { retained = retain(next); permissions.update(next, readOnly); } };
}
