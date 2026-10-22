import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  canManageMember,
  isProjectRole,
  resolveResourceAccess,
  ROLE_RANK,
  type AccessActor,
  type AccessCapability,
  type AccessPage,
  type AccessSource,
  type ProjectRole,
  type ResourceAccess,
  type ResourceType,
} from "@steamharness/project-access";
import { HttpError } from "./protocol";

type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;
export interface GroupRecord {
  id: string;
  name: string;
  description: string;
  parentId: string | null;
  createdAt: string;
  access: ResourceAccess;
}
export interface ResourceMember {
  userId: string;
  projectId: string;
  resourceId: string;
  role: ProjectRole;
  directRole?: ProjectRole;
  createdAt: string;
  createdBy?: string;
  profile?: { userId: string; displayName: string; email: string };
  access: ResourceAccess;
}
export interface ResourceInvitation {
  id: string;
  resourceType: ResourceType;
  resourceId: string;
  resourceName?: string;
  projectId: string;
  token: string;
  role: ProjectRole;
  createdBy?: string;
  createdAt: string;
  expiresAt: string;
  acceptedBy?: string;
  acceptedAt?: string;
  revokedAt?: string;
}
export interface PageQuery {
  page?: number;
  pageSize?: number;
  q?: string;
  groupId?: string | null;
  parentId?: string | null;
  minRole?: ProjectRole;
  status?: string;
}
const ancestry = `with recursive ancestors as (
 select id as root_id,id,parent_id,name from project_groups
 union all select a.root_id,g.id,g.parent_id,g.name from ancestors a join project_groups g on g.id=a.parent_id
)`;
const rankSql = (column: string) =>
  `case ${column} when 'owner' then 40 when 'maintainer' then 30 when 'developer' then 20 when 'guest' then 10 else 0 end`;
