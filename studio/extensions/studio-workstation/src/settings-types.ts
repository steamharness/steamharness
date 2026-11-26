import type { SidebarItem } from './project-sidebar-types';

export type SettingsTarget = 'user' | 'workspace';

export interface SettingsOpenOptions {
  section?: string;
  query?: string;
  target?: SettingsTarget;
}

export interface SettingsViewState extends SettingsOpenOptions {
  scroll?: number;
}

export interface SettingItem {
  key: string;
  section: 'general' | 'editor' | 'permissions' | 'notifications';
  group: string;
  label: string;
  description: string;
  type: 'boolean' | 'number' | 'string' | 'select' | 'radio';
  options?: { value: string; label: string; description?: string }[];
  minimum?: number;
  maximum?: number;
  integer?: boolean;
}

export interface SettingState extends SettingItem {
  value: string | number | boolean;
  configured: boolean;
  overridden: boolean;
}

export interface SettingsProvider {
  id: string;
  title: string;
  icon?: string;
}

export interface StudioProductInfo {
  studioVersion?: string;
  logo?: string;
}

export interface StudioRuntimeVersions {
  coreVersion?: string;
  cliVersion?: string;
}

export interface SettingsState extends StudioRuntimeVersions {
  target: SettingsTarget;
  workspaceAvailable: boolean;
  items: SettingState[];
  language: string;
  languagePreference: string;
  studioVersion?: string;
  studioLogo?: string;
  vscodeVersion: string;
  providers: SettingsProvider[];
  remoteAccess?: boolean;
  sidebar?: { items: SidebarItem[]; canAdd: boolean };
  nodeRuntime?: { source?: 'bundled' | 'local' | 'host'; version?: string; path?: string; error?: string };
  desktopNotificationStatus?: {
    platform: 'macos' | 'windows' | 'linux';
    appName: string;
    permission: 'granted' | 'denied' | 'not-determined' | 'unknown' | 'unsupported';
  };
}
