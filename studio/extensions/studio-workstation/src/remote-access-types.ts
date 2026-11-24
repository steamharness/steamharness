export interface RemoteAccessState {
  mode: 'desktop' | 'local' | 'remote';
  running: boolean;
  localUrls: string[];
  remoteUrls: string[];
  devices: { id: string; label: string; lastSeenAt: number; expiresAt: number }[];
  pairExpiresAt?: number;
  pair?: { code: string; expiresAt: number; link: string; qr: string };
}

export type RemoteAccessAction = { action: 'status' | 'start' | 'stop' | 'logout' } |
  { action: 'generate'; origin: string } | { action: 'revoke'; id: string };
export type RemoteAccessHandler = (action: RemoteAccessAction) => Promise<RemoteAccessState | { error: string }>;
