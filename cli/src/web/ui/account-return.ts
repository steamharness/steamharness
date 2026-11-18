const storageKey = 'steamharness-web-sign-in-return';

export function rememberSignInReturn(state: string, ticket: string): void {
  sessionStorage.setItem(storageKey, JSON.stringify({ state, ticket, url: location.href }));
}

/** The Server gets only a loopback callback. The original link stays in the initiating tab. */
export function restoreSignInReturn(): string | undefined {
  const state = new URLSearchParams(location.search).get('auth_state');
  if (state === null) return;
  const callback = new URL(location.href);
  callback.searchParams.delete('auth_state');
  let target = callback;
  let ticket: string | undefined;
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
    if (saved?.state === state) {
      sessionStorage.removeItem(storageKey);
      const url = new URL(saved.url);
      if (url.origin === callback.origin && url.pathname === callback.pathname && !url.username && !url.password
        && !url.searchParams.has('auth_state') && typeof saved.ticket === 'string'
        && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(saved.ticket)) {
        target = url;
        ticket = saved.ticket;
      }
    }
  } catch { /* No usable return data in this tab. Open the entry normally. */ }
  history.replaceState(history.state, '', target.href);
  return ticket;
}
