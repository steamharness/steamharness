import { t } from './localization';
import type { AccountState } from './workflow-auth-client';

export function accountMenuState(state: AccountState) {
  const statusLabels: Record<AccountState['status'], string> = {
    'signed-out': t('Signed Out'), checking: t('Connecting to Server'), authenticated: t('Server Connected'),
    expired: t('Server Sign-in Expired'), error: t('Server Connection Error'),
  };
  return {
    status: state.status, statusLabel: statusLabels[state.status], serverUrl: state.serverUrl,
    name: state.user?.displayName || state.user?.email || t('Signed Out'),
    email: state.user?.email, avatarUrl: state.user?.avatarUrl, hasAccount: !!state.user, error: state.error,
    labels: {
      title: t('SteamHarness Account'), profile: t('Personal Information'), signIn: t('Sign In'),
      refresh: t('Refresh Account'), refreshing: t('Refreshing Account...'), signOut: t('Sign out'),
      server: t('Server'), close: t('Close'),
    },
  };
}
