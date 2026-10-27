import * as vscode from 'vscode';
import { t } from './localization';

export const USER_PERMISSION_SETTING = 'studio.agent.permissionPolicy';
export interface StudioUserSettings { readonly agent: { readonly permissionPolicy: 'read-only' | 'workspace' | 'auto' } }

/** Read user scope explicitly: a project's settings must never override this preference. */
export function readUserSettings(): StudioUserSettings {
  const inspected = vscode.workspace.getConfiguration().inspect<string>(USER_PERMISSION_SETTING);
  const value = inspected?.globalValue ?? inspected?.defaultValue ?? 'auto';
  if (value !== 'read-only' && value !== 'workspace' && value !== 'auto') {
    throw new Error(t('Choose a valid user permission policy in Studio settings.'));
  }
  return { agent: { permissionPolicy: value } };
}
