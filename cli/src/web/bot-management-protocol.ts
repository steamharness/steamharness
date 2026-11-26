export type BotPanelKind = 'artifacts' | 'memory';

export type BotPanelRequest = { kind: 'artifacts'; route: string; method: string }
  | { kind: 'memory'; input: object }
  | { kind: 'save'; id: string };

export type BotPanelResponse = { status: number; json?: unknown; preview?: { bytes: ArrayBuffer; mime: string; truncated: boolean } };

export const botArtifactId = /^ba_[a-f0-9]{32}$/u;
export const botArtifactRoute = /^(?:\?before=[1-9]\d*|\/ba_[a-f0-9]{32}(?:\/content\?preview=1)?)?$/u;
