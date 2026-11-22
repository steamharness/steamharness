import type { WebAppBinding } from './web-app-types';

export type SidebarProjectType = 'bot' | 'kanban' | 'workflow';
export interface SidebarProjectEntry {
  directory: string;
  projectId: string;
  entryId: string;
  title: string;
  localizedNames?: Record<string, string>;
  type: SidebarProjectType;
}

export interface SidebarItem {
  id: string;
  title: string;
  type: SidebarProjectType;
  directory?: string;
  builtin: boolean;
  visible: boolean;
}

export type SidebarEdit = { action: 'add' } | { action: 'up' | 'down' | 'toggle' | 'remove'; id: string };

export type HostedSidebarState = { binding: WebAppBinding } | { message: string; action?: { label: string; run(): unknown } };
export interface HostedSidebarProject {
  id: string;
  viewId: string;
  title: string;
  directory: string;
  projectId: string;
  entryId: string;
  hostNotifications?: boolean;
  standalone?: boolean;
  getState(): HostedSidebarState;
  onDidChange(listener: () => void): { dispose(): unknown };
}

export interface HostedSidebarPreview { url: string; nonce: string; microphone: boolean; close(): Promise<void> }
export interface HostedLaunchpadTarget { id: string; route: string; title?: string }
export type OpenHostedSidebar = (project: HostedSidebarProject, binding: WebAppBinding, signal: AbortSignal) => Promise<HostedSidebarPreview>;
