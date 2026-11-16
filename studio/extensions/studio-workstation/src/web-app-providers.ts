import type { WebAppProvider, WebAppRequest, WebAppSession } from './web-app-types';
export type { WebAppBinding, WebAppProvider, WebAppRequest, WebAppSession } from './web-app-types';

const providers = new Set<WebAppProvider>();
export function registerWebAppProvider(provider: WebAppProvider): { dispose(): void } {
  providers.add(provider); return { dispose: () => { providers.delete(provider); } };
}
export async function openWebApp(input: WebAppRequest): Promise<WebAppSession> {
  const matches = [...providers].filter(provider => provider.matches(input));
  if (matches.length !== 1) throw new Error('No unique host provider is registered for this Web application.');
  input.signal.throwIfAborted();
  const session = await matches[0].open(input);
  if (input.signal.aborted) { await session.dispose(); input.signal.throwIfAborted(); }
  if (session.binding.service !== input.service) { await session.dispose(); throw new Error('Web application service mismatch.'); }
  return session;
}
