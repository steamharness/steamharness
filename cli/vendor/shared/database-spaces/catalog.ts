import { DATABASE_IDENTIFIER_PATTERN, DATABASE_UUID_PATTERN, isDatabasePermissionSubset, normalizeDatabasePermissions, type DatabaseActor, type DatabaseAuthorization, type DatabaseBinding, type DatabaseConsumer, type DatabaseGrant, type DatabaseHost, type DatabasePermissions, type DatabaseRequest, type DatabaseSpace } from "./index";

export interface DatabaseCatalogState {
  spaces: DatabaseSpace[];
  requests: DatabaseRequest[];
  grants: DatabaseGrant[];
  bindings: DatabaseBinding[];
}
export interface CreateDatabaseRequest extends DatabaseConsumer {
  alias: string;
  target: DatabaseRequest["target"];
  permissions: DatabasePermissions;
}
/** Mutations must run in the host repository's transaction. No implicit approval. */
export class DatabaseCatalog {
  constructor(readonly host: DatabaseHost, readonly state: DatabaseCatalogState, private readonly id: () => string, private readonly now: () => string) {}

  request(input: CreateDatabaseRequest, actor: DatabaseActor): DatabaseRequest {
    if (!actor.userId) throw new Error("Authentication is required.");
    if (!DATABASE_UUID_PATTERN.test(input.projectId) || !DATABASE_IDENTIFIER_PATTERN.test(input.entryId) || !DATABASE_IDENTIFIER_PATTERN.test(input.alias)) throw new Error("Invalid database consumer identity.");
    const permissions = normalizeDatabasePermissions(input.permissions);
    if (input.target.kind === "create") {
      if (typeof input.target.name !== "string" || !input.target.name.trim() || input.target.name.length > 256) throw new Error("A database space name is required.");
    } else if (input.target.kind === "access") {
      const spaceId = input.target.spaceId;
      if (!this.state.spaces.some((space) => space.spaceId === spaceId && space.host === this.host)) throw new Error("Database space does not exist on this host.");
    } else throw new Error("Invalid database request target.");
    const target = input.target.kind === "create" ? { kind: "create" as const, name: input.target.name } : { kind: "access" as const, spaceId: input.target.spaceId };
    if (this.state.requests.some((request) => request.status === "pending" && request.projectId === input.projectId && request.entryId === input.entryId && JSON.stringify(request.target) === JSON.stringify(target))) throw new Error("This database already has a pending request.");
    if (input.target.kind === "access" && this.resolve(input.target.spaceId, input)) throw new Error("This consumer already has access to this database.");
    // Request payloads are untrusted. Approval metadata and binding references
    // can only be written by review(), and must never affect catalog visibility.
    const request: DatabaseRequest = { projectId: input.projectId, entryId: input.entryId, alias: input.alias, target, permissions, requestId: this.id(), host: this.host, applicantId: actor.userId, status: "pending", createdAt: this.now() };
    this.state.requests.push(request);
    return structuredClone(request);
  }

  review(requestId: string, decision: { approve: boolean; permissions?: DatabasePermissions; reason?: string }, actor: DatabaseActor): DatabaseRequest {
    const request = this.state.requests.find((item) => item.requestId === requestId);
    if (!request) throw new Error("Database request does not exist.");
    if (request.status !== "pending") throw new Error("Database request has already been reviewed.");
    const existingSpace = request.target.kind === "access" ? this.space(request.target.spaceId) : undefined;
    if (!actor.isSystemAdmin && (!existingSpace || existingSpace.ownerId !== actor.userId)) throw new Error("Only the host administrator or existing space owner can review this request.");
    const permissions = normalizeDatabasePermissions(decision.permissions ?? request.permissions);
    if (!isDatabasePermissionSubset(permissions, request.permissions)) throw new Error("Approval cannot widen requested database permissions.");
    if (decision.reason !== undefined && (typeof decision.reason !== "string" || decision.reason.length > 4096)) throw new Error("Invalid review reason.");
    if (decision.approve) {
      if (existingSpace && this.resolve(existingSpace.spaceId, request)) throw new Error("This consumer already has access to this database.");
      const space = existingSpace ?? { spaceId: this.id(), name: request.target.kind === "create" ? request.target.name.trim() : "", host: this.host, ownerId: request.applicantId, createdAt: this.now() };
      if (!existingSpace) this.state.spaces.push(space);
      const grant: DatabaseGrant = { grantId: this.id(), spaceId: space.spaceId, projectId: request.projectId, entryId: request.entryId, permissions, credentialVersion: 1, createdAt: this.now() };
      const binding: DatabaseBinding = { bindingRef: this.id(), alias: request.alias, host: this.host, spaceId: space.spaceId, grantId: grant.grantId, projectId: request.projectId, entryId: request.entryId };
      this.state.grants.push(grant);
      this.state.bindings.push(binding);
      request.databaseId = space.spaceId;
      request.bindingRef = binding.bindingRef;
    }
    request.status = decision.approve ? "approved" : "rejected";
    request.reviewerId = actor.userId;
    request.reviewedAt = this.now();
    if (decision.reason !== undefined) request.reason = decision.reason;
    return structuredClone(request);
  }

