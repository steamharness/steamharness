import * as vscode from 'vscode';
import type { AccountSectionProvider } from './account-section-types';
import { registerProjectUploadProvider } from './project-upload-extension';

interface LayerAccount {
  setAiConnection?: (connection: { serverUrl: string; accessToken: string } | undefined) => void;
  getConnection?: () => { serverUrl: string; accessToken: string } | undefined;
  onDidChange?: (listener: () => unknown) => vscode.Disposable;
  registerSectionProvider?: (provider: AccountSectionProvider) => vscode.Disposable;
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
  const processValue = Reflect.get(globalThis, 'process') as { env?: Record<string, string | undefined> } | undefined;
  const env = processValue?.env;
  if (env?.STEAMHARNESS_STUDIO_INTERNAL !== '1' || !env.STEAMHARNESS_STUDIO_INTERNAL_MODULE) return;
  try {
    const loader = Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<{
      activate?: (options: {
        context: vscode.ExtensionContext;
        vscode: typeof import('vscode');
        output: vscode.OutputChannel;
        account?: LayerAccount;
        uploads: { registerProvider: typeof registerProjectUploadProvider };
      }) => Promise<void> | void;
    }>;
    const layer = await loader(env.STEAMHARNESS_STUDIO_INTERNAL_MODULE);
    await layer.activate?.({ context, vscode, output, account, uploads: { registerProvider: registerProjectUploadProvider } });
  } catch (error) {
    output.appendLine(`[internal-layer] ${String(error)}`);
  }
}
