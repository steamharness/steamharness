import { afterEach, expect, it } from 'vitest';
import { initI18n } from '@steamharness/i18n';
import { usageAmount, usagePeriods } from '../web/ui/ai-usage';
import type { WorkflowSystemAiUsage } from '../web/workflow-auth-client';

type Subscription = NonNullable<WorkflowSystemAiUsage['groups'][number]['subscription']>;
const subscription: Subscription = { status: 'active', dailyLimitUsd: 10, dailyUsageUsd: 8,
  weeklyLimitUsd: 20, weeklyUsageUsd: 25, monthlyLimitUsd: null, monthlyUsageUsd: 30 };
afterEach(() => initI18n({ preference: 'zh-CN' }));

it.each(['en', 'zh-CN'] as const)('shows remaining quotas, over-limit usage and unlimited periods in %s', language => {
  initI18n({ preference: language });
  const [daily, weekly, monthly] = usagePeriods(subscription);
  expect(daily).toMatchObject({ label: language === 'en' ? 'Daily' : '\u6bcf\u65e5', used: 8, limit: 10, remaining: 2, ratio: .8, status: 'near-limit' });
  expect(weekly).toMatchObject({ used: 25, limit: 20, remaining: 0, ratio: 1.25, status: 'exhausted' });
  expect(monthly).toMatchObject({ used: 30, limit: null, remaining: undefined, ratio: undefined, status: '' });
  expect(usageAmount(10.125)).toBe('$10.13');
});

it('distinguishes zero quota from missing data and never renders NaN or negative remaining amounts', () => {
  initI18n({ preference: 'en' });
  const [daily, weekly, monthly] = usagePeriods({ ...subscription, dailyLimitUsd: 0, dailyUsageUsd: 0,
    weeklyUsageUsd: Number.NaN, monthlyLimitUsd: undefined as unknown as number });
  expect(daily).toMatchObject({ remaining: 0, ratio: 1, status: 'exhausted' });
  expect(weekly).toMatchObject({ used: undefined, ratio: undefined, remaining: undefined });
  expect(monthly.limit).toBeUndefined();
  expect(usageAmount(Number.NaN)).toBe('Not available');
  expect(usageAmount(Number.POSITIVE_INFINITY)).toBe('Not available');
  expect(usageAmount(-10)).toBe('$0.00');
});
