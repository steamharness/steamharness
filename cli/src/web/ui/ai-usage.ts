import { t } from '../localization';
import type { WorkflowSystemAiUsage } from '../workflow-auth-client';

type Subscription = NonNullable<WorkflowSystemAiUsage['groups'][number]['subscription']>;
export function usageAmount(value: number): string {
  return value != null && Number.isFinite(Number(value)) ? `$${Math.max(0, Number(value)).toFixed(2)}` : t("Not available");
}

export function usagePeriods(subscription: Subscription) {
  const labels = { daily: t("Daily"), weekly: t("Weekly"), monthly: t("Monthly") };
  return (['daily', 'weekly', 'monthly'] as const).map(period => {
    const rawUsed = subscription[`${period}UsageUsd`], rawLimit = subscription[`${period}LimitUsd`];
    const used = Number.isFinite(Number(rawUsed)) && rawUsed != null ? Math.max(0, Number(rawUsed)) : undefined;
    const limit = rawLimit === null ? null : Number.isFinite(Number(rawLimit)) && rawLimit !== undefined ? Math.max(0, Number(rawLimit)) : undefined;
    const ratio = used !== undefined && limit !== null && limit !== undefined ? limit > 0 ? used / limit : 1 : undefined;
    return { period, label: labels[period], used, limit, ratio,
      status: ratio === undefined ? '' : ratio >= 1 ? 'exhausted' : ratio >= .8 ? 'near-limit' : '',
      remaining: used !== undefined && limit !== null && limit !== undefined ? Math.max(0, limit - used) : undefined };
  });
}
