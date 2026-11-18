export interface BrowserSignIn { url: string; userCode: string; expiresAt: string; state: string }

export interface AccountState {
  status: 'signed-out' | 'checking' | 'authenticated' | 'expired' | 'error';
  serverUrl: string;
  signInPending?: boolean;
  aiServerUrl?: string;
  aiConfigured?: boolean;
  user?: { userId: string; email: string | null; displayName: string; avatarUrl?: string };
  expiresAt?: string;
  error?: string;
  revision: number;
}

export interface SystemAiUsage {
  balance: number;
  groups: { groupId: number; name: string; subscriptionType: string; subscription?: {
    status: string; dailyLimitUsd: number | null; dailyUsageUsd: number;
    weeklyLimitUsd: number | null; weeklyUsageUsd: number;
    monthlyLimitUsd: number | null; monthlyUsageUsd: number;
  } }[];
}
