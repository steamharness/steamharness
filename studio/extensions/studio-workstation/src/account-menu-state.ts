import { generatedAvatarUrl } from '../../../../shared/avatar-fallback/index';
import { t } from './localization';
import type { AccountState } from './workflow-auth-client';

export function accountMenuState(state: AccountState, platform: boolean, digest?: (value: string) => string) {
  const statusLabels: Record<AccountState['status'], string> = {
    'signed-out': t('Signed Out'), checking: t('Connecting to Server'), authenticated: t('Server Connected'),
    expired: t('Server Sign-in Expired'), error: t('Server Connection Error'),
  };
  return {
    status: state.status, statusLabel: statusLabels[state.status], localProfile: !platform,
    scopeKey: platform && state.user?.userId ? digest?.(JSON.stringify([state.serverUrl, state.user.userId])) : undefined,
    name: state.user?.displayName || state.user?.email || t('Signed Out'),
    email: state.user?.email, avatarUrl: state.user?.avatarUrl || generatedAvatarUrl(state.user?.userId), hasAccount: !!state.user, error: state.error,
    labels: {
      title: t('SteamHarness Account'), profile: t('Personal Information'), signIn: t('Sign In'),
      refresh: t('Refresh Account'), refreshing: t('Refreshing Account...'), signOut: t('Sign out'),
      close: t('Close'),
    },
  };
}
