import * as vscode from 'vscode';

/**
 * The public Studio has no internal AI implementation. A private launcher may
 * inject an extension layer through an absolute module path at runtime.
 * Keeping this hook inert by default makes the public build independent of the
 * private checkout and keeps its account surface unchanged.
 */
export async function activateInternalLayer(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  account?: {
    setAiConnection?: (connection: { serverUrl: string; accessToken: string } | undefined) => void;
    getConnection?: () => { serverUrl: string; accessToken: string } | undefined;
    onDidChange?: (listener: () => unknown) => vscode.Disposable;
  },
): Promise<void> {
  const processValue = Reflect.get(globalThis, 'process') as { env?: Record<string, string | undefined> } | undefined;
  const env = processValue?.env;
  if (env?.WORKFLOW_STUDIO_INTERNAL !== '1' || !env.WORKFLOW_STUDIO_INTERNAL_MODULE) return;
  try {
    const loader = Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<{
      activate?: (options: {
        context: vscode.ExtensionContext;
        vscode: typeof import('vscode');
        output: vscode.OutputChannel;
        account?: {
          setAiConnection?: (connection: { serverUrl: string; accessToken: string } | undefined) => void;
          getConnection?: () => { serverUrl: string; accessToken: string } | undefined;
          onDidChange?: (listener: () => unknown) => vscode.Disposable;
        };
      }) => Promise<void> | void;
    }>;
    const layer = await loader(env.WORKFLOW_STUDIO_INTERNAL_MODULE);
    await layer.activate?.({ context, vscode, output, account });
  } catch (error) {
    output.appendLine(`[internal-layer] ${String(error)}`);
  }
}
