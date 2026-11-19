import { createDefaultProjectInfo, resolveProjectName } from '@steamharness/project-info';
import type { SidebarEdit, SidebarProjectEntry } from './project-sidebar-types';

export interface SavedSidebarEntry extends SidebarProjectEntry { id: string; visible: boolean }
export interface SidebarPreferences { order: string[]; projects: SavedSidebarEntry[] }

const idPattern = /^[a-z0-9-]{1,80}$/;
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
export const sidebarEntryKey = ({ directory, projectId, entryId }: SidebarProjectEntry) => JSON.stringify([directory, projectId, entryId]);

export function sidebarEntryTitle(entry: SidebarProjectEntry, language: string): string {
  if (!entry.localizedNames || typeof entry.localizedNames !== 'object' || Array.isArray(entry.localizedNames)) return entry.title;
  const localizedNames = Object.fromEntries(Object.entries(entry.localizedNames).filter(([, name]) => typeof name === 'string' && name.trim()));
  return resolveProjectName(entry.title, { ...createDefaultProjectInfo(), localizedNames }, language).trim().slice(0, 256);
}

export function readSidebarPreferences(value: unknown): SidebarPreferences {
  const raw = value as Partial<SidebarPreferences> | undefined;
  const keys = new Set<string>(), ids = new Set<string>();
  const projects = (Array.isArray(raw?.projects) ? raw.projects : []).filter(project => {
    if (!project || typeof project.id !== 'string' || !uuid.test(project.id) || ids.has(project.id) ||
        typeof project.directory !== 'string' || !project.directory || project.directory.length > 4096 ||
        typeof project.projectId !== 'string' || !uuid.test(project.projectId) ||
        typeof project.entryId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(project.entryId) ||
        typeof project.title !== 'string' || !project.title.trim() || project.title.length > 256 ||
        !['bot', 'kanban', 'workflow'].includes(project.type) || typeof project.visible !== 'boolean') return false;
    const key = sidebarEntryKey(project);
    if (keys.has(key)) return false;
    keys.add(key); ids.add(project.id);
    return true;
  });
  const order = [...new Set((Array.isArray(raw?.order) ? raw.order : []).filter(id => typeof id === 'string' && idPattern.test(id)))];
  return { projects, order };
}

export function orderedSidebarIds(preferences: SidebarPreferences, builtins: readonly string[]): string[] {
  const ids = [...builtins, ...preferences.projects.map(item => item.id)];
  const known = new Set(ids);
  const saved = preferences.order.filter(id => known.has(id));
  if (!saved.length) return ids;
  // A new built-in gets its default slot until the user explicitly sorts it.
  for (const [index, id] of builtins.entries()) if (!saved.includes(id)) saved.splice(index, 0, id);
  return [...new Set([...saved, ...ids])];
}

export function editSidebarPreferences(preferences: SidebarPreferences, builtins: readonly string[], edit: Exclude<SidebarEdit, { action: 'add' }>): SidebarPreferences {
  const order = orderedSidebarIds(preferences, builtins);
  const index = order.indexOf(edit.id);
  if (index === -1) return preferences;
  if (edit.action === 'up' || edit.action === 'down') {
    const other = index + (edit.action === 'up' ? -1 : 1);
    if (other < 0 || other >= order.length) return preferences;
    [order[index], order[other]] = [order[other], order[index]];
    return { ...preferences, order };
  }
  if (builtins.includes(edit.id)) return preferences;
  if (edit.action === 'remove') return { order: order.filter(id => id !== edit.id), projects: preferences.projects.filter(item => item.id !== edit.id) };
  return { ...preferences, projects: preferences.projects.map(item => item.id === edit.id ? { ...item, visible: !item.visible } : item) };
}