export function pagination(query: PageQuery): {
  page: number;
  pageSize: number;
  offset: number;
} {
  const page = Number(query.page ?? 1),
    pageSize = Number(query.pageSize ?? 20);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    throw new HttpError(400, 400, "Invalid pagination.");
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset))
    throw new HttpError(400, 400, "Invalid pagination.");
  return { page, pageSize, offset };
}
function invitation(row: any): ResourceInvitation {
  return {
    id: row.id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    resourceName: row.resource_name,
    projectId: row.resource_id,
    token: row.token,
    role: row.role,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    acceptedBy: row.accepted_by ?? undefined,
    acceptedAt: row.accepted_at?.toISOString(),
    revokedAt: row.revoked_at?.toISOString(),
  };
}
/** All membership and hierarchy changes share a transaction lock, including owner checks. */
export class ProjectAccessRepository {
  constructor(private readonly pool: pg.Pool) {}
  async init(): Promise<void> {
    await this.pool.query(`create table if not exists project_groups (
      id text primary key,name text not null check(length(trim(name))>0),description text not null default '',
      parent_id text references project_groups(id),created_by text,created_at timestamptz not null default now(),
      check(parent_id is distinct from id));
      create index if not exists project_groups_parent_idx on project_groups(parent_id);
      create table if not exists group_members (
      group_id text not null references project_groups(id) on delete cascade,user_id text not null,
      role text not null check(role in ('guest','developer','maintainer','owner')),created_by text,
      created_at timestamptz not null default now(),primary key(group_id,user_id));
      create index if not exists group_members_user_idx on group_members(user_id,group_id);
      create table if not exists resource_invitations (
      id text primary key,resource_type text not null check(resource_type in ('project','group')),resource_id text not null,
      token text not null unique,role text not null check(role in ('guest','developer','maintainer','owner')),created_by text not null,
      created_at timestamptz not null default now(),expires_at timestamptz not null,accepted_by text,accepted_at timestamptz,revoked_at timestamptz);
      create index if not exists resource_invitations_resource_idx on resource_invitations(resource_type,resource_id,created_at);`);
  }
  async transaction<T>(
    operation: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select pg_advisory_xact_lock(hashtext('steamharness-resource-access'))",
      );
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  async resolve(
    type: ResourceType,
    id: string,
    actor: AccessActor,
    db: Queryable = this.pool,
    includeInactive = false,
  ): Promise<ResourceAccess> {
    const resource = await db.query(
      type === "project"
        ? "select id,name,group_id,visibility from projects where id=$1"
        : "select id,name,id as group_id,'private' as visibility from project_groups where id=$1",
      [id],
    );
    const record = resource.rows[0];
    if (!record)
      throw new HttpError(404, 404, "Project or group does not exist.");
    const sources: AccessSource[] = [];
    if (actor.userId) {
      const account = await db.query(
        "select status,is_system_admin from user_profiles where user_id=$1",
        [actor.userId],
      );
      if (
        !account.rows[0] ||
        (account.rows[0].status !== "active" && !includeInactive)
      )
        return resolveResourceAccess([]);
      actor = {
        ...actor,
        isSystemAdmin: account.rows[0].is_system_admin === true,
      };
    }
    if (actor.userId) {
      if (type === "project") {
        const direct = await db.query(
          "select role from project_members where project_id=$1 and user_id=$2",
          [id, actor.userId],
        );
        if (direct.rows[0] && isProjectRole(direct.rows[0].role))
          sources.push({
            type: "project",
            id,
            name: record.name,
            role: direct.rows[0].role,
          });
      }
      if (record.group_id) {
        const inherited = await db.query(
          `${ancestry} select a.id,a.name,m.role from ancestors a join group_members m on m.group_id=a.id where a.root_id=$1 and m.user_id=$2`,
          [record.group_id, actor.userId],
        );
        for (const row of inherited.rows)
          if (isProjectRole(row.role))
            sources.push({
              type: "group",
              id: row.id,
              name: row.name,
              role: row.role,
            });
      }
      if (type === "project" && record.visibility === "public")
        sources.push({ type: "public", id, role: "guest" });
    }
    return resolveResourceAccess(sources, actor);
  }
  async assert(
    type: ResourceType,
    id: string,
    actor: AccessActor,
    capability: AccessCapability,
    db: Queryable = this.pool,
  ): Promise<ResourceAccess> {
    const access = await this.resolve(type, id, actor, db);
    if (!access.capabilities.includes(capability))
      throw new HttpError(403, 403, "Permission denied.");
    return access;
  }
  async createGroup(
    input: { name: string; description?: string; parentId?: string | null },
    actor: AccessActor,
  ): Promise<GroupRecord> {
    if (!actor.userId)
      throw new HttpError(401, 401, "Account login is required.");
    const id = randomUUID(),
      name = input.name.trim();
    if (!name || name.length > 200)
      throw new HttpError(400, 400, "Group name is invalid.");
    await this.transaction(async (client) => {
      await this.assertActiveActor(actor, client);
      if (input.parentId)
        await this.assert(
          "group",
          input.parentId,
          actor,
          "createSubgroup",
          client,
        );
      await client.query(
        "insert into project_groups(id,name,description,parent_id,created_by) values($1,$2,$3,$4,$5)",
        [
          id,
          name,
          input.description ?? "",
          input.parentId ?? null,
          actor.userId,
        ],
      );
      if (!input.parentId)
        await client.query(
          "insert into group_members(group_id,user_id,role,created_by) values($1,$2,'owner',$2)",
          [id, actor.userId],
        );
    });
    return this.getGroup(id, actor);
  }
  private visibilitySql = `${ancestry}, readable_projects as (
    select p.* from projects p where $2::boolean or p.visibility='public' or exists(select 1 from project_members m where m.project_id=p.id and m.user_id=$1)
    or exists(select 1 from ancestors a join group_members m on m.group_id=a.id where a.root_id=p.group_id and m.user_id=$1)
  ), visible_groups as (
    select distinct a.id from ancestors a where a.root_id in (
      select group_id from readable_projects where group_id is not null
      union select a2.root_id from ancestors a2 join group_members m on m.group_id=a2.id where m.user_id=$1
    ) union select id from project_groups where $2::boolean
  )`;
  async listGroups(
    actor: AccessActor,
    query: PageQuery = {},
  ): Promise<AccessPage<GroupRecord>> {
    await this.assertActiveActor(actor);
    const { page, pageSize, offset } = pagination(query);
    const filter = `from project_groups g join visible_groups v on v.id=g.id where ($3='' or g.name ilike '%'||$3||'%') and ($4::boolean or g.parent_id is not distinct from $5::text) and ($6::int=0 or $2::boolean or exists(select 1 from ancestors a join group_members m on m.group_id=a.id where a.root_id=g.id and m.user_id=$1 and ${rankSql("m.role")}>=$6))`;
    const args = [
      actor.userId ?? null,
      actor.isSystemAdmin,
      query.q ?? "",
      query.parentId === undefined,
      query.parentId ?? null,
      query.minRole ? ROLE_RANK[query.minRole] : 0,
    ];
    const [count, rows] = await Promise.all([
      this.pool.query(`${this.visibilitySql} select count(*) ${filter}`, args),
      this.pool.query(
        `${this.visibilitySql} select g.* ${filter} order by lower(g.name),g.id limit $7 offset $8`,
        [...args, pageSize, offset],
      ),
    ]);
    return {
      items: await Promise.all(rows.rows.map((row) => this.group(row, actor))),
      total: Number(count.rows[0].count),
      page,
      pageSize,
    };
  }
  private async assertActiveActor(
    actor: AccessActor,
    db: Queryable = this.pool,
  ): Promise<void> {
    if (actor.userId) {
      const user = await db.query(
        "select status,is_system_admin from user_profiles where user_id=$1",
        [actor.userId],
      );
      if (user.rows[0]?.status !== "active")
        throw new HttpError(403, 403, "An active account is required.");
      actor.isSystemAdmin = user.rows[0].is_system_admin === true;
    } else if (!actor.isSystemAdmin)
      throw new HttpError(401, 401, "Account login is required.");
  }
  async getGroup(id: string, actor: AccessActor): Promise<GroupRecord> {
    await this.assertActiveActor(actor);
    const rows = await this.pool.query(
      `${this.visibilitySql} select g.* from project_groups g join visible_groups v on v.id=g.id where g.id=$3`,
      [actor.userId ?? null, actor.isSystemAdmin, id],
    );
    if (!rows.rows[0]) throw new HttpError(404, 404, "Group does not exist.");
    return this.group(rows.rows[0], actor);
  }
  private async group(row: any, actor: AccessActor): Promise<GroupRecord> {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      parentId: row.parent_id,
      createdAt: row.created_at.toISOString(),
      access: await this.resolve("group", row.id, actor),
    };
  }
  async updateGroup(
    id: string,
    input: { name?: string; description?: string; parentId?: string | null },
    actor: AccessActor,
  ): Promise<GroupRecord> {
    await this.transaction(async (client) => {
      await this.assert("group", id, actor, "manageSettings", client);
      if (
        input.name !== undefined &&
        (!input.name.trim() || input.name.length > 200)
      )
        throw new HttpError(400, 400, "Group name is invalid.");
      if (input.parentId !== undefined) {
        await this.assert("group", id, actor, "transfer", client);
        const source = await client.query(
          "select parent_id from project_groups where id=$1",
          [id],
        );
        if (source.rows[0]?.parent_id)
          await this.assert(
            "group",
            source.rows[0].parent_id,
            actor,
            "transfer",
            client,
          );
        if (input.parentId) {
          await this.assert("group", input.parentId, actor, "transfer", client);
          const cycle = await client.query(
            `${ancestry} select 1 from ancestors where root_id=$1 and id=$2`,
            [input.parentId, id],
          );
          if (cycle.rowCount)
            throw new HttpError(409, 409, "A group cannot contain itself.");
        }
        // Moving a formerly inherited resource to the root needs a durable owner.
        if (input.parentId === null)
          await this.ensureDirectOwner("group", id, actor, client);
      }
      await client.query(
        "update project_groups set name=coalesce($2,name),description=coalesce($3,description),parent_id=case when $4 then $5 else parent_id end where id=$1",
        [
          id,
          input.name?.trim() ?? null,
          input.description ?? null,
          input.parentId !== undefined,
          input.parentId ?? null,
        ],
      );
    });
    return this.getGroup(id, actor);
  }
  async deleteGroup(id: string, actor: AccessActor): Promise<void> {
    await this.transaction(async (client) => {
      await this.assert("group", id, actor, "delete", client);
      const children = await client.query(
        "select 1 from project_groups where parent_id=$1 union all select 1 from projects where group_id=$1 limit 1",
        [id],
      );
      if (children.rowCount)
        throw new HttpError(409, 409, "Only an empty group can be deleted.");
      await client.query(
        "delete from resource_invitations where resource_type='group' and resource_id=$1",
        [id],
      );
      await client.query("delete from project_groups where id=$1", [id]);
    });
  }
  async transferProject(
    id: string,
    groupId: string | null,
    actor: AccessActor,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.assert("project", id, actor, "transfer", client);
      const current = await client.query(
        "select group_id from projects where id=$1",
        [id],
      );
      if (current.rows[0].group_id)
        await this.assert(
          "group",
          current.rows[0].group_id,
          actor,
          "transfer",
          client,
        );
      if (groupId)
        await this.assert("group", groupId, actor, "transfer", client);
      else await this.ensureDirectOwner("project", id, actor, client);
      await client.query(
        "update projects set group_id=$2,updated_at=now() where id=$1",
        [id, groupId],
      );
    });
  }
  private async ensureDirectOwner(
    type: ResourceType,
    id: string,
    actor: AccessActor,
    db: Queryable,
  ): Promise<void> {
    if (!actor.userId)
      throw new HttpError(
        400,
        400,
        "An account is required for a personal resource.",
      );
    const table = type === "project" ? "project_members" : "group_members",
      column = type === "project" ? "project_id" : "group_id";
    const owners = await db.query(
      `select 1 from ${table} m join user_profiles u on u.user_id=m.user_id where m.${column}=$1 and m.role='owner' and u.status='active' limit 1`,
      [id],
    );
    if (!owners.rowCount)
      await db.query(
        `insert into ${table}(${column},user_id,role,created_by) values($1,$2,'owner',$2) on conflict(${column},user_id) do update set role='owner'`,
        [id, actor.userId],
      );
  }
  async listProjectIds(
    actor: AccessActor,
    query: PageQuery = {},
  ): Promise<AccessPage<string>> {
    await this.assertActiveActor(actor);
    const { page, pageSize, offset } = pagination(query);
    const filter = `from readable_projects p where ($3='' or p.name ilike '%'||$3||'%' or p.id ilike '%'||$3||'%' or p.project_info::text ilike '%'||$3||'%') and ($4::boolean or p.group_id is not distinct from $5::text) and ($6='all' or ($6='published' and p.latest_version is not null) or ($6='draft' and p.latest_version is null)) and ($7::int=0 or ($7<=10 and p.visibility='public') or $2::boolean or exists(select 1 from project_members m where m.project_id=p.id and m.user_id=$1 and ${rankSql("m.role")}>=$7) or exists(select 1 from ancestors a join group_members m on m.group_id=a.id where a.root_id=p.group_id and m.user_id=$1 and ${rankSql("m.role")}>=$7))`;
    const args = [
      actor.userId ?? null,
      actor.isSystemAdmin,
      query.q ?? "",
      query.groupId === undefined,
      query.groupId ?? null,
      query.status ?? "all",
      query.minRole ? ROLE_RANK[query.minRole] : 0,
    ];
    const [count, rows] = await Promise.all([
      this.pool.query(`${this.visibilitySql} select count(*) ${filter}`, args),
      this.pool.query(
        `${this.visibilitySql} select p.id ${filter} order by p.updated_at desc,p.id limit $8 offset $9`,
        [...args, pageSize, offset],
      ),
    ]);
    return {
      items: rows.rows.map((row) => row.id),
      total: Number(count.rows[0].count),
      page,
      pageSize,
    };
  }
  async listMembers(
    type: ResourceType,
    id: string,
    actor: AccessActor,
    query: PageQuery = {},
  ): Promise<AccessPage<ResourceMember>> {
    await this.assert(type, id, actor, "read");
    const { page, pageSize, offset } = pagination(query);
    const cte = `${ancestry}, members as (
      select user_id,created_at from ${type === "project" ? "project_members" : "group_members"} where ${type === "project" ? "project_id" : "group_id"}=$1
      union all select m.user_id,m.created_at from group_members m join ancestors a on a.id=m.group_id where a.root_id=${type === "project" ? "(select group_id from projects where id=$1)" : "$1"}
    ), users as(select user_id,min(created_at) created_at from members group by user_id)`;
    const args = [id, query.q ?? ""];
    const filter =
      "from users left join user_profiles profiles using(user_id) where ($2='' or user_id ilike '%'||$2||'%' or display_name ilike '%'||$2||'%' or email ilike '%'||$2||'%')";
    const [count, rows] = await Promise.all([
      this.pool.query(`${cte} select count(*) ${filter}`, args),
      this.pool.query(
        `${cte} select users.*,profiles.display_name,profiles.email ${filter} order by users.created_at,user_id limit $3 offset $4`,
        [...args, pageSize, offset],
      ),
    ]);
    const items = await Promise.all(
      rows.rows.map(async (row) => {
        const access = await this.resolve(type, id, {
          userId: row.user_id,
          isSystemAdmin: false,
        });
        const assigned = await this.resolve(
          type,
          id,
          { userId: row.user_id, isSystemAdmin: false },
          this.pool,
          true,
        );
        const direct = assigned.sources.find(
          (source) => source.type === type && source.id === id,
        );
        return {
          userId: row.user_id,
          projectId: id,
          resourceId: id,
          role: assigned.effectiveRole!,
          directRole: direct?.role,
          profile: row.display_name
            ? {
                userId: row.user_id,
                displayName: row.display_name,
                email: row.email,
              }
            : undefined,
          createdAt: row.created_at.toISOString(),
          access,
        };
      }),
    );
    return { items, total: Number(count.rows[0].count), page, pageSize };
  }
  private async assertMemberChange(
    type: ResourceType,
    id: string,
    userId: string,
    role: ProjectRole | undefined,
    actor: AccessActor,
    db: Queryable,
  ): Promise<void> {
    const [access, target] = await Promise.all([
      this.resolve(type, id, actor, db),
      this.resolve(type, id, { userId, isSystemAdmin: false }, db, true),
    ]);
    if (!canManageMember(access, target, role))
      throw new HttpError(403, 403, "Permission denied.");
    const user = await db.query(
      "select status from user_profiles where user_id=$1",
      [userId],
    );
    if (!user.rows[0] || (role && user.rows[0].status !== "active"))
      throw new HttpError(400, 400, "An active user account is required.");
  }
  private async changeMember(
    type: ResourceType,
    id: string,
    userId: string,
    role: ProjectRole | undefined,
    actor: AccessActor,
    db: Queryable,
    preserveHigher = false,
  ): Promise<void> {
    if (preserveHigher && role) {
      // An invitation/request never demotes an existing direct or inherited role.
      const [inviter, target] = await Promise.all([
        this.resolve(type, id, actor, db),
        this.resolve(type, id, { userId, isSystemAdmin: false }, db, true),
      ]);
      if (!canManageMember(inviter, resolveResourceAccess([]), role))
        throw new HttpError(403, 403, "The inviter no longer has permission.");
      if (
        target.effectiveRole &&
        ROLE_RANK[target.effectiveRole] >= ROLE_RANK[role]
      )
        return;
    }
    await this.assertMemberChange(type, id, userId, role, actor, db);
    const table = type === "project" ? "project_members" : "group_members",
      column = type === "project" ? "project_id" : "group_id";
    if (role)
      await db.query(
        `insert into ${table}(${column},user_id,role,created_by) values($1,$2,$3,$4) on conflict(${column},user_id) do update set role=${preserveHigher ? `case when ${rankSql(`${table}.role`)}>${rankSql("excluded.role")} then ${table}.role else excluded.role end` : "excluded.role"}`,
        [id, userId, role, actor.userId ?? null],
      );
    else
      await db.query(`delete from ${table} where ${column}=$1 and user_id=$2`, [
        id,
        userId,
      ]);
    const parent = await db.query(
      type === "project"
        ? "select group_id as parent_id from projects where id=$1"
        : "select parent_id from project_groups where id=$1",
      [id],
    );
    if (!parent.rows[0]?.parent_id) {
      const owner = await db.query(
        `select 1 from ${table} m join user_profiles u on u.user_id=m.user_id where m.${column}=$1 and m.role='owner' and u.status='active' limit 1`,
        [id],
      );
      if (!owner.rowCount)
        throw new HttpError(
          409,
          409,
          "The last owner cannot be removed or demoted.",
        );
    }
  }
  async setMember(
    type: ResourceType,
    id: string,
    userId: string,
    role: ProjectRole | undefined,
    actor: AccessActor,
  ): Promise<void> {
    if (role !== undefined && !isProjectRole(role))
      throw new HttpError(400, 400, "Invalid role.");
    await this.transaction((client) =>
      this.changeMember(type, id, userId, role, actor, client),
    );
  }
  async createInvitation(
    type: ResourceType,
    id: string,
    role: ProjectRole,
    actor: AccessActor,
  ): Promise<ResourceInvitation> {
    if (!actor.userId || !isProjectRole(role))
      throw new HttpError(400, 400, "Invitation role is invalid.");
    return this.transaction(async (client) => {
      const access = await this.resolve(type, id, actor, client);
      if (!canManageMember(access, resolveResourceAccess([]), role))
        throw new HttpError(403, 403, "Permission denied.");
      const result = await client.query(
        "insert into resource_invitations(id,resource_type,resource_id,token,role,created_by,expires_at) values($1,$2,$3,$4,$5,$6,now()+interval '7 days') returning *",
        [
          randomUUID(),
          type,
          id,
          randomBytes(24).toString("base64url"),
          role,
          actor.userId,
        ],
      );
      return invitation(result.rows[0]);
    });
  }
  async getInvitation(
    token: string,
    db: Queryable = this.pool,
  ): Promise<ResourceInvitation | undefined> {
    const result = await db.query(
      `select i.*,coalesce(p.name,g.name) as resource_name from resource_invitations i
      left join projects p on i.resource_type='project' and p.id=i.resource_id
      left join project_groups g on i.resource_type='group' and g.id=i.resource_id
      where i.token=$1 and (p.id is not null or g.id is not null)`,
      [token],
    );
    return result.rows[0] ? invitation(result.rows[0]) : undefined;
  }
  async listInvitations(
    type: ResourceType,
    id: string,
    actor: AccessActor,
  ): Promise<ResourceInvitation[]> {
    const access = await this.assert(type, id, actor, "manageMembers");
    const result = await this.pool.query(
      "select * from resource_invitations where resource_type=$1 and resource_id=$2 and ($3::boolean or role in ('guest','developer')) order by created_at desc",
      [type, id, access.capabilities.includes("manageOwners")],
    );
    return result.rows.map(invitation);
  }
  async revokeInvitation(
    type: ResourceType,
    id: string,
    invitationId: string,
    actor: AccessActor,
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      const rows = await client.query(
        "select * from resource_invitations where id=$1 and resource_type=$2 and resource_id=$3",
        [invitationId, type, id],
      );
      const row = rows.rows[0];
      if (!row) throw new HttpError(404, 404, "Invitation not found.");
      const access = await this.resolve(type, id, actor, client);
      if (!canManageMember(access, resolveResourceAccess([]), row.role))
        throw new HttpError(403, 403, "Permission denied.");
      const result = await client.query(
        "update resource_invitations set revoked_at=now() where id=$1 and accepted_at is null and revoked_at is null",
        [invitationId],
      );
      return !!result.rowCount;
    });
  }
  async acceptInvitation(
    token: string,
    userId: string,
  ): Promise<ResourceInvitation> {
    return this.transaction(async (client) => {
      await this.assertActiveActor({ userId, isSystemAdmin: false }, client);
      const pending = await this.getInvitation(token, client);
      if (!pending) throw new HttpError(404, 404, "Invitation not found.");
      if (
        pending.revokedAt ||
        pending.acceptedAt ||
        Date.parse(pending.expiresAt) <= Date.now()
      )
        throw new HttpError(409, 409, "Invitation is no longer available.");
      const inviter = await client.query(
        "select is_system_admin,status from user_profiles where user_id=$1",
        [pending.createdBy],
      );
      if (inviter.rows[0]?.status !== "active")
        throw new HttpError(403, 403, "The inviter no longer has permission.");
      const actor = {
        userId: pending.createdBy,
        isSystemAdmin: inviter.rows[0].is_system_admin,
      };
      await this.changeMember(
        pending.resourceType,
        pending.resourceId,
        userId,
        pending.role,
        actor,
        client,
        true,
      );
      const result = await client.query(
        "update resource_invitations set accepted_by=$2,accepted_at=now() where id=$1 returning *",
        [pending.id, userId],
      );
      return invitation(result.rows[0]);
    });
  }
  async approveRequest(
    projectId: string,
    requestId: string,
    status: "approved" | "rejected",
    actor: AccessActor,
  ): Promise<any> {
    return this.transaction(async (client) => {
      await this.assert("project", projectId, actor, "manageMembers", client);
      const result = await client.query(
        "select * from project_membership_requests where id=$1 and project_id=$2 and status='pending' for update",
        [requestId, projectId],
      );
      const row = result.rows[0];
      if (!row)
        throw new HttpError(409, 409, "Access request is no longer pending.");
      if (status === "approved") {
        await this.assertActiveActor(
          { userId: row.requester_user_id, isSystemAdmin: false },
          client,
        );
        await this.changeMember(
          "project",
          projectId,
          row.requester_user_id,
          "guest",
          actor,
          client,
          true,
        );
      }
      const updated = await client.query(
        "update project_membership_requests set status=$3,resolved_by_user_id=$4,resolved_at=now(),updated_at=now() where id=$1 and project_id=$2 returning *",
        [requestId, projectId, status, actor.userId ?? null],
      );
      return updated.rows[0];
    });
  }
}
