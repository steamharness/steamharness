import * as vscode from 'vscode';
import { realpath } from 'node:fs/promises';
import { t } from './localization';
import { botCredentialKinds, botCredentialNamespace, createBotCredentialVault, readPickedSshKey, validBotCredentialName, validBotCredentialText,
  type BotCredentialAction, type BotCredentialKind, type BotCredentialResult, type BotCredentialSlot } from './bot-credential-vault';
import type { Project } from './workflow-types';

const kindLabel = (kind: BotCredentialKind) => kind === 'ssh-private-key' ? t('SSH private key') : kind === 'password' ? t('Password') : t('API key or token');

export function createBotCredentialInteraction(context: vscode.ExtensionContext) {
  let opening = false;
  const canPersist = async () => vscode.workspace.isTrusted && !vscode.env.remoteName && vscode.env.uiKind === vscode.UIKind.Desktop && typeof context.secrets.keys === 'function'
    && await Promise.resolve(vscode.commands.executeCommand<boolean>('studio.internalCanPersistBotCredentials')).catch(() => false) === true;
  return async (project: Project, entryId: string, label: string, request: BotCredentialAction, signal: AbortSignal): Promise<BotCredentialResult> => {
    if (opening) return 'busy';
    opening = true;
    const cancellation = new vscode.CancellationTokenSource();
    const abort = () => cancellation.cancel();
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      if (!await canPersist()) {
        void vscode.window.showWarningMessage(t('System-protected credential storage is unavailable. No credential was saved.'));
        return 'unavailable';
      }
      const profile = context.globalStorageUri.fsPath;
      const workdir = project.folderBot?.directory ?? project.assistant?.workdir;
      const vault = createBotCredentialVault(context.secrets, profile, botCredentialNamespace(profile, project.id, entryId, await realpath(project.folderPath),
        project.folderBot?.id, workdir && await realpath(workdir)), canPersist);
      signal.throwIfAborted();
      const title = t('Bot credentials: {0}', label);
      const valueFor = async (slot: BotCredentialSlot): Promise<string | undefined> => {
        if (slot.kind !== 'ssh-private-key') return vscode.window.showInputBox({ title, prompt: t('{0}: {1}', kindLabel(slot.kind), slot.name), password: true, ignoreFocusOut: true,
          validateInput: value => validBotCredentialText(value) ? undefined : t('Enter a non-empty single-line credential (up to 16 KiB).') }, cancellation.token);
        const files = await vscode.window.showOpenDialog({ title: t('Choose the SSH private key for {0}', slot.name), canSelectFiles: true, canSelectFolders: false, canSelectMany: false });
        signal.throwIfAborted();
        if (!files?.length) return;
        if (files.length !== 1 || files[0].scheme !== 'file' || files[0].authority) throw new Error('Not a local file.');
        try { return await readPickedSshKey(files[0].fsPath); }
        catch { void vscode.window.showWarningMessage(t('Choose a local OpenSSH or PEM private key file (up to 64 KiB).')); throw new Error('SSH key validation failed.'); }
      };
      if (request.action === 'capture') {
        const { slot } = request;
        if (await vault.exists(slot, signal)) {
          const selected = await vscode.window.showQuickPick([{ label: t('Keep saved credential'), detail: t('{0}: {1}', kindLabel(slot.kind), slot.name) }],
            { title, ignoreFocusOut: true }, cancellation.token);
          return selected && await vault.exists(slot, signal) ? 'existing' : 'declined';
        }
        const value = await valueFor(slot);
        if (value === undefined) return 'declined';
        return await vault.write(slot, value, false, signal);
      }
      const stored = await vault.list(signal);
      const add = { label: t('Add credential'), slot: undefined };
      const choice = await vscode.window.showQuickPick([add, ...stored.map(slot => ({ label: slot.name, description: kindLabel(slot.kind), slot }))], { title, ignoreFocusOut: true }, cancellation.token);
      if (!choice) return 'managed';
      if (!choice.slot) {
        const type = await vscode.window.showQuickPick(botCredentialKinds.map(kind => ({ label: kindLabel(kind), credentialKind: kind })), { title }, cancellation.token);
        if (!type) return 'managed';
        const name = await vscode.window.showInputBox({ title, prompt: t('Credential alias'), validateInput: value => validBotCredentialName(value) ? undefined : t('Use 1–64 lowercase letters, digits, dots, hyphens or underscores. Start with a letter or digit.') }, cancellation.token);
        if (!name) return 'managed';
        const slot = { name, kind: type.credentialKind };
        if (await vault.exists(slot, signal)) { void vscode.window.showWarningMessage(t('This credential alias and type already exist.')); return 'managed'; }
        const value = await valueFor(slot);
        if (value !== undefined && await vault.write(slot, value, false, signal) === 'existing') void vscode.window.showWarningMessage(t('This credential alias and type already exist.'));
      } else {
        const slot = choice.slot;
        const action = await vscode.window.showQuickPick([{ label: t('Replace credential'), remove: false }, { label: t('Delete credential'), remove: true }], { title: t('{0}: {1}', title, slot.name) }, cancellation.token);
        if (action?.remove) {
          const remove = t('Delete credential');
          const confirmed = await vscode.window.showWarningMessage(t('Delete the saved credential {0}?', slot.name), { modal: true }, remove);
          if (confirmed === remove) await vault.remove(slot, signal);
        } else if (action) {
          const value = await valueFor(slot);
          if (value !== undefined) await vault.write(slot, value, true, signal);
        }
      }
      return 'managed';
    } catch { return 'unavailable'; }
    finally { signal.removeEventListener('abort', abort); cancellation.dispose(); opening = false; }
  };
}
