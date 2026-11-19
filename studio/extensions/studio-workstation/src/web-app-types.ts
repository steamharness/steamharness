export type WebAppFailureReason =
  | 'server-not-configured' | 'server-unsupported' | 'account-unavailable' | 'server-unavailable'
  | 'service-unavailable' | 'invalid-response' | 'provider-unavailable' | 'login-cancelled' | 'unknown';

export interface WebAppBinding {
  service: string;
  apiBaseUrl: string;
  bootstrap: unknown;
  accountUrl?: string;
  /** A signed-out preview has no API access and offers an explicit host action. */
  login?: { kind: 'studio' | 'external'; serverUrl: string; environment?: string };
}
export interface WebAppRequest {
  projectId: string;
  entryId: string;
  service: string;
  configuration?: { id: string; name: string; params: Record<string, unknown> };
  connection?: { serverUrl: string; accessToken: string };
  serverUrl?: string;
  /** Background checks must never launch an interactive sign-in. */
  interactive?: boolean;
  signal: AbortSignal;
}
export interface WebAppSession { binding: WebAppBinding; dispose(): Promise<void> | void }
export interface WebAppProvider {
  matches(input: Pick<WebAppRequest, 'projectId' | 'entryId' | 'service'>): boolean;
  open(input: WebAppRequest): Promise<WebAppSession>;
}
