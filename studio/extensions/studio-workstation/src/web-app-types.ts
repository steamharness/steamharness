export type WebAppFailureReason =
  | 'server-not-configured' | 'server-unsupported' | 'account-unavailable' | 'server-unavailable'
  | 'service-unavailable' | 'invalid-response' | 'provider-unavailable' | 'unknown';

export interface WebAppBinding {
  service: string;
  apiBaseUrl: string;
  bootstrap: unknown;
  accountUrl?: string;
}
export interface WebAppRequest {
  projectId: string;
  entryId: string;
  service: string;
  connection: { serverUrl: string; accessToken: string };
  signal: AbortSignal;
}
export interface WebAppSession { binding: WebAppBinding; dispose(): Promise<void> | void }
export interface WebAppProvider {
  matches(input: Pick<WebAppRequest, 'projectId' | 'entryId' | 'service'>): boolean;
  open(input: WebAppRequest): Promise<WebAppSession>;
}
