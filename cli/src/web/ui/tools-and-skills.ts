import { t } from '../localization';
import type { Tool, ToolPolicies } from '../workflow-types';
import { toolPermissions } from './tool-permissions';
import { iconHtml } from './ui';
import './tools-and-skills.css';

/** Skill guides are read through the skill tool; their actions use the other tools. */
export function toolsAndSkills(tools: Tool[], policies: ToolPolicies, changed: (policies: ToolPolicies) => void,
  expanded: Map<string, boolean>): HTMLElement {
  const root = document.createElement('div'); root.className = 'tools-and-skills';
  const skills = tools.filter(tool => tool.name === 'skill');
  const ordinary = tools.filter(tool => tool.name !== 'skill');
  // Editing a tool must preserve any existing policy for the read-only skill registration.
  const retained = Object.fromEntries(skills.filter(tool => policies[tool.name]).map(tool => [tool.name, structuredClone(policies[tool.name])]));
  const permissions = toolPermissions(ordinary, policies, next => changed({ ...next, ...structuredClone(retained) }), expanded);
  const guides = skillGuides(skills);
  const navigation = document.createElement('div'); navigation.className = 'tools-and-skills-tabs';
  navigation.setAttribute('role', 'tablist'); navigation.ariaLabel = t('Tools and skills');
  const tabs: HTMLButtonElement[] = [];
  const panels = [permissions, guides];
  for (const [index, label] of [t('Tools'), t('Skills')].entries()) {
    const tab = document.createElement('button'); tab.type = 'button'; tab.textContent = label;
    tab.dataset.tab = index === 0 ? 'tools' : 'skills'; tab.setAttribute('role', 'tab');
    tab.id = `tools-and-skills-${tab.dataset.tab}-${crypto.randomUUID()}`;
    const panel = panels[index]; panel.id = `${tab.id}-panel`; panel.setAttribute('role', 'tabpanel'); panel.tabIndex = 0;
    panel.setAttribute('aria-labelledby', tab.id); tab.setAttribute('aria-controls', panel.id);
    tab.addEventListener('click', () => {
      tabs.forEach((item, position) => {
        item.setAttribute('aria-selected', String(item === tab)); item.tabIndex = item === tab ? 0 : -1;
        panels[position].hidden = item !== tab;
      });
    });
    tabs.push(tab); navigation.append(tab);
  }
  navigation.addEventListener('keydown', event => {
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : event.key === 'ArrowRight' ? (current + 1) % tabs.length : event.key === 'ArrowLeft' ? (current - 1 + tabs.length) % tabs.length : undefined;
    if (index !== undefined) { event.preventDefault(); tabs[index].click(); tabs[index].focus(); }
  });
  root.append(navigation, ...panels);
  tabs[ordinary.length || !skills.length ? 0 : 1].click();
  return root;
}

function skillGuides(skills: Tool[]): HTMLElement {
  const root = document.createElement('div'); root.className = 'skill-guides';
  const hint = document.createElement('p'); hint.className = 'skill-guides-hint';
  hint.textContent = t('Skills provide read-only guides. File changes, commands and other actions use the corresponding tool permissions.');
  root.append(hint);
  if (!skills.length) {
    const empty = document.createElement('p'); empty.className = 'skill-guides-empty'; empty.textContent = t('No skills declared by this project');
    root.append(empty); return root;
  }
  const list = document.createElement('ul'); list.className = 'skill-guide-list'; root.append(list);
  for (const skill of skills) {
    const item = document.createElement('li'); item.className = 'skill-guide';
    const heading = document.createElement('div'); heading.className = 'skill-guide-heading'; heading.innerHTML = iconHtml('book');
    const title = document.createElement('h3'); title.textContent = skill.label || skill.name;
    const badge = document.createElement('span'); badge.className = 'skill-guide-badge'; badge.textContent = t('Read-only');
    heading.append(title, badge); item.append(heading);
    const name = document.createElement('code'); name.className = 'skill-guide-name'; name.textContent = skill.name; item.append(name);
    if (skill.description) {
      const description = document.createElement('p'); description.className = 'skill-guide-description'; description.textContent = skill.description; item.append(description);
    }
    list.append(item);
  }
  return root;
}
