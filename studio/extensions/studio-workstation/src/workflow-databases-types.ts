import type { DatabaseHost, DatabasePermissions, DatabaseSpace } from '@steamharness/database-spaces';
import type { DatabaseCatalogState, CreateDatabaseRequest } from '@steamharness/database-spaces/catalog';
import type { ResourceRequest } from './workflow-resources-types';
import type { Project } from './workflow-types';

export interface HostDatabaseRequest {
  kind: 'host';
  action: 'catalog' | 'request' | 'review' | 'revoke' | 'rotate' | 'narrow' | 'resource';
  host?: DatabaseHost;
  spaceId?: string;
  request?: CreateDatabaseRequest;
  requestId?: string;
  grantId?: string;
  approve?: boolean;
  permissions?: DatabasePermissions;
  reason?: string;
  input?: ResourceRequest;
}
export interface HostDatabaseCatalog {
  local: DatabaseCatalogState;
  server?: DatabaseCatalogState;
  serverError?: string;
}
export interface DatabaseTarget {
  key: string;
  space: DatabaseSpace;
  project?: Project;
  alias?: string;
}
