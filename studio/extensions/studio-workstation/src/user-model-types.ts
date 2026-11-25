import type { ConfiguredAgentModel, AgentModelCatalogEntry } from '../../../../shared/project-configuration/agent-models';
import type { UserModelPlans } from './user-model-plan-types';

export type { ConfiguredAgentModel, AgentModelCatalogEntry };
export type UserModelEntry = Exclude<ConfiguredAgentModel, { source: 'third-party' }>
  | (Omit<Extract<ConfiguredAgentModel, { source: 'third-party' }>, 'apiKey'> & { hasApiKey: boolean });
export interface UserModelsState {
  revision: number; entries: UserModelEntry[]; systemAvailable: boolean; error?: string;
  catalogLoading?: boolean; catalogError?: string; providerNames?: Record<string, string>;
  plans?: { loading: boolean; failed: boolean; catalog?: UserModelPlans };
}
export interface UserModelCatalog { entries: AgentModelCatalogEntry[]; unavailable?: boolean; subscriptionUrl?: string }
export interface UserModelCatalogProvider {
  load(signal: AbortSignal): Promise<UserModelCatalog>;
  loadPlans?(signal: AbortSignal): Promise<UserModelPlans>;
}
export type UserModelWriteLock = <T>(run: () => Promise<T>) => Promise<T>;
