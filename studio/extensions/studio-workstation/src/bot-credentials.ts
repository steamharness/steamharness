import * as vscode from 'vscode';
import { createHmac, randomBytes } from 'node:crypto';
import { ALIBABA_DNS_HOST } from '../../../../harness/src/types/bot-credential-use';
import { t } from './localization';
import { botCredentialKinds, resolveBotCredentialNamespace, createBotCredentialVault, parseStructuredCredential, readPickedSshKey, structuredCredentialFields, validBotCredentialName, validBotCredentialText,
  type BotCredentialAction, type BotCredentialKind, type BotCredentialResult, type BotCredentialSlot } from './bot-credential-vault';
import type { Project } from './workflow-types';
import { runBotCredentialDnsQuery } from './bot-credential-dns';
import { readUserSettings } from './user-settings';

export const botCredentialKindLabel = (kind: BotCredentialKind) => kind === 'ssh-private-key' ? t('SSH private key') : kind === 'password' ? t('Password')
  : kind === 'access-key-pair' ? t('Access key pair') : kind === 'structured' ? t('Structured credential') : t('API key or token');

export const canAccessBotCredentialStorage = async (context: vscode.ExtensionContext): Promise<boolean> =>
  vscode.workspace.isTrusted && !vscode.env.remoteName && vscode.env.uiKind === vscode.UIKind.Desktop && typeof context.secrets.keys === 'function'
  && await Promise.resolve(vscode.commands.executeCommand<boolean>('studio.internalCanPersistBotCredentials')).catch(() => false) === true;

type CredentialInputOptions = Pick<vscode.InputBoxOptions, 'title' | 'prompt' | 'placeHolder' | 'password' | 'ignoreFocusOut'> & {
  validateInput(value: string): string | undefined;
};

/** A cleared field is neutral while editing, but is still required on accept. */
function showCredentialInput(options: CredentialInputOptions, token: vscode.CancellationToken): Promise<string | undefined> {
  if (token.isCancellationRequested) return Promise.resolve(undefined);
  return new Promise(resolve => {
    const input = vscode.window.createInputBox();
    input.title = options.title;
    input.prompt = options.prompt;
    input.placeholder = options.placeHolder;
    input.password = options.password ?? false;
    input.ignoreFocusOut = options.ignoreFocusOut ?? false;
    let validation: ReturnType<typeof setTimeout> | undefined;
    const setMessage = (message?: string) => {
      if (input.validationMessage !== message) input.validationMessage = message;
    };
    const listeners = [
      input.onDidChangeValue(value => {
        clearTimeout(validation);
        if (!value.trim()) setMessage();
        else validation = setTimeout(() => setMessage(options.validateInput(input.value)), 100);
      }),
      input.onDidAccept(() => {
        clearTimeout(validation);
        if (token.isCancellationRequested) { finish(); return; }
        const value = input.value;
        const message = options.validateInput(value);
        if (message) setMessage(message);
        else finish(value);
      }),
      input.onDidHide(() => finish()),
      token.onCancellationRequested(() => finish()),
    ];
    function finish(value?: string) {
      clearTimeout(validation);
      for (const listener of listeners) listener.dispose();
      input.dispose();
      resolve(value);
    }
    input.show();
  });
}

