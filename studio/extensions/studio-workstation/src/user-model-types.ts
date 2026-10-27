import type { ConfiguredAgentModel, AgentModelCatalogEntry } from '../../../../shared/project-configuration/agent-models';

export type { ConfiguredAgentModel, AgentModelCatalogEntry };
export type UserModelEntry = Exclude<ConfiguredAgentModel, { source: 'third-party' }>
  | (Omit<Extract<ConfiguredAgentModel, { source: 'third-party' }>, 'apiKey'> & { hasApiKey: boolean });
export interface UserModelsState { revision: number; entries: UserModelEntry[]; systemAvailable: boolean; error?: string }
export interface UserModelCatalog { entries: AgentModelCatalogEntry[]; unavailable?: boolean; subscriptionUrl?: string }
export interface UserModelCatalogProvider { load(signal: AbortSignal): Promise<UserModelCatalog> }
