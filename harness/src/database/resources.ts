/** Business database resources are explicitly provisioned; aliases remain project-local. */
export const DATABASE_ENGINE_VERSION = "7.10.1";

export interface DatabaseResource {
  readonly id: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly migrationOwnerUserId: string;
  readonly status: "requested" | "provisioning" | "ready" | "failed";
  readonly stage: "requested" | "roles" | "database" | "permissions" | "ready";
  readonly failureCode: string | null;
  readonly schemaHash: string | null;
  readonly migrationName: string | null;
  readonly migrationStatus: "idle" | "running" | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type DatabaseAccessMode = "read" | "write";
export interface DatabaseGrant {
  readonly databaseId: string;
  readonly userId: string;
  readonly mode: DatabaseAccessMode;
  readonly revision: number;
  readonly revoked: boolean;
}

/** A versioned SQL migration and the authored model at its end. No executable project configuration. */
export interface DatabaseMigration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
  readonly schema: string;
  readonly schemaHash: string;
}

export interface DatabaseMigrationState {
  readonly name: string;
  readonly checksum: string;
  readonly schemaHash: string;
  readonly appliedAt: string;
}

export interface DatabaseMigrationPlan {
  readonly sql: string | null;
  readonly schemaHash: string;
  readonly destructive: boolean;
}

export type DatabaseResourceErrorCode = "DATABASE_INVALID_REQUEST" | "DATABASE_NOT_FOUND" | "DATABASE_ACCESS_DENIED"
  | "DATABASE_NOT_READY" | "DATABASE_BUSY" | "DATABASE_UNAVAILABLE" | "DATABASE_PROVISION_FAILED"
  | "DATABASE_UNSAFE_CLUSTER" | "DATABASE_HISTORY_CONFLICT" | "DATABASE_SCHEMA_DRIFT" | "DATABASE_SCHEMA_INVALID"
  | "DATABASE_MIGRATION_FAILED" | "DATABASE_DESTRUCTIVE_MIGRATION" | "DATABASE_SCHEMA_MISMATCH";

export class DatabaseResourceError extends Error {
  constructor(readonly code: DatabaseResourceErrorCode, message: string) {
    super(message); this.name = "DatabaseResourceError";
  }
}
