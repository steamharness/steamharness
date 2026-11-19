import type { WebAppFailureReason } from './web-app-types';
export type { WebAppFailureReason } from './web-app-types';

export const WEB_APP_FAILURE_REASONS = [
  'server-not-configured', 'server-unsupported', 'account-unavailable', 'server-unavailable',
  'service-unavailable', 'invalid-response', 'provider-unavailable', 'login-cancelled', 'unknown',
] as const;

export class WebAppConnectionError extends Error {
  readonly reason: WebAppFailureReason;
  constructor(reason: WebAppFailureReason, message: string = reason) {
    super(message);
    this.name = 'WebAppConnectionError';
    this.reason = reason;
  }
}

// Private layers are bundled separately, so do not depend on class identity.
// Only predefined reasons may cross into the UI; provider error text can contain credentials.
export function webAppFailureReason(error: unknown): WebAppFailureReason {
  if (error && typeof error === 'object' && 'reason' in error &&
    WEB_APP_FAILURE_REASONS.includes(error.reason as WebAppFailureReason)) return error.reason as WebAppFailureReason;
  return 'unknown';
}