export function createBotCredentialInteraction(context: vscode.ExtensionContext, queryDns = runBotCredentialDnsQuery) {
  let opening = false;
  // Memory only, fenced by the Studio CLI host lease and the current vault contents.
  const approvals = new WeakMap<AbortSignal, Map<string, string>>();
  const fingerprintKey = randomBytes(32);
  const canPersist = () => canAccessBotCredentialStorage(context);
  return async (project: Project, entryId: string, label: string, request: BotCredentialAction, signal: AbortSignal, lifetime?: AbortSignal): Promise<BotCredentialResult> => {
    const reuse = request.action === 'use' && request.approval?.mode === 'reuse';
    const auto = request.action === 'use' && request.approval?.mode === 'auto';
    const silent = reuse || auto;
    const grants = lifetime && !lifetime.aborted ? approvals.get(lifetime) : undefined;
    if (reuse && !grants?.size) return 'approval-required';
    if (!silent && opening) return 'busy';
    if (!silent) opening = true;
    const cancellation = new vscode.CancellationTokenSource();
    const abort = () => cancellation.cancel();
    signal.addEventListener('abort', abort, { once: true });
    const queryBlock = (): BotCredentialResult | undefined => {
      if (request.action !== 'use') return;
      const policy = readUserSettings().agent.permissionPolicy;
      const ceiling = project.folderBot?.permissionCeiling;
      if (policy === 'read-only' || ceiling === 'read-only') return { status: 'failed' };
      if (auto && (policy !== 'auto' || ceiling === 'workspace')) return 'approval-required';
    };
    try {
      signal.throwIfAborted();
      const blocked = queryBlock();
      if (blocked) return blocked;
      if (!await canPersist()) {
        if (reuse) return 'approval-required';
        if (auto) return { status: 'failed' };
        void vscode.window.showWarningMessage(request.action === 'use' ? t('System-protected credential storage is unavailable. No query was sent.')
          : t('System-protected credential storage is unavailable. No credential was saved.'));
        return 'unavailable';
      }
      const profile = context.globalStorageUri.fsPath;
      const namespace = await resolveBotCredentialNamespace(profile, { projectId: project.id, entryId, projectDirectory: project.folderPath,
        instanceId: project.folderBot?.id, workdir: project.folderBot?.directory ?? project.assistant?.workdir });
      const vault = createBotCredentialVault(context.secrets, profile, namespace, canPersist);
      signal.throwIfAborted();
      const title = t('Bot credentials: {0}', label);
      if (request.action === 'use') {
        const { use, approval } = request;
        // Only these read-only calls share an approval. New connector operations must opt in explicitly.
        const grantKey = approval && approval.mode !== 'auto' && lifetime && !lifetime.aborted && use.connector === 'alibaba-cloud-dns'
          && (use.operation === 'list-domains' || use.operation === 'list-records')
          ? JSON.stringify([approval.scopeId, namespace, use.name, use.connector, ALIBABA_DNS_HOST,
            use.fields.accessKeyId, use.fields.accessKeySecret, use.fields.securityToken ?? null]) : undefined;
        const approved = grantKey && grants?.get(grantKey);
        let allowConversation = false;
        if (reuse) {
          if (!approved) return 'approval-required';
        } else if (!auto) {
          const operation = use.operation === 'list-domains' ? t('List Alibaba Cloud DNS domains') : t('List Alibaba Cloud DNS records for {0}', use.domain);
          const choices = [{ label: t('Allow once'), description: ALIBABA_DNS_HOST, detail: t('{0}, page {1}', operation, use.page), conversation: false }];
          if (grantKey) choices.push({ label: t('Allow for this conversation'), description: ALIBABA_DNS_HOST,
            detail: t('Read-only lookups of domains and DNS records with this credential'), conversation: true });
          const selected = await vscode.window.showQuickPick(choices, { title: t('Use {0} for {1}', use.name, label), ignoreFocusOut: true }, cancellation.token);
          if (!selected) return { status: 'declined' };
          allowConversation = selected.conversation;
        }
        signal.throwIfAborted();
        const beforeRead = queryBlock();
        if (beforeRead) return beforeRead;
        const legacyPair = use.fields.accessKeyId === 'AccessKeyId' && use.fields.accessKeySecret === 'AccessKeySecret' && use.fields.securityToken === undefined;
        const stored = await vault.readStructured(use.name, signal, legacyPair);
        const fingerprint = grantKey && stored ? createHmac('sha256', fingerprintKey)
          .update(JSON.stringify(Object.keys(stored).sort().map(key => [key, stored[key]]))).digest('hex') : undefined;
        if (reuse && (lifetime?.aborted || fingerprint !== approved)) {
          if (grantKey && grants?.get(grantKey) === approved) grants?.delete(grantKey);
          return 'approval-required';
        }
        if (stored === undefined) return { status: 'missing' };
        if (!stored) return { status: 'missing-fields' };
        const beforeQuery = queryBlock();
        if (beforeQuery) return beforeQuery;
        const result = await queryDns(use, stored, signal);
        if (allowConversation && grantKey && fingerprint && lifetime && !lifetime.aborted && !signal.aborted && result.status !== 'missing-fields') {
          const current = approvals.get(lifetime) ?? new Map<string, string>();
          current.delete(grantKey);
          current.set(grantKey, fingerprint);
          if (current.size > 128) current.delete(current.keys().next().value!);
          approvals.set(lifetime, current);
        }
        return result;
      }
      const valueFor = async (slot: BotCredentialSlot): Promise<string | undefined> => {
        if (slot.kind === 'structured' || slot.kind === 'access-key-pair') {
          const fields = structuredCredentialFields(slot);
          return showCredentialInput({ title, prompt: t('{0}: {1}', botCredentialKindLabel(slot.kind), slot.name), password: true, ignoreFocusOut: true,
            placeHolder: fields ? JSON.stringify(Object.fromEntries(fields.map(field => [field, '']))) : '{"field":""}',
            validateInput: value => parseStructuredCredential(value, fields) ? undefined : fields
              ? t('Enter JSON with exactly these fields and non-empty string values: {0}', fields.join(', '))
              : t('Enter a single-line JSON object with 1 to 16 named string values (up to 16 KiB).'),
          }, cancellation.token);
        }
        if (slot.kind !== 'ssh-private-key') return showCredentialInput({ title, prompt: t('{0}: {1}', botCredentialKindLabel(slot.kind), slot.name), password: true, ignoreFocusOut: true,
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
        const rejectDifferentFields = () => {
          void vscode.window.showWarningMessage(t('This alias already has different fields. Choose another alias or replace it in Bot credentials.'));
          return 'declined' as const;
        };
        const before = await vault.inspect(slot, signal);
        if (before === 'different-fields') return rejectDifferentFields();
        if (before === 'existing') {
          const selected = await vscode.window.showQuickPick([{ label: t('Keep saved credential'), detail: t('{0}: {1}', botCredentialKindLabel(slot.kind), slot.name) }],
            { title, ignoreFocusOut: true }, cancellation.token);
          if (!selected) return 'declined';
          const after = await vault.inspect(slot, signal);
          return after === 'different-fields' ? rejectDifferentFields() : after === 'existing' ? 'existing' : 'declined';
        }
        const value = await valueFor(slot);
        if (value === undefined) return 'declined';
        const result = await vault.write(slot, value, false, signal);
        return result === 'different-fields' ? rejectDifferentFields() : result;
      }
      const stored = await vault.list(signal);
      const add = { label: t('Add credential'), slot: undefined };
      const choice = await vscode.window.showQuickPick([add, ...stored.map(slot => ({ label: slot.name, description: botCredentialKindLabel(slot.kind), slot }))], { title, ignoreFocusOut: true }, cancellation.token);
      if (!choice) return 'managed';
      if (!choice.slot) {
        const type = await vscode.window.showQuickPick(botCredentialKinds.map(kind => ({ label: botCredentialKindLabel(kind), credentialKind: kind })), { title }, cancellation.token);
        if (!type) return 'managed';
        const name = await showCredentialInput({ title, prompt: t('Credential alias'), validateInput: value => validBotCredentialName(value) ? undefined : t('Use 1–64 lowercase letters, digits, dots, hyphens or underscores. Start with a letter or digit.') }, cancellation.token);
        if (!name) return 'managed';
        const slot = { name, kind: type.credentialKind };
        if (await vault.inspect(slot, signal) !== 'missing') { void vscode.window.showWarningMessage(t('This credential alias and type already exist.')); return 'managed'; }
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
    finally { signal.removeEventListener('abort', abort); cancellation.dispose(); if (!silent) opening = false; }
  };
}