  revoke(grantId: string, actor: DatabaseActor): DatabaseGrant {
    const grant = this.manageGrant(grantId, actor);
    grant.revokedAt ??= this.now();
    return structuredClone(grant);
  }
  rotate(grantId: string, actor: DatabaseActor): DatabaseGrant {
    const grant = this.manageGrant(grantId, actor);
    if (grant.revokedAt) throw new Error("A revoked grant cannot be rotated.");
    grant.credentialVersion += 1;
    return structuredClone(grant);
  }
  narrow(grantId: string, permissions: DatabasePermissions, actor: DatabaseActor): DatabaseGrant {
    const grant = this.manageGrant(grantId, actor);
    const normalized = normalizeDatabasePermissions(permissions);
    if (grant.revokedAt || !isDatabasePermissionSubset(normalized, grant.permissions)) throw new Error("An active grant may only be narrowed. Request new access to widen it.");
    grant.permissions = normalized;
    grant.credentialVersion += 1;
    return structuredClone(grant);
  }
  authorization(bindingRef: string): DatabaseAuthorization | undefined {
    const binding = this.state.bindings.find((item) => item.bindingRef === bindingRef);
    if (!binding) return undefined;
    const grant = this.state.grants.find((item) => item.grantId === binding.grantId);
    const space = this.state.spaces.find((item) => item.spaceId === binding.spaceId);
    return grant && space ? structuredClone({ binding, grant, space }) : undefined;
  }
  resolve(databaseId: string, consumer: DatabaseConsumer): DatabaseAuthorization | undefined {
    const binding = this.state.bindings.find((item) => item.spaceId === databaseId && item.projectId === consumer.projectId && item.entryId === consumer.entryId && this.state.grants.some((grant) => grant.grantId === item.grantId && !grant.revokedAt));
    return binding ? this.authorization(binding.bindingRef) : undefined;
  }
  visible(actor: DatabaseActor): DatabaseCatalogState {
    if (actor.isSystemAdmin) return structuredClone(this.state);
    const owned = new Set(this.state.spaces.filter((space) => space.ownerId === actor.userId).map((space) => space.spaceId));
    const requests = this.state.requests.filter((request) => request.applicantId === actor.userId || (request.target.kind === "access" && owned.has(request.target.spaceId)));
    const refs = new Set(requests.map((request) => request.bindingRef));
    const bindings = this.state.bindings.filter((binding) => owned.has(binding.spaceId) || refs.has(binding.bindingRef));
    const grantIds = new Set(bindings.map((binding) => binding.grantId));
    const spaceIds = new Set(bindings.map((binding) => binding.spaceId));
    return structuredClone({ spaces: this.state.spaces.filter((space) => owned.has(space.spaceId) || spaceIds.has(space.spaceId)), requests, bindings, grants: this.state.grants.filter((grant) => grantIds.has(grant.grantId)) });
  }
  private space(spaceId: string): DatabaseSpace {
    const space = this.state.spaces.find((item) => item.spaceId === spaceId && item.host === this.host);
    if (!space) throw new Error("Database space does not exist on this host.");
    return space;
  }
  private manageGrant(grantId: string, actor: DatabaseActor): DatabaseGrant {
    const grant = this.state.grants.find((item) => item.grantId === grantId);
    if (!grant) throw new Error("Database grant does not exist.");
    const space = this.space(grant.spaceId);
    if (!actor.isSystemAdmin && space.ownerId !== actor.userId) throw new Error("Only the space owner or host administrator can manage grants.");
    return grant;
  }
}
