export interface AccountState {
  status: 'signed-out' | 'checking' | 'authenticated' | 'expired' | 'error';
  serverUrl: string;
  aiServerUrl?: string;
  aiConfigured?: boolean;
  user?: { userId: string; email: string; displayName: string; avatarUrl?: string };
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
