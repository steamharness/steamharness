export interface StartRecommendation {
  id: string;
  name: string;
  description?: string;
  version?: string;
  projectType?: string;
  avatarUrl?: string;
  projectCard?: unknown;
}
export interface StartRecommendationsProvider {
  id: string;
  title: string;
  openLabel: string;
  browseLabel: string;
  loadingMessage: string;
  emptyMessage: string;
  unavailableMessage: string;
  contextKey(): string;
  load(signal: AbortSignal, options?: { force?: boolean }): Promise<{ items: StartRecommendation[] }>;
  open(id?: string): unknown;
}
export interface StartRecommendationsState {
  title: string;
  openLabel: string;
  browseLabel: string;
  message?: string;
  items: StartRecommendation[];
}
