import * as vscode from 'vscode';
import type { AccountSectionProvider } from './account-section-types';
import { registerProjectUploadProvider } from './project-upload-extension';
import type { UserModelCatalogProvider } from './user-model-types';

interface LayerAccount {
  setAiConnection?: (connection: { serverUrl: string; accessToken: string } | undefined) => void;
  getConnection?: () => { serverUrl: string; accessToken: string } | undefined;
  onDidChange?: (listener: () => unknown) => vscode.Disposable;
  registerSectionProvider?: (provider: AccountSectionProvider) => vscode.Disposable;
  registerModelCatalogProvider?: (provider: UserModelCatalogProvider) => vscode.Disposable;
}

interface InternalLayer {
  prepare?: () => Promise<void> | void;
  activate?: (options: {
    context: vscode.ExtensionContext;
    vscode: typeof import('vscode');
    output: vscode.OutputChannel;
    account?: LayerAccount;
    uploads: { registerProvider: typeof registerProjectUploadProvider };
  }) => Promise<void> | void;
}

let loaded: { specifier: string; promise: Promise<InternalLayer> } | undefined;

async function loadInternalLayer(): Promise<InternalLayer | undefined> {
  const processValue = Reflect.get(globalThis, 'process') as { env?: Record<string, string | undefined> } | undefined;
  const env = processValue?.env;
  if (env?.STEAMHARNESS_STUDIO_INTERNAL !== '1' || !env.STEAMHARNESS_STUDIO_INTERNAL_MODULE) return;
  const specifier = env.STEAMHARNESS_STUDIO_INTERNAL_MODULE;
  if (loaded?.specifier === specifier) return loaded.promise;
  const loader = Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<InternalLayer>;
  const promise = loader(specifier);
  loaded = { specifier, promise };
  void promise.catch(() => { if (loaded?.promise === promise) loaded = undefined; });
  return promise;
}

/** Prepare optional host defaults before any project runtime is resolved. */
export async function prepareInternalLayer(): Promise<void> {
  const layer = await loadInternalLayer();
  await layer?.prepare?.();
}

/**
 * The public Studio has no internal AI implementation. A private launcher may
 * inject an extension layer through an absolute module path at runtime.
 * Keeping this hook inert by default makes the public build independent of the
 * private checkout. Account sections use the host's generic display contract.
 */
export async function activateInternalLayer(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  account?: LayerAccount,
): Promise<void> {
  try {
    const layer = await loadInternalLayer();
    await layer?.activate?.({ context, vscode, output, account, uploads: { registerProvider: registerProjectUploadProvider } });
  } catch (error) {
    output.appendLine(`[internal-layer] ${String(error)}`);
  }
}
