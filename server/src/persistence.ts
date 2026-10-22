import { HttpError } from "./protocol";
import { ProjectAccessRepository } from "./project-access";
import type { ProjectRole } from "@steamharness/project-access";
import type { ProjectConfigurationState, ConfigurationPublicationDraft, ProjectConfigurationTemplate } from "@steamharness/project-configuration";

import { createHash } from "node:crypto";
import type pg from "pg";
import type { ProjectDataSummary } from "./storage";
import { KNOWLEDGE_DOCUMENT_KEY_PREFIX } from "steamharness";
import type { File, KVEntryPage, KVEntryDetail, KVEntrySummary, KVEntryValueType, TokenUsageDetail, TokenUsagePage } from "./storage";
import { normalizeProjectKVStoreInput, TOKEN_USAGE_ENTRY_KEY_PREFIX, TOKEN_USAGE_TOTAL_KEY, createEmptyTokenUsageAggregate, readStoredTokenUsageEntry, readStoredTokenUsageAggregate, type KVStore, type KVStoreGetInput, type KVNamespaceLockInput, type KVStoreSetInput, type KVWriteSource, type TokenUsageAggregate, type TokenUsageEntry } from "steamharness";
import { createPostgresPool } from "./postgres";
import { createProjectKVNamespaceLockKey, withPostgresProjectKVNamespaceLock, STEAMHARNESS_KV_NAMESPACE_LOCK_FAMILY } from "./kv-namespace-lock";
import { normalizeProjectCardMetadata, type ProjectCardMetadata } from "@steamharness/project-card-metadata";
import { normalizeProjectInfo, writeProjectInfo, type DeclaredProjectInfo, type ProjectInfoContract } from "@steamharness/project-info";
import { isProjectKind, STEAMHARNESS_PROJECT_TYPES, type ProjectKind } from "@steamharness/project-types";
import type { ObjectStorage } from "./object-storage";
import { parseProjectGroupManifest, type ProjectAccessRequest, type ProjectAccessRequestStatus, type ProjectDependencyLock, type ProjectGroupManifestV1 } from "@steamharness/project-dependencies";
const STEAMHARNESS_PROJECT_TYPES_SQL = createPostgresTextList(STEAMHARNESS_PROJECT_TYPES);
// PostgreSQL assigns a new xmin to each externally visible row version. It is
// a stronger compare-and-set token than updated_at, whose transaction-start
// timestamp can be shared by multiple writes.
const STEAMHARNESS_KV_REVISION_SQL = "xmin::text";
const STEAMHARNESS_KV_REVISION_CHANNEL = "project_storage_revision";
const STEAMHARNESS_KV_REVISION_RECONNECT_DELAY_MS = 1_000;
const STEAMHARNESS_KV_REVISION_RECONNECT_MAX_DELAY_MS = 30_000;

export interface ProjectStorageRevisionEvent {
  projectId: string;
  revision: string;
}

function createPostgresTextList(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}

export interface DbRecord {
  id: string;
  name: string;
  projectType: ProjectKind;
  projectCard: ProjectCardMetadata;
  projectInfo: ProjectInfoContract;
  packageVersion: string;
  hasDraft: boolean;
  latest: string | null;
  ownerUserId?: string;
  groupId?: string | null;
  visibility: "private" | "public";
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DbVersionRecord { projectId: string; projectName: string; version: string; createdAt: string; createdByUserId?: string; releaseLog: string; sourceHash: string; sourceObjectPath: string; dependencies: ProjectDependencyLock[]; }

export interface KanbanConfigurationRecord {
  id: string;
  name: string;
  values: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanConfigurationStateRecord {
  configurations: KanbanConfigurationRecord[];
  activeConfigurationId?: string;
}

export interface DbVersionSummaryRecord { projectId: string; projectName: string; version: string; }

export interface SaveProjectDraftInput {
  projectId: string;
  projectName: string;
  projectType: ProjectKind;
  packageVersion: string;
  projectCard: ProjectCardMetadata;
  projectInfo: ProjectInfoContract;
  files: File[];
  ownerUserId?: string;
  groupId?: string | null;
  visibility?: "private" | "public";
  createdByUserId?: string;
}

export interface CreateProjectInput {
  projectId: string;
  projectName: string;
  projectType: ProjectKind;
  projectCard: ProjectCardMetadata;
  projectInfo: DeclaredProjectInfo;
  packageVersion?: string;
  ownerUserId?: string;
  groupId?: string | null;
  visibility?: "private" | "public";
  createdByUserId?: string;
}

export interface SaveProjectVersionInput {
  projectId: string;
  projectName: string;
  version: string;
  createdAt: string;
  createdByUserId?: string;
  releaseLog: string;
  sourceHash: string;
  sourceObjectPath: string;
  dependencies?: ProjectDependencyLock[];
  updateLatest?: boolean;
}

export type DeploymentStatus =
  | "planned"
  | "preparing"
  | "prepared"
  | "publishing"
  | "published"
  | "failed";

export type DeploymentItemStatus =
  | "planned"
  | "preparing"
  | "prepared"
  | "publishing"
  | "published"
  | "failed";

export interface DeploymentItemRecord {
  deploymentId: string;
  projectId: string;
  alias?: string;
  role: "root" | "dependency";
  delivery: "included";
  status: DeploymentItemStatus;
  stage?: string;
  plannedVersion?: string;
  preparedSourceHash?: string;
  preparedConfigurationRevision?: number;
  publishedVersion?: string;
  publishedSourceHash?: string;
  error?: string;
  updatedAt: string;
}

export interface DeploymentRecord {
  id: string;
  rootProjectId: string;
  status: DeploymentStatus;
  manifest: ProjectGroupManifestV1;
  releaseLog: string;
  createdByUserId: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  items: DeploymentItemRecord[];
}

export type { ProjectRole } from "@steamharness/project-access";
export type Visibility = "private" | "public";

export interface ProjectMemberRecord {
  projectId: string;
  userId: string;
  role: ProjectRole;
  createdBy?: string;
  createdAt: string;
}

// Project invitations use the fixed business roles and are rechecked against
// the inviter's current access when accepted, including owner invitations.
export interface ProjectInvitationRecord {
  id: string;
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

export class DatabaseRepository implements KVStore {
  private readonly pool: pg.Pool;
  readonly access: ProjectAccessRepository;
  private readonly publishLockPool: pg.Pool;
  private readonly projectKVRevisionReconnectDelayMs = STEAMHARNESS_KV_REVISION_RECONNECT_DELAY_MS;

  constructor(connectionString: string) {
    this.pool = createPostgresPool({
      connectionString,
      label: "project storage",
    });
    this.access = new ProjectAccessRepository(this.pool);
    this.publishLockPool = createPostgresPool({
      connectionString,
      label: "project publish lock",
    });
  }

  async getAccessAccount(userId:string):Promise<{status:string;isSystemAdmin:boolean}|undefined> {
    const result=await this.pool.query("select status,is_system_admin from user_profiles where user_id=$1",[userId]);
    const row=result.rows[0];return row?{status:row.status,isSystemAdmin:row.is_system_admin}:undefined;
  }
  async close(): Promise<void> { await Promise.all([this.pool.end(), this.publishLockPool.end()]); }

  async init(): Promise<void> {
    await this.access.init();
    await this.pool.query(`
      create table if not exists projects (
        id text primary key,
        name text not null,
        project_type text not null check (project_type in (${STEAMHARNESS_PROJECT_TYPES_SQL})),
        project_card jsonb,
        project_info jsonb not null default '{}'::jsonb,
        package_version text not null default '0.0.0',
        has_draft boolean not null default false,
        latest_version text,
        owner_user_id text,
        group_id text references project_groups(id),
        visibility text not null default 'private',
        created_by_user_id text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      alter table projects
        add column if not exists group_id text references project_groups(id);

      create table if not exists project_draft_files (
        project_id text not null references projects(id) on delete cascade,
        path text not null,
        content text not null,
        size integer not null,
        encoding text check (encoding is null or encoding = 'base64'),
        updated_at timestamptz not null default now(),
        primary key (project_id, path)
      );

      create table if not exists project_versions (
        project_id text not null references projects(id) on delete cascade,
        version text not null,
        project_name text not null,
        created_at timestamptz not null,
        source_hash text not null,
        source_object_path text not null,
        release_log text not null default '',
        created_by_user_id text,
        primary key (project_id, version)
      );

      create table if not exists project_version_downloads (
        project_id text not null,
        version text not null,
        download_count bigint not null default 0 check (download_count >= 0),
        primary key (project_id, version),
        foreign key (project_id, version)
          references project_versions(project_id, version)
          on delete cascade
      );


      create table if not exists project_members (
        project_id text not null references projects(id) on delete cascade,
        user_id text not null,
        role text not null check(role in ('guest','developer','maintainer','owner')),
        created_by text,
        created_at timestamptz not null default now(),
        primary key (project_id, user_id)
      );

      create table if not exists project_storage (
        storage_kind text not null check (storage_kind in ('kv', 'persistent_value')),
        scope text not null check (scope in ('project', 'conversation')),
        project_id text not null references projects(id) on delete cascade,
        conversation_id text not null default '',
        key text not null,
        value jsonb not null,
        last_project_id text,
        last_run_id text,
        last_conversation_id text,
        updated_at timestamptz not null default now(),
        primary key (storage_kind, scope, project_id, conversation_id, key),
        check (
          (scope = 'project' and conversation_id = '') or
          (scope = 'conversation' and conversation_id <> '')
        )
      );

      create table if not exists project_storage_revisions (
        storage_kind text not null check (storage_kind in ('kv', 'persistent_value')),
        project_id text not null references projects(id) on delete cascade,
        revision bigint not null default 0,
        updated_at timestamptz not null default now(),
        primary key (storage_kind, project_id)
      );








      create table if not exists project_configuration_drafts (
        project_id text primary key references projects(id) on delete cascade,
        draft jsonb not null
      );
      create table if not exists project_configuration_templates (
        project_id text not null,
        version text not null,
        template jsonb not null,
        primary key(project_id, version),
        foreign key(project_id, version) references project_versions(project_id, version) on delete cascade
      );
      create table if not exists project_configurations (
        project_id text not null references projects(id) on delete cascade,
        user_id text not null,
        state jsonb not null,
        primary key (project_id, user_id)
      );

      create table if not exists project_kanban_configurations (
        project_id text not null references projects(id) on delete cascade,
        user_id text not null,
        configuration_id text not null,
        name text not null,
        values jsonb not null default '{}'::jsonb,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        primary key (project_id, user_id, configuration_id)
      );

      create table if not exists project_kanban_active_configurations (
        project_id text not null,
        user_id text not null,
        configuration_id text not null,
        primary key (project_id, user_id),
        foreign key (project_id, user_id, configuration_id)
          references project_kanban_configurations(project_id, user_id, configuration_id)
          on delete cascade
      );

      create table if not exists project_deployments (
        id text primary key,
        root_project_id text not null references projects(id) on delete cascade,
        status text not null,
        manifest jsonb not null,
        release_log text not null default '',
        created_by_user_id text not null,
        error text,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        published_at timestamptz
      );

      create table if not exists project_deployment_items (
        deployment_id text not null references project_deployments(id) on delete cascade,
        project_id text not null references projects(id) on delete cascade,
        alias text,
        role text not null,
        delivery text not null default 'included',
        status text not null,
        stage text,
        planned_version text,
        prepared_source_hash text,
        published_version text,
        published_source_hash text,
        error text,
        updated_at timestamptz not null,
        primary key (deployment_id, project_id)
      );

      create table if not exists related_project_dependencies (
        project_id text not null,
        version text not null,
        alias text not null,
        dependency_project_id text not null,
        delivery text not null,
        dependency_version text,
        source_hash text,
        created_at timestamptz not null default now(),
        primary key (project_id, version, alias),
        foreign key (project_id, version)
          references project_versions(project_id, version)
          on delete cascade
      );

      create table if not exists project_access_requests (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        requester_user_id text not null,
        reason text not null,
        status text not null,
        resolved_by_user_id text,
        resolved_at timestamptz,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );

      alter table project_deployment_items add column if not exists prepared_configuration_revision integer;

      create index if not exists project_versions_created_at_idx
        on project_versions(project_id, created_at desc);
      create index if not exists project_members_user_idx
        on project_members(user_id, project_id);
      create index if not exists project_kanban_configurations_user_updated_idx
        on project_kanban_configurations(project_id, user_id, updated_at desc);
      create index if not exists project_deployments_root_idx
        on project_deployments(root_project_id, created_at desc);
      create index if not exists project_deployment_items_project_idx
        on project_deployment_items(project_id, updated_at desc);
      create unique index if not exists project_deployment_items_active_version_idx
        on project_deployment_items(project_id, planned_version)
        where planned_version is not null
          and published_version is null
          and status in ('planned', 'preparing', 'prepared', 'publishing');
      create index if not exists related_project_dependencies_project_idx
        on related_project_dependencies(project_id, dependency_version);
      create index if not exists project_storage_project_updated_idx
        on project_storage(storage_kind, project_id, scope, updated_at desc);
      create index if not exists project_storage_last_run_idx
        on project_storage(last_project_id, last_run_id);
      create index if not exists project_access_requests_project_idx
        on project_access_requests(project_id, created_at desc);
      create unique index if not exists project_access_requests_pending_idx
        on project_access_requests(project_id, requester_user_id)
        where status = 'pending';

    `);
    await this.pool.query(`
      create or replace view project_storage_kv_view as
      select
        storage_kind,
        scope,
        project_id,
        conversation_id,
        key,
        value,
        jsonb_typeof(value) as value_type,
        pg_column_size(value) as value_size_bytes,
        updated_at,
        last_project_id,
        last_run_id,
        last_conversation_id
      from project_storage
      where storage_kind = 'kv'
    `);
    await this.pool.query(`
      create or replace function notify_project_storage_revision()
      returns trigger
      language plpgsql
      as $$
      declare
        changed_storage_kind text;
        changed_project_id text;
        next_revision bigint;
      begin
        changed_storage_kind := case when tg_op = 'DELETE' then old.storage_kind else new.storage_kind end;
        changed_project_id := case when tg_op = 'DELETE' then old.project_id else new.project_id end;
        if changed_storage_kind = 'kv' then
          insert into project_storage_revisions (storage_kind, project_id, revision, updated_at)
          values (changed_storage_kind, changed_project_id, 1, now())
          on conflict (storage_kind, project_id) do update set
            revision = project_storage_revisions.revision + 1,
            updated_at = now()
          returning revision into next_revision;

          perform pg_notify(
            '${STEAMHARNESS_KV_REVISION_CHANNEL}',
            json_build_object(
              'projectId', changed_project_id,
              'revision', next_revision::text
            )::text
          );
        end if;
        if tg_op = 'DELETE' then return old; end if;
        return new;
      end;
      $$;

      drop trigger if exists project_storage_revision_trigger on project_storage;
      create trigger project_storage_revision_trigger
      after insert or update or delete on project_storage
      for each row execute function notify_project_storage_revision();
    `);
  }

  async listProjects(): Promise<DbRecord[]> {
    const result = await this.pool.query<Row>(`
      select id, name, project_type, project_card, project_info, package_version, has_draft, latest_version,
        owner_user_id, group_id, visibility, created_by_user_id,
        created_at, updated_at
      from projects
      order by name asc, id asc
    `);

    return result.rows.map(toProjectRecord);
  }

  async getProject(projectId: string): Promise<DbRecord | undefined> {
    const result = await this.pool.query<Row>(
      `select id, name, project_type, project_card, project_info, package_version, has_draft, latest_version,
        owner_user_id, group_id, visibility, created_by_user_id,
        created_at, updated_at
       from projects
       where id = $1`,
      [projectId],
    );

    return result.rows[0] === undefined ? undefined : toProjectRecord(result.rows[0]);
  }

  async updateProjectCard(
    projectId: string,
    projectCard: ProjectCardMetadata,
  ): Promise<DbRecord | undefined> {
    const result = await this.pool.query<Row>(
      `update projects
       set project_card = $2::jsonb, updated_at = now()
       where id = $1
       returning id, name, project_type, project_card, project_info, package_version, has_draft, latest_version,
         owner_user_id, group_id, visibility, created_by_user_id, created_at, updated_at`,
      [projectId, JSON.stringify(projectCard)],
    );

    return result.rows[0] === undefined ? undefined : toProjectRecord(result.rows[0]);
  }

  async updateProjectInfo(
    projectId: string,
    projectName: string,
    projectInfo: DeclaredProjectInfo,
  ): Promise<DbRecord | undefined> {
    return (await this.updateProjectInfos([
      { projectId, projectName, projectInfo },
    ]))[0];
  }

  async updateProjectInfos(
    updates: Array<{
      projectId: string;
      projectName: string;
      projectInfo: DeclaredProjectInfo;
    }>,
  ): Promise<DbRecord[]> {
    const client = await this.pool.connect();
    const records: DbRecord[] = [];
    try {
      await client.query("begin");
      for (const update of updates) {
        const result = await client.query<Row>(
          `update projects
           set name = $2, project_info = $3::jsonb, updated_at = now()
           where id = $1
           returning id, name, project_type, project_card, project_info, package_version, has_draft, latest_version,
             owner_user_id, group_id, visibility, created_by_user_id, created_at, updated_at`,
          [update.projectId, update.projectName, JSON.stringify(update.projectInfo)],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw new Error(`Workflow "${update.projectId}" does not exist.`);
        }
        if (row.has_draft === true) {
          const packageResult = await client.query<Pick<FileRow, "content">>(
            `select content
             from project_draft_files
             where project_id = $1 and path = 'package.json'
             for update`,
            [update.projectId],
          );
          const packageContent = packageResult.rows[0]?.content;
          if (packageContent !== undefined) {
            const parsed = JSON.parse(packageContent) as unknown;
            if (!isRecord(parsed)) throw new Error("Workflow draft package.json root must be an object.");
            const content = `${JSON.stringify(writeProjectInfo(
              {
                ...parsed,
                name: update.projectName,
              },
              update.projectInfo,
            ), null, 2)}\n`;
            await client.query(
              `update project_draft_files
               set content = $3, size = $4, updated_at = now()
               where project_id = $1 and path = $2`,
              [update.projectId, "package.json", content, Buffer.byteLength(content)],
            );
          }
        }
        records.push(toProjectRecord(row));
      }
      await client.query("commit");
      return records;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async createProjectRecord(input: CreateProjectInput, actor: import("@steamharness/project-access").AccessActor): Promise<DbRecord> {
    const client=await this.pool.connect();
    try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('steamharness-resource-access'))");
    if (!actor.userId) throw new HttpError(401,401,"Account login is required to create a project.");
    const account=await client.query("select status from user_profiles where user_id=$1",[actor.userId]);
    if(account.rows[0]?.status!=="active") throw new HttpError(403,403,"An active account is required.");
    if (input.groupId) await this.access.assert("group",input.groupId,actor,"createProject",client);
    const result = await client.query<Row>(
      `insert into projects (
         id,
         name,
         project_type,
         project_card,
         project_info,
         package_version,
         has_draft,
         latest_version,
         owner_user_id,
         visibility,
         created_by_user_id,
         created_at,
         updated_at,
         group_id
       )
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, false, null, $7, $8, $9, now(), now(), $10)
       on conflict (id) do nothing
       returning id, name, project_type, project_card, project_info, package_version, has_draft, latest_version,
         owner_user_id, group_id, visibility, created_by_user_id, created_at, updated_at`,
      [
        input.projectId,
        input.projectName,
        input.projectType,
        JSON.stringify(input.projectCard),
        JSON.stringify(input.projectInfo),
        input.packageVersion ?? "0.0.0",
        input.ownerUserId ?? null,
        input.visibility ?? "private",
        input.createdByUserId ?? null,
        input.groupId ?? null,
      ],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`Workflow "${input.projectId}" already exists.`);
    }

    if (!input.groupId && input.ownerUserId) await client.query("insert into project_members(project_id,user_id,role,created_by) values($1,$2,'owner',$2)",[input.projectId,input.ownerUserId]);
    await client.query("commit");
    return toProjectRecord(row);
    } catch(error) {await client.query("rollback");throw error;} finally {client.release();}
  }

  async listProjectMemberRecords(projectId: string): Promise<ProjectMemberRecord[]> {
    const result = await this.pool.query<ProjectMemberRow>(
      `select project_id, user_id, role, created_by, created_at
       from project_members
       where project_id = $1
       order by
         case role
           when 'owner' then 0
           when 'maintainer' then 1
           when 'developer' then 2
           when 'guest' then 3
           else 4
         end,
         created_at asc,
         user_id asc`,
      [projectId],
    );

    return result.rows.map(toProjectMemberRecord);
  }

  async getProjectMember(
    projectId: string,
    userId: string,
  ): Promise<ProjectMemberRecord | undefined> {
    const result = await this.pool.query<ProjectMemberRow>(
      `select project_id, user_id, role, created_by, created_at
       from project_members
       where project_id = $1 and user_id = $2`,
      [projectId, userId],
    );

    return result.rows[0] === undefined
      ? undefined
      : toProjectMemberRecord(result.rows[0]);
  }

  async upsertProjectMember(input: {
    projectId: string;
    userId: string;
    role: ProjectRole;
    createdBy?: string;
  }): Promise<ProjectMemberRecord> {
    const result = await this.pool.query<ProjectMemberRow>(
      `insert into project_members (
         project_id,
         user_id,
         role,
         created_by,
         created_at
       )
       values ($1, $2, $3, $4, now())
       on conflict (project_id, user_id) do update set
         role = excluded.role,
         created_by = excluded.created_by
       returning project_id, user_id, role, created_by, created_at`,
      [
        input.projectId,
        input.userId,
        input.role,
        input.createdBy ?? null,
      ],
    );

    return toProjectMemberRecord(result.rows[0]!);
  }

  async deleteProjectMember(projectId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `delete from project_members
       where project_id = $1 and user_id = $2`,
      [projectId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async createProjectDeployment(input: {
    id: string;
    rootProjectId: string;
    manifest: ProjectGroupManifestV1;
    releaseLog: string;
    createdByUserId: string;
  }): Promise<DeploymentRecord> {
    const now = new Date();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into project_deployments (
           id, root_project_id, status, manifest, release_log,
           created_by_user_id, created_at, updated_at
         ) values ($1, $2, 'planned', $3::jsonb, $4, $5, $6, $6)`,
        [
          input.id,
          input.rootProjectId,
          JSON.stringify(input.manifest),
          input.releaseLog,
          input.createdByUserId,
          now,
        ],
      );
      for (const project of input.manifest.projects) {
        await client.query(
          `insert into project_deployment_items (
             deployment_id, project_id, alias, role, delivery,
             status, updated_at
           ) values ($1, $2, $3, $4, 'included', 'planned', $5)`,
          [input.id, project.projectId, project.alias ?? null, project.role, now],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return (await this.getProjectDeployment(input.id))!;
  }

  async getProjectDeployment(id: string): Promise<DeploymentRecord | undefined> {
    const result = await this.pool.query<DeploymentRow>(
      `select id, root_project_id, status, manifest, release_log,
        created_by_user_id, error, created_at, updated_at, published_at
       from project_deployments where id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const items = await this.pool.query<DeploymentItemRow>(
      `select deployment_id, project_id, alias,
        role, delivery, status,
        stage, planned_version, prepared_source_hash, prepared_configuration_revision, published_version,
        published_source_hash, error, updated_at
       from project_deployment_items
       where deployment_id = $1
       order by case role when 'dependency' then 0 else 1 end,
         alias asc nulls last`,
      [id],
    );
    return toProjectDeploymentRecord(row, items.rows);
  }

  async updateProjectDeployment(input: {
    id: string;
    status: DeploymentStatus;
    error?: string;
    publishedAt?: string;
  }): Promise<DeploymentRecord | undefined> {
    const result = await this.pool.query(
      `update project_deployments
       set status = $2,
         error = $3,
         published_at = coalesce($4, published_at),
         updated_at = now()
       where id = $1`,
      [input.id, input.status, input.error ?? null, input.publishedAt ?? null],
    );
    if ((result.rowCount ?? 0) === 0) return undefined;
    return this.getProjectDeployment(input.id);
  }

  async transitionProjectDeploymentStatus(input: {
    id: string;
    from: DeploymentStatus[];
    status: DeploymentStatus;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `update project_deployments
       set status = $3, error = null, updated_at = now()
       where id = $1 and status = any($2::text[])`,
      [input.id, input.from, input.status],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateProjectDeploymentItem(input: {
    deploymentId: string;
    projectId: string;
    status: DeploymentItemStatus;
    stage?: string;
    plannedVersion?: string;
    preparedSourceHash?: string;
    preparedConfigurationRevision?: number;
    publishedVersion?: string;
    publishedSourceHash?: string;
    resetPublication?: boolean;
    error?: string;
  }): Promise<void> {
    await this.pool.query(
      `update project_deployment_items
       set status = $3,
         stage = $4,
         planned_version = coalesce($5, planned_version),
         prepared_source_hash = coalesce($6, prepared_source_hash),
         prepared_configuration_revision = coalesce($11, prepared_configuration_revision),
         published_version = case when $10 then null else coalesce($7, published_version) end,
         published_source_hash = case when $10 then null else coalesce($8, published_source_hash) end,
         error = $9,
         updated_at = now()
       where deployment_id = $1 and project_id = $2`,
      [
        input.deploymentId,
        input.projectId,
        input.status,
        input.stage ?? null,
        input.plannedVersion ?? null,
        input.preparedSourceHash ?? null,
        input.publishedVersion ?? null,
        input.publishedSourceHash ?? null,
        input.error ?? null,
        input.resetPublication === true,
        input.preparedConfigurationRevision ?? null,
      ],
    );
  }

  async listProjectVersionReservations(
    projectId: string,
    excludeDeploymentId?: string,
  ): Promise<string[]> {
    const result = await this.pool.query<{ planned_version: string }>(
      `select planned_version
       from project_deployment_items
       where project_id = $1
         and planned_version is not null
         and published_version is null
         and status in ('planned', 'preparing', 'prepared', 'publishing')
         and ($2::text is null or deployment_id <> $2)
       order by planned_version asc`,
      [projectId, excludeDeploymentId ?? null],
    );
    return result.rows.map((row) => row.planned_version);
  }

  async hasProjectVersionReservation(input: {
    deploymentId: string;
    projectId: string;
    version: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `select 1
       from project_deployment_items
       where deployment_id = $1
         and project_id = $2
         and planned_version = $3
         and published_version is null
         and status in ('planned', 'preparing', 'prepared', 'publishing')`,
      [input.deploymentId, input.projectId, input.version],
    );
    return result.rows.length > 0;
  }

  async resetProjectDeploymentItemsForPreparation(deploymentId: string): Promise<void> {
    await this.pool.query(
      `update project_deployment_items
       set status = 'planned',
         stage = 'version_reserved',
         planned_version = null,
         prepared_source_hash = null,
         prepared_configuration_revision = null,
         published_version = null,
         published_source_hash = null,
         error = null,
         updated_at = now()
       where deployment_id = $1`,
      [deploymentId],
    );
  }

  async releaseProjectDeploymentVersionReservations(deploymentId: string): Promise<void> {
    await this.pool.query(
      `update project_deployment_items
       set status = 'failed',
         stage = 'reservation_failed',
         planned_version = null,
         error = 'Version reservation failed.',
         updated_at = now()
       where deployment_id = $1 and published_version is null`,
      [deploymentId],
    );
  }

  async createProjectAccessRequest(input: {
    id: string;
    projectId: string;
    requesterUserId: string;
    reason: string;
  }): Promise<ProjectAccessRequest> {
    const result = await this.pool.query<ProjectAccessRequestRow>(
      `insert into project_access_requests (
         id, project_id, requester_user_id, reason, status,
         created_at, updated_at
       ) values ($1, $2, $3, $4, 'pending', now(), now())
       on conflict (project_id, requester_user_id)
         where status = 'pending'
       do update set updated_at = project_access_requests.updated_at
       returning id, project_id, requester_user_id, reason, status,
         resolved_by_user_id, resolved_at, created_at, updated_at`,
      [input.id, input.projectId, input.requesterUserId, input.reason],
    );
    return toProjectAccessRequest(result.rows[0]!);
  }

  async listProjectAccessRequests(
    projectId: string,
  ): Promise<ProjectAccessRequest[]> {
    const result = await this.pool.query<ProjectAccessRequestRow>(
      `select id, project_id, requester_user_id, reason, status,
        resolved_by_user_id, resolved_at, created_at, updated_at
       from project_access_requests
       where project_id = $1
       order by case status when 'pending' then 0 else 1 end, created_at desc`,
      [projectId],
    );
    return result.rows.map(toProjectAccessRequest);
  }

  async getProjectAccessRequest(
    projectId: string,
    requestId: string,
  ): Promise<ProjectAccessRequest | undefined> {
    const result = await this.pool.query<ProjectAccessRequestRow>(
      `select id, project_id, requester_user_id, reason, status,
        resolved_by_user_id, resolved_at, created_at, updated_at
       from project_access_requests
       where project_id = $1 and id = $2`,
      [projectId, requestId],
    );
    return result.rows[0] === undefined ? undefined : toProjectAccessRequest(result.rows[0]);
  }

  async resolveProjectAccessRequest(input: {
    projectId: string;
    requestId: string;
    status: "approved" | "rejected";
    resolvedByUserId?: string;
  }): Promise<ProjectAccessRequest | undefined> {
    const account=input.resolvedByUserId?await this.getAccessAccount(input.resolvedByUserId):undefined;
    const row=await this.access.approveRequest(input.projectId,input.requestId,input.status,{userId:input.resolvedByUserId,isSystemAdmin:account?.isSystemAdmin===true});
    return toProjectAccessRequest(row);
  }

  async updateProjectAccess(input: {
    projectId: string;
    ownerUserId?: string;
  groupId?: string | null;
    visibility?: Visibility;
    createdByUserId?: string;
  }): Promise<DbRecord | undefined> {
    const result = await this.pool.query<Row>(
      `update projects
       set
         owner_user_id = coalesce($2, owner_user_id),
         visibility = coalesce($3, visibility),
         created_by_user_id = coalesce(created_by_user_id, $4),
         updated_at = now()
       where id = $1
       returning id, name, project_type, project_card, project_info, package_version, has_draft, latest_version,
         owner_user_id, group_id, visibility, created_by_user_id, created_at, updated_at`,
      [
        input.projectId,
        input.ownerUserId ?? null,
        input.visibility ?? null,
        input.createdByUserId ?? null,
      ],
    );

    return result.rows[0] === undefined ? undefined : toProjectRecord(result.rows[0]);
  }

  async saveDraft(input: SaveProjectDraftInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into projects (
           id,
           name,
           project_type,
           project_card,
           project_info,
           package_version,
           has_draft,
           owner_user_id,
           visibility,
           created_by_user_id,
           updated_at
         )
         values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, true, $7, $8, $9, now())
         on conflict (id) do update set
           package_version = excluded.package_version,
           has_draft = true,
           owner_user_id = coalesce(projects.owner_user_id, excluded.owner_user_id),
           visibility = projects.visibility,
           created_by_user_id = coalesce(projects.created_by_user_id, excluded.created_by_user_id),
           updated_at = now()`,
        [
          input.projectId,
          input.projectName,
          input.projectType,
          JSON.stringify(input.projectCard),
          JSON.stringify(input.projectInfo),
          input.packageVersion,
          input.ownerUserId ?? null,
          input.visibility ?? "private",
          input.createdByUserId ?? null,
        ],
      );
      await client.query("delete from project_draft_files where project_id = $1", [
        input.projectId,
      ]);

      for (const file of input.files) {
        await client.query(
          `insert into project_draft_files (project_id, path, content, size, encoding, updated_at)
           values ($1, $2, $3, $4, $5, now())`,
          [input.projectId, file.path, file.content, file.size, file.encoding ?? null],
        );
      }

      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async withProjectPublishLock<T>(
    projectId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const client = await this.publishLockPool.connect();
    try {
      // Database-backed deployments can run multiple server
      // instances; keep lock traffic on a separate pool so held advisory-lock
      // connections cannot exhaust the storage query pool.
      await client.query(
        "select pg_advisory_lock(hashtext($1), hashtext($2))",
        ["project_publish", projectId],
      );
      return await operation();
    } finally {
      try {
        await client.query(
          "select pg_advisory_unlock(hashtext($1), hashtext($2))",
          ["project_publish", projectId],
        );
      } finally {
        client.release();
      }
    }
  }

  async withProjectDeploymentLock<T>(
    deploymentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const client = await this.publishLockPool.connect();
    try {
      await client.query(
        "select pg_advisory_lock(hashtext($1), hashtext($2))",
        ["project_deployment", deploymentId],
      );
      return await operation();
    } finally {
      try {
        await client.query(
          "select pg_advisory_unlock(hashtext($1), hashtext($2))",
          ["project_deployment", deploymentId],
        );
      } finally {
        client.release();
      }
    }
  }

  async readDraftFiles(projectId: string): Promise<File[]> {
    const result = await this.pool.query<FileRow>(
      `select path, content, size, encoding
       from project_draft_files
       where project_id = $1
       order by path asc`,
      [projectId],
    );

    return result.rows.map((row) => ({
      path: row.path,
      content: row.content,
      size: row.size,
      ...(row.encoding === "base64" ? { encoding: "base64" as const } : {}),
    }));
  }

  async saveVersion(input: SaveProjectVersionInput): Promise<void> {
    const updateLatest = input.updateLatest ?? true;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into project_versions (
           project_id, version, project_name, created_at, source_hash,
           source_object_path, release_log, created_by_user_id
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.projectId,
          input.version,
          input.projectName,
          input.createdAt,
          input.sourceHash,
          input.sourceObjectPath,
          input.releaseLog,
          input.createdByUserId ?? null,
        ],
      );
      for (const dependency of input.dependencies ?? []) {
        await client.query(
          `insert into related_project_dependencies (
             project_id, version, alias, dependency_project_id,
             delivery, dependency_version, source_hash, created_at
           ) values ($1, $2, $3, $4, $5, $6, $7, now())`,
          [
            input.projectId,
            input.version,
            dependency.alias,
            dependency.projectId,
            dependency.delivery,
            dependency.version ?? null,
            dependency.sourceHash ?? null,
          ],
        );
      }
      await client.query(
        `update projects
         set latest_version = case when $4 then $3 else latest_version end,
           updated_at = now()
         where id = $1 and $2::text is not null`,
        [input.projectId, input.projectName, input.version, updateLatest],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async markVersionLatest(input: { projectId: string; projectName: string; version: string }): Promise<void> {
    await this.pool.query(`update projects set latest_version = $3, updated_at = now()
      where id = $1 and $2::text is not null and exists (select 1 from project_versions where project_id = $1 and version = $3)`,
      [input.projectId, input.projectName, input.version]);
  }

  async deleteVersion(projectId: string, version: string): Promise<void> {
    await this.pool.query(
      `delete from project_versions
       where project_id = $1 and version = $2`,
      [projectId, version],
    );
  }

  async updateProjectName(projectId: string, projectName: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update projects
         set name = $2, updated_at = now()
         where id = $1`,
        [projectId, projectName],
      );
      await client.query(
        `update project_versions
         set project_name = $2
         where project_id = $1`,
        [projectId, projectName],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getVersion(
    projectId: string,
    version: string,
  ): Promise<DbVersionRecord | undefined> {
    const result = await this.pool.query<VersionRow>(
      `select project_id, project_name, version, created_at, source_hash,
        source_object_path, release_log, created_by_user_id
       from project_versions
       where project_id = $1 and version = $2`,
      [projectId, version],
    );

    if (result.rows[0] === undefined) return undefined;
    const record = toVersionRecord(result.rows[0]);
    record.dependencies = (await this.listVersionDependencies(projectId, version))
      .map((dependency) => dependency.lock);
    return record;
  }

  async listVersions(projectId: string): Promise<DbVersionRecord[]> {
    const result = await this.pool.query<VersionRow>(
      `select project_id, project_name, version, created_at, source_hash,
        source_object_path, release_log, created_by_user_id
       from project_versions
       where project_id = $1
       order by version asc`,
      [projectId],
    );

    const dependencies = await this.listVersionDependencies(projectId);
    const dependenciesByVersion = new Map<string, ProjectDependencyLock[]>();
    for (const dependency of dependencies) {
      const items = dependenciesByVersion.get(dependency.version) ?? [];
      items.push(dependency.lock);
      dependenciesByVersion.set(dependency.version, items);
    }
    return result.rows.map((row) => ({
      ...toVersionRecord(row),
      dependencies: dependenciesByVersion.get(row.version) ?? [],
    }));
  }

  async listVersionDownloadCounts(projectId: string): Promise<Map<string, number>> {
    const result = await this.pool.query<{ version: string; download_count: string }>(
      `select version, download_count from project_version_downloads where project_id = $1`,
      [projectId],
    );
    return new Map(result.rows.map(row => [row.version, Number(row.download_count)]));
  }

  async recordSourceDownloads(downloads: readonly { projectId: string; version: string }[]): Promise<void> {
    if (downloads.length === 0) return;
    await this.pool.query(
      `insert into project_version_downloads (project_id, version, download_count)
       select project_id, version, 1
       from (
         select distinct project_id, version
         from unnest($1::text[], $2::text[]) as downloads(project_id, version)
       ) as downloads
       inner join project_versions using (project_id, version)
       order by project_id, version
       on conflict (project_id, version) do update
       set download_count = project_version_downloads.download_count + 1`,
      [downloads.map(item => item.projectId), downloads.map(item => item.version)],
    );
  }

  async listVersionDependencies(
    projectId: string,
    version?: string,
  ): Promise<Array<{ version: string; lock: ProjectDependencyLock }>> {
    const values: unknown[] = [projectId];
    const versionFilter = version === undefined ? "" : " and version = $2";
    if (version !== undefined) values.push(version);
    const result = await this.pool.query<VersionDependencyRow>(
      `select version, alias, dependency_project_id, delivery,
        dependency_version, source_hash
       from related_project_dependencies
       where project_id = $1${versionFilter}
       order by version asc, alias asc`,
      values,
    );
    return result.rows.map((row) => ({
      version: row.version,
      lock: toProjectDependencyLock(row),
    }));
  }

  async listVersionsForProjects(
    projectIds: readonly string[],
  ): Promise<Map<string, DbVersionSummaryRecord[]>> {
    if (projectIds.length === 0) {
      return new Map();
    }

    const result = await this.pool.query<VersionSummaryRow>(
      `select project_id, project_name, version
       from project_versions
       where project_id = any($1::text[])
       order by project_id asc, version asc`,
      [projectIds],
    );

    const versions = new Map<string, DbVersionSummaryRecord[]>();
    for (const row of result.rows) {
      const record = toVersionSummaryRecord(row);
      const records = versions.get(record.projectId);
      if (records === undefined) {
        versions.set(record.projectId, [record]);
      } else {
        records.push(record);
      }
    }
    return versions;
  }

  async configurationPublicationDraft(projectId: string, update?: (stored: unknown) => ConfigurationPublicationDraft): Promise<ConfigurationPublicationDraft | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([projectId,"configuration-publication"])]);
      const result = await client.query<{draft:ConfigurationPublicationDraft}>("select draft from project_configuration_drafts where project_id=$1 for update",[projectId]);
      const next = update ? update(result.rows[0]?.draft) : result.rows[0]?.draft;
      if(update) await client.query("insert into project_configuration_drafts(project_id,draft) values($1,$2::jsonb) on conflict(project_id) do update set draft=excluded.draft",[projectId,JSON.stringify(next)]);
      await client.query("commit"); return next;
    } catch(error) {await client.query("rollback");throw error;} finally {client.release();}
  }
  async saveConfigurationTemplate(projectId:string, version:string, template:ProjectConfigurationTemplate):Promise<void> {
    await this.pool.query("insert into project_configuration_templates(project_id,version,template) values($1,$2,$3::jsonb)",[projectId,version,JSON.stringify(template)]);
  }
  async readConfigurationTemplate(projectId:string,version:string):Promise<ProjectConfigurationTemplate|undefined> {
    return (await this.pool.query<{template:ProjectConfigurationTemplate}>("select template from project_configuration_templates where project_id=$1 and version=$2",[projectId,version])).rows[0]?.template;
  }

  async projectConfigurationState(projectId: string, userId: string,
    update: (stored: unknown) => ProjectConfigurationState): Promise<ProjectConfigurationState> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // Covers the absent-row case as well as concurrent writers on different Server instances.
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([projectId, userId, "configuration"])]);
      const stored = await client.query<{state: ProjectConfigurationState}>("select state from project_configurations where project_id=$1 and user_id=$2 for update", [projectId,userId]);
      const next = update(stored.rows[0]?.state);
      await client.query("insert into project_configurations(project_id,user_id,state) values($1,$2,$3::jsonb) on conflict(project_id,user_id) do update set state=excluded.state", [projectId,userId,JSON.stringify(next)]);
      await client.query("commit"); return next;
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async readKanbanConfigurationState(
    projectId: string,
    userId: string,
  ): Promise<KanbanConfigurationStateRecord> {
    const [configurationsResult, activeResult] = await Promise.all([
      this.pool.query<KanbanConfigurationRow>(
        `select configuration_id, name, values, created_at, updated_at
         from project_kanban_configurations
         where project_id = $1 and user_id = $2
         order by created_at asc, configuration_id asc`,
        [projectId, userId],
      ),
      this.pool.query<{ configuration_id: string }>(
        `select configuration_id
         from project_kanban_active_configurations
         where project_id = $1 and user_id = $2`,
        [projectId, userId],
      ),
    ]);
    const configurations = configurationsResult.rows.map(toKanbanConfigurationRecord);
    const storedActiveId = activeResult.rows[0]?.configuration_id;
    return {
      configurations,
      activeConfigurationId: configurations.some((item) => item.id === storedActiveId)
        ? storedActiveId
        : configurations[0]?.id,
    };
  }

  async ensureKanbanConfiguration(
    projectId: string,
    userId: string,
    configuration: KanbanConfigurationRecord,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // PostgreSQL text rejects NUL-separated composite keys before
      // hashtext runs, so lock the workflow/user pair as two text arguments.
      await client.query(
        "select pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [projectId, userId],
      );
      await client.query(
        `insert into project_kanban_configurations (
           project_id, user_id, configuration_id, name, values, created_at, updated_at
         )
         select $1, $2, $3, $4, $5::jsonb, $6, $7
         where not exists (
           select 1 from project_kanban_configurations where project_id = $1 and user_id = $2
         )`,
        [
          projectId,
          userId,
          configuration.id,
          configuration.name,
          JSON.stringify(configuration.values),
          configuration.createdAt,
          configuration.updatedAt,
        ],
      );
      await client.query(
        `insert into project_kanban_active_configurations (project_id, user_id, configuration_id)
         select project_id, user_id, configuration_id
         from project_kanban_configurations
         where project_id = $1 and user_id = $2
         order by created_at asc, configuration_id asc
         limit 1
         on conflict (project_id, user_id) do nothing`,
        [projectId, userId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async saveKanbanConfiguration(
    projectId: string,
    userId: string,
    configuration: KanbanConfigurationRecord,
  ): Promise<void> {
    await this.pool.query(
      `insert into project_kanban_configurations (
         project_id, user_id, configuration_id, name, values, created_at, updated_at
       ) values ($1, $2, $3, $4, $5::jsonb, $6, $7)
       on conflict (project_id, user_id, configuration_id) do update set
         name = excluded.name,
         values = excluded.values,
         updated_at = excluded.updated_at`,
      [
        projectId,
        userId,
        configuration.id,
        configuration.name,
        JSON.stringify(configuration.values),
        configuration.createdAt,
        configuration.updatedAt,
      ],
    );
  }

  async setActiveKanbanConfiguration(
    projectId: string,
    userId: string,
    configurationId: string,
  ): Promise<void> {
    await this.pool.query(
      `insert into project_kanban_active_configurations (project_id, user_id, configuration_id)
       values ($1, $2, $3)
       on conflict (project_id, user_id) do update set configuration_id = excluded.configuration_id`,
      [projectId, userId, configurationId],
    );
  }

  async deleteKanbanConfiguration(
    projectId: string,
    userId: string,
    configurationId: string,
  ): Promise<void> {
    await this.pool.query(
      `delete from project_kanban_configurations
       where project_id = $1 and user_id = $2 and configuration_id = $3`,
      [projectId, userId, configurationId],
    );
  }

  async getProjectDataSummary(projectId: string): Promise<ProjectDataSummary> {
    type SummaryRow = {
      kv_entries: string;
      kv_project_entries: string;
      kv_conversation_entries: string;
      kv_value_size_bytes: string;
      kv_text_characters: string;
      kv_updated_at: Date | null;
      knowledge_documents: string;
      knowledge_characters: string;
      knowledge_lines: string;
      knowledge_markdown_size_bytes: string;
      knowledge_updated_at: Date | null;
    };
    // Aggregate in one database snapshot; document index rows and tombstones
    // have no markdown and must not contribute to knowledge statistics.
    const result = await this.pool.query<SummaryRow>(
      `with kv_summary as (
         select count(*) as kv_entries,
           count(*) filter (where scope = 'project') as kv_project_entries,
           count(*) filter (where scope = 'conversation') as kv_conversation_entries,
           coalesce(sum(pg_column_size(value)), 0) as kv_value_size_bytes,
           coalesce(sum(case when jsonb_typeof(value) = 'string'
             then char_length(value #>> '{}') else 0 end), 0) as kv_text_characters,
           max(updated_at) as kv_updated_at
         from project_storage
         where storage_kind = 'kv' and project_id = $1
       ), knowledge_summary as (
         select count(*) as knowledge_documents,
           coalesce(sum(char_length(value ->> 'markdown')), 0) as knowledge_characters,
           coalesce(sum(1 + char_length(value ->> 'markdown')
             - char_length(replace(value ->> 'markdown', chr(10), ''))), 0) as knowledge_lines,
           coalesce(sum(octet_length(value ->> 'markdown')), 0) as knowledge_markdown_size_bytes,
           max(updated_at) as knowledge_updated_at
         from project_storage
         where storage_kind = 'persistent_value' and scope = 'project' and project_id = $1
           and key like $2
           and jsonb_typeof(value -> 'id') = 'string'
           and jsonb_typeof(value -> 'title') = 'string'
           and jsonb_typeof(value -> 'markdown') = 'string'
           and jsonb_typeof(value -> 'createdAt') = 'string'
           and jsonb_typeof(value -> 'updatedAt') = 'string'
       )
       select * from kv_summary cross join knowledge_summary`,
      [projectId, `${KNOWLEDGE_DOCUMENT_KEY_PREFIX}%`],
    );
    const row = result.rows[0]!;
    return {
      kv: {
        entryCount: normalizeNumber(row.kv_entries),
        projectEntryCount: normalizeNumber(row.kv_project_entries),
        conversationEntryCount: normalizeNumber(row.kv_conversation_entries),
        valueSizeBytes: normalizeNumber(row.kv_value_size_bytes),
        textCharacterCount: normalizeNumber(row.kv_text_characters),
        updatedAt: row.kv_updated_at?.toISOString() ?? null,
      },
      knowledge: {
        documentCount: normalizeNumber(row.knowledge_documents),
        characterCount: normalizeNumber(row.knowledge_characters),
        lineCount: normalizeNumber(row.knowledge_lines),
        markdownSizeBytes: normalizeNumber(row.knowledge_markdown_size_bytes),
        updatedAt: row.knowledge_updated_at?.toISOString() ?? null,
      },
    };
  }

  async listProjectKVEntries(options: {
    projectId: string;
    pageSize: number;
    cursor?: string;
    scope?: "project" | "conversation";
    query?: string;
    valueType?: KVEntryValueType;
    conversationId?: string;
    runId?: string;
  }): Promise<KVEntryPage> {
    const cursor = parseKVPageCursor(options.cursor);
    const params: unknown[] = [options.projectId];
    const where = [
      `storage_kind = 'kv'`,
      `project_id = $1`,
    ];

    if (options.scope !== undefined) {
      params.push(options.scope);
      where.push(`scope = $${params.length}`);
    }

    if (options.query !== undefined && options.query !== "") {
      params.push(`%${options.query.toLowerCase()}%`);
      const index = params.length;
      where.push(`(
        lower(key) like $${index}
        or lower(case
          when jsonb_typeof(value) = 'string' then left(value #>> '{}', 512)
          else left(value::text, 512)
        end) like $${index}
        or lower(coalesce(conversation_id, '')) like $${index}
        or lower(coalesce(last_run_id, '')) like $${index}
      )`);
    }

    if (options.valueType !== undefined) {
      params.push(options.valueType);
      where.push(`jsonb_typeof(value) = $${params.length}`);
    }

    if (options.conversationId !== undefined && options.conversationId !== "") {
      params.push(options.conversationId);
      where.push(`conversation_id = $${params.length}`);
    }

    if (options.runId !== undefined && options.runId !== "") {
      params.push(options.runId);
      where.push(`last_run_id = $${params.length}`);
    }

    return this.listKVEntries({ where, params, pageSize: options.pageSize, cursor });
  }

  async getValue(input: KVStoreGetInput): Promise<unknown | undefined> {
    const normalized = normalizeProjectKVStoreInput(input);
    const conversationId = readNormalizedKVConversationId(normalized);
    const result = await this.pool.query<KVEntryRow>(
      `select value
       from project_storage
       where storage_kind = $1
         and scope = $2
         and project_id = $3
         and conversation_id = $4
         and key = $5`,
      [
        normalized.storageKind,
        normalized.scope,
        normalized.projectId,
        conversationId,
        normalized.key,
      ],
    );

    return result.rows[0]?.value;
  }

  async getProjectStorageRevision(projectId: string): Promise<string> {
    const result = await this.pool.query<{ revision: string }>(
      `select revision::text as revision
       from project_storage_revisions
       where storage_kind = 'kv' and project_id = $1`,
      [projectId],
    );
    return result.rows[0]?.revision ?? "0";
  }

  async hasProjectKV(projectId: string): Promise<boolean> {
    const result = await this.pool.query<{ present: boolean }>(
      `select exists (
         select 1
         from project_storage entry
         where entry.storage_kind = 'kv'
           and entry.scope = 'project'
           and entry.project_id = $1
       ) as present`,
      [projectId],
    );
    return result.rows[0]?.present === true;
  }

  async listenProjectStorageRevisions(
    listener: (event: ProjectStorageRevisionEvent) => void,
  ): Promise<() => Promise<void>> {
    let closed = false;
    let activeClient: pg.PoolClient | undefined;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectPromise: Promise<void> | undefined;
    const releasedClients = new WeakSet<pg.PoolClient>();
    const replayBuffers = new WeakMap<pg.PoolClient, Map<string, string>>();
    const emittedRevisions = new Map<string, string>();

    const emitRevision = (event: ProjectStorageRevisionEvent) => {
      if (closed) return;
      const previous = emittedRevisions.get(event.projectId);
      if (previous !== undefined && !isNewerProjectKVRevision(event.revision, previous)) return;
      emittedRevisions.set(event.projectId, event.revision);
      try {
        listener(event);
      } catch {
        // A subscriber callback must not take down the shared PostgreSQL listener.
      }
    };
    const handleNotification = function(this: pg.PoolClient, notification: pg.Notification) {
      if (notification.channel !== STEAMHARNESS_KV_REVISION_CHANNEL || !notification.payload) return;
      try {
        const value = JSON.parse(notification.payload) as unknown;
        if (!isRecord(value)) return;
        const projectId = value["projectId"];
        const revision = value["revision"];
        if (typeof projectId !== "string" || typeof revision !== "string") return;
        const replayBuffer = replayBuffers.get(this);
        if (replayBuffer !== undefined) {
          const buffered = replayBuffer.get(projectId);
          if (buffered === undefined || isNewerProjectKVRevision(revision, buffered)) {
            replayBuffer.set(projectId, revision);
          }
          return;
        }
        emitRevision({ projectId, revision });
      } catch {
        // Ignore malformed database notifications; snapshots recover the state.
      }
    };

    const releaseClient = (client: pg.PoolClient, destroy: boolean) => {
      if (releasedClients.has(client)) return;
      releasedClients.add(client);
      client.removeListener("notification", handleNotification);
      client.removeListener("error", handleDisconnect);
      client.removeListener("end", handleDisconnect);
      if (activeClient === client) activeClient = undefined;
      replayBuffers.delete(client);
      client.release(destroy);
    };
    const scheduleReconnect = () => {
      if (closed || reconnectTimer !== undefined || reconnectPromise !== undefined) return;
      const delay = Math.min(
        this.projectKVRevisionReconnectDelayMs * (2 ** reconnectAttempt),
        STEAMHARNESS_KV_REVISION_RECONNECT_MAX_DELAY_MS,
      );
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        const pending = connect(true);
        reconnectPromise = pending;
        void pending
          .catch(() => {
            reconnectAttempt += 1;
          })
          .finally(() => {
            if (reconnectPromise === pending) reconnectPromise = undefined;
            if (!closed && activeClient === undefined) scheduleReconnect();
          });
      }, delay);
      reconnectTimer.unref?.();
    };
    const handleDisconnect = () => {
      const client = activeClient;
      if (client !== undefined) releaseClient(client, true);
      scheduleReconnect();
    };
    const connect = async (replaySnapshot: boolean): Promise<void> => {
      const client = await this.pool.connect();
      if (closed) {
        client.release();
        return;
      }
      client.on("notification", handleNotification);
      client.on("error", handleDisconnect);
      client.on("end", handleDisconnect);
      if (replaySnapshot) replayBuffers.set(client, new Map());
      try {
        await client.query(`listen ${STEAMHARNESS_KV_REVISION_CHANNEL}`);
        if (closed) {
          releaseClient(client, false);
          return;
        }
        activeClient = client;
        reconnectAttempt = 0;
        if (!replaySnapshot) return;
        const snapshot = await client.query<{ project_id: string; revision: string }>(
          `select project_id, revision::text as revision
           from project_storage_revisions
           where storage_kind = 'kv'`,
        );
        if (closed || activeClient !== client) return;
        for (const row of snapshot.rows) {
          if (typeof row.project_id === "string" && typeof row.revision === "string") {
            emitRevision({ projectId: row.project_id, revision: row.revision });
          }
        }
        const replayBuffer = replayBuffers.get(client);
        replayBuffers.delete(client);
        for (const [projectId, revision] of replayBuffer ?? []) {
          emitRevision({ projectId, revision });
        }
      } catch (error) {
        releaseClient(client, true);
        throw error;
      }
    };

    await connect(false);
    return async () => {
      if (closed) return;
      closed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      const client = activeClient;
      if (client !== undefined) {
        await client.query(`unlisten ${STEAMHARNESS_KV_REVISION_CHANNEL}`).catch(() => undefined);
        releaseClient(client, false);
      }
      await reconnectPromise?.catch(() => undefined);
    };
  }

  async getValueWithRevision(input: KVStoreGetInput): Promise<{
    value: unknown;
    revision: string;
  } | undefined> {
    const normalized = normalizeProjectKVStoreInput(input);
    const conversationId = readNormalizedKVConversationId(normalized);
    const result = await this.pool.query<{ value: unknown; revision: string }>(
      `select value, ${STEAMHARNESS_KV_REVISION_SQL} as revision
       from project_storage
       where storage_kind = $1
         and scope = $2
         and project_id = $3
         and conversation_id = $4
         and key = $5`,
      [
        normalized.storageKind,
        normalized.scope,
        normalized.projectId,
        conversationId,
        normalized.key,
      ],
    );

    return result.rows[0];
  }

  async setValue(input: KVStoreSetInput): Promise<void> {
    if (input.value === undefined) {
      throw new Error("Workflow project storage value cannot be undefined.");
    }
    const normalized = normalizeProjectKVStoreInput(input);
    const conversationId = readNormalizedKVConversationId(normalized);
    await this.pool.query(
      `insert into project_storage (
         storage_kind, scope, project_id, conversation_id,
         key, value, last_project_id, last_run_id, last_conversation_id, updated_at
       )
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, now())
       on conflict (storage_kind, scope, project_id, conversation_id, key) do update set
         value = excluded.value,
         last_project_id = excluded.last_project_id,
         last_run_id = excluded.last_run_id,
         last_conversation_id = excluded.last_conversation_id,
         updated_at = now()`,
      [
        normalized.storageKind,
        normalized.scope,
        normalized.projectId,
        conversationId,
        normalized.key,
        JSON.stringify(input.value),
        input.source?.projectId ?? normalized.projectId,
        input.source?.runId ?? null,
        input.source?.conversationId ?? (conversationId || null),
      ],
    );
  }

  async deleteValue(input: KVStoreGetInput): Promise<boolean> {
    const normalized = normalizeProjectKVStoreInput(input);
    const conversationId = readNormalizedKVConversationId(normalized);
    const result = await this.pool.query(
      `delete from project_storage
       where storage_kind = $1
         and scope = $2
         and project_id = $3
         and conversation_id = $4
         and key = $5`,
      [
        normalized.storageKind,
        normalized.scope,
        normalized.projectId,
        conversationId,
        normalized.key,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async compareAndSetValue(
    input: KVStoreSetInput,
    expectedRevision: string | null,
  ): Promise<{ applied: boolean; revision?: string }> {
    if (input.value === undefined) {
      throw new Error("Workflow KV value cannot be undefined.");
    }

    const normalized = normalizeProjectKVStoreInput(input);
    const conversationId = readNormalizedKVConversationId(normalized);
    const writeParams = [
      normalized.storageKind,
      normalized.scope,
      normalized.projectId,
      conversationId,
      normalized.key,
      JSON.stringify(input.value),
      input.source?.projectId ?? normalized.projectId,
      input.source?.runId ?? null,
      input.source?.conversationId ?? (conversationId || null),
    ];

    if (expectedRevision === null) {
      const result = await this.pool.query<{ revision: string }>(
        `insert into project_storage (
           storage_kind, scope, project_id, conversation_id,
           key, value, last_project_id, last_run_id, last_conversation_id, updated_at
         )
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, now())
         on conflict (storage_kind, scope, project_id, conversation_id, key) do nothing
         returning ${STEAMHARNESS_KV_REVISION_SQL} as revision`,
        writeParams,
      );
      const revision = result.rows[0]?.revision;
      return revision === undefined ? { applied: false } : { applied: true, revision };
    }

    const result = await this.pool.query<{ revision: string }>(
      `update project_storage
       set value = $6::jsonb,
           last_project_id = $7,
           last_run_id = $8,
           last_conversation_id = $9,
           updated_at = now()
       where storage_kind = $1
         and scope = $2
         and project_id = $3
         and conversation_id = $4
         and key = $5
         and xmin = $10::xid
       returning ${STEAMHARNESS_KV_REVISION_SQL} as revision`,
      [
        normalized.storageKind,
        normalized.scope,
        normalized.projectId,
        conversationId,
        normalized.key,
        JSON.stringify(input.value),
        input.source?.projectId ?? normalized.projectId,
        input.source?.runId ?? null,
        input.source?.conversationId ?? (conversationId || null),
        expectedRevision,
      ],
    );
    const revision = result.rows[0]?.revision;
    return revision === undefined ? { applied: false } : { applied: true, revision };
  }

  async updateValue(
    input: KVStoreGetInput & { source?: KVWriteSource },
    updater: (current: unknown | undefined) => unknown,
  ): Promise<unknown> {
    const normalized = normalizeProjectKVStoreInput(input);
    const conversationId = readNormalizedKVConversationId(normalized);
    const client = await this.pool.connect();

    try {
      await client.query("begin");
      const result = await client.query<KVEntryRow>(
        `select value
         from project_storage
         where storage_kind = $1
           and scope = $2
           and project_id = $3
           and conversation_id = $4
           and key = $5
         for update`,
        [
          normalized.storageKind,
          normalized.scope,
          normalized.projectId,
          conversationId,
          normalized.key,
        ],
      );
      const value = updater(result.rows[0]?.value);
      if (value === undefined) {
        throw new Error("Workflow KV value cannot be undefined.");
      }
      await client.query(
        `insert into project_storage (
           storage_kind, scope, project_id, conversation_id,
           key, value, last_project_id, last_run_id, last_conversation_id, updated_at
         )
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, now())
         on conflict (storage_kind, scope, project_id, conversation_id, key) do update set
           value = excluded.value,
           last_project_id = excluded.last_project_id,
           last_run_id = excluded.last_run_id,
           last_conversation_id = excluded.last_conversation_id,
           updated_at = now()`,
        [
          normalized.storageKind,
          normalized.scope,
          normalized.projectId,
          conversationId,
          normalized.key,
          JSON.stringify(value),
          input.source?.projectId ?? normalized.projectId,
          input.source?.runId ?? null,
          input.source?.conversationId ?? (conversationId || null),
        ],
      );
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async withNamespaceLock<T>(
    input: KVNamespaceLockInput,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    return withPostgresProjectKVNamespaceLock(this.publishLockPool, input, operation);
  }

  async withNamespaceTransaction<T>(
    input: KVNamespaceLockInput,
    operation: (store: KVStore) => Promise<T> | T,
  ): Promise<T> {
    const client = await this.pool.connect();
    const lockKey = createProjectKVNamespaceLockKey(input);
    let transactionStarted = false;

    try {
      await client.query("begin");
      transactionStarted = true;
      await client.query(
        "select pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [STEAMHARNESS_KV_NAMESPACE_LOCK_FAMILY, lockKey],
      );
      const result = await operation(createTransactionalProjectKVStore(client, input));
      await client.query("commit");
      return result;
    } catch (error) {
      if (transactionStarted) {
        await client.query("rollback").catch(() => undefined);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getProjectKVEntry(options: {
    projectId: string;
    scope: "project" | "conversation";
    key: string;
    conversationId?: string;
  }): Promise<KVEntryDetail | undefined> {
    const params: unknown[] = [
      options.scope,
      options.projectId,
      options.scope === "conversation" ? options.conversationId ?? "" : "",
      options.key,
    ];

    return this.getKVEntryDetail([
      `storage_kind = 'kv'`,
      `scope = $1`,
      `project_id = $2`,
      `conversation_id = $3`,
      `key = $4`,
    ], params);
  }

  async getSystemTokenUsage(options: {
    pageSize: number;
    cursor?: string;
  }): Promise<TokenUsagePage> {
    const cursor = parseTokenUsageProjectCursor(options.cursor);
    const [systemTotal, projectPage] = await Promise.all([
      this.readSystemTokenUsageAggregate(),
      this.listProjectTokenUsageTotals(options.pageSize, cursor),
    ]);

    return {
      systemTotal,
      projects: projectPage.items,
      nextCursor: projectPage.nextCursor,
      hasMore: projectPage.hasMore,
      total: projectPage.total,
    };
  }

  async getProjectTokenUsage(options: {
    projectId: string;
    conversationId?: string;
    includeEntries?: boolean;
  }): Promise<TokenUsageDetail> {
    const projectTotal = await this.readTokenUsageAggregate({
      scope: "project",
      projectId: options.projectId,
      key: TOKEN_USAGE_TOTAL_KEY,
    });
    const detail: TokenUsageDetail = {
      projectId: options.projectId,
      projectTotal,
    };

    if (options.conversationId === undefined || options.conversationId === "") {
      return detail;
    }

    detail.conversationId = options.conversationId;
    detail.conversationTotal = await this.readTokenUsageAggregate({
      scope: "conversation",
      projectId: options.projectId,
      conversationId: options.conversationId,
      key: TOKEN_USAGE_TOTAL_KEY,
    });

    if (options.includeEntries === true) {
      detail.entries = await this.listConversationTokenUsageEntries({
        projectId: options.projectId,
        conversationId: options.conversationId,
      });
    }

    return detail;
  }

  private async readTokenUsageAggregate(options: {
    scope: "project" | "conversation";
    projectId: string;
    conversationId?: string;
    key: string;
  }): Promise<TokenUsageAggregate> {
    const result = await this.pool.query<{ value: unknown }>(
      `select value
       from project_storage
       where storage_kind = 'kv'
         and scope = $1
         and project_id = $2
         and conversation_id = $3
         and key = $4`,
      [
        options.scope,
        options.projectId,
        options.conversationId ?? "",
        options.key,
      ],
    );
    const value = result.rows[0]?.value;
    return readStoredTokenUsageAggregate(value) ?? createEmptyTokenUsageAggregate();
  }

  private async readSystemTokenUsageAggregate(): Promise<TokenUsageAggregate> {
    const result = await this.pool.query<{ value: unknown }>(
      `select value
       from project_storage
       where storage_kind = 'kv'
         and scope = 'project'
         and conversation_id = ''
         and key = $1`,
      [TOKEN_USAGE_TOTAL_KEY],
    );
    let total = createEmptyTokenUsageAggregate();
    for (const row of result.rows) {
      const aggregate = readStoredTokenUsageAggregate(row.value);
      if (aggregate === undefined) continue;
      total = {
        inputTokens: total.inputTokens + aggregate.inputTokens,
        outputTokens: total.outputTokens + aggregate.outputTokens,
        totalTokens: total.totalTokens + aggregate.totalTokens,
        reasoningTokens: total.reasoningTokens + aggregate.reasoningTokens,
        cachedInputTokens: total.cachedInputTokens + aggregate.cachedInputTokens,
        cacheCreationTokens: total.cacheCreationTokens + aggregate.cacheCreationTokens,
        calls: total.calls + aggregate.calls,
        updatedAt: [total.updatedAt, aggregate.updatedAt].filter(isDefined).sort().at(-1),
      };
    }
    return total;
  }

  private async listProjectTokenUsageTotals(
    pageSize: number,
    cursor: TokenUsageProjectCursor | undefined,
  ): Promise<{
    items: TokenUsagePage["projects"];
    nextCursor?: string;
    hasMore: boolean;
    total: number;
  }> {
    const total = await this.countProjectTokenUsageTotals();
    const params: unknown[] = [];
    const where = [
      `storage_kind = 'kv'`,
      `scope = 'project'`,
      `conversation_id = ''`,
      `key = $1`,
    ];
    params.push(TOKEN_USAGE_TOTAL_KEY);

    if (cursor !== undefined) {
      params.push(cursor.updatedAt, cursor.projectId);
      const updatedAtIndex = params.length - 1;
      const projectIdIndex = params.length;
      where.push(`(updated_at, project_id) < ($${updatedAtIndex}::timestamptz, $${projectIdIndex})`);
    }

    params.push(pageSize + 1);
    const result = await this.pool.query<TokenUsageProjectTotalRow>(
      `select
         project_id,
         value,
         updated_at,
         to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at_cursor
       from project_storage
       where ${where.join(" and ")}
       order by updated_at desc, project_id desc
       limit $${params.length}`,
      params,
    );
    const rows = result.rows.slice(0, pageSize);

    return {
      items: rows.map(toProjectTokenUsageSummary),
      nextCursor: result.rows.length > pageSize ? createTokenUsageProjectCursor(rows.at(-1)) : undefined,
      hasMore: result.rows.length > pageSize,
      total,
    };
  }

  private async countProjectTokenUsageTotals(): Promise<number> {
    const result = await this.pool.query<{ total: string | number }>(
      `select count(*) as total
       from project_storage
       where storage_kind = 'kv'
         and scope = 'project'
         and conversation_id = ''
         and key = $1`,
      [TOKEN_USAGE_TOTAL_KEY],
    );
    const value = result.rows[0]?.total ?? 0;
    const total = typeof value === "number" ? value : Number(value);
    return Number.isFinite(total) ? total : 0;
  }

  private async listConversationTokenUsageEntries(options: {
    projectId: string;
    conversationId: string;
  }): Promise<TokenUsageEntry[]> {
    const result = await this.pool.query<{ value: unknown }>(
      `select value
       from project_storage
       where storage_kind = 'kv'
         and scope = 'conversation'
         and project_id = $1
         and conversation_id = $2
         and key like $3
       order by updated_at asc, key asc`,
      [
        options.projectId,
        options.conversationId,
        `${TOKEN_USAGE_ENTRY_KEY_PREFIX}%`,
      ],
    );

    return result.rows
      .map((row) => readStoredTokenUsageEntry(row.value))
      .filter((entry): entry is TokenUsageEntry => entry !== undefined);
  }

  private async listKVEntries(options: {
    where: string[];
    params: unknown[];
    pageSize: number;
    cursor?: KVPageCursor;
  }): Promise<KVEntryPage> {
    const params = [...options.params];
    const where = [...options.where];
    const total = await this.countKVEntries(where, params);
    if (options.cursor !== undefined) {
      params.push(
        options.cursor.updatedAt,
        options.cursor.scope,
        options.cursor.projectId,
        options.cursor.conversationId,
        options.cursor.key,
      );
      const updatedAtIndex = params.length - 4;
      const scopeIndex = params.length - 3;
      const projectIdIndex = params.length - 2;
      const conversationIdIndex = params.length - 1;
      const keyIndex = params.length;
      where.push(`(
        updated_at,
        scope,
        project_id,
        conversation_id,
        key
      ) < (
        $${updatedAtIndex}::timestamptz,
        $${scopeIndex},
        $${projectIdIndex},
        $${conversationIdIndex},
        $${keyIndex}
      )`);
    }

    params.push(options.pageSize + 1);
    const limitIndex = params.length;
    const result = await this.pool.query<KVEntryRow>(
      `select
         storage_kind, scope, project_id, conversation_id, key,
         jsonb_typeof(value) as value_type,
         pg_column_size(value) as value_size_bytes,
         case
           when jsonb_typeof(value) = 'string' then left(value #>> '{}', 512)
           else left(value::text, 512)
         end as value_preview,
         updated_at,
         to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at_cursor,
         last_project_id, last_run_id, last_conversation_id
       from project_storage kv
       where ${where.join(" and ")}
       order by updated_at desc, scope desc, project_id desc, conversation_id desc, key desc
       limit $${limitIndex}`,
      params,
    );
    const rows = result.rows.slice(0, options.pageSize);

    return {
      items: rows.map(toKVEntrySummary),
      nextCursor: result.rows.length > options.pageSize ? createKVPageCursor(rows.at(-1)) : undefined,
      hasMore: result.rows.length > options.pageSize,
      total,
    };
  }

  private async getKVEntryDetail(where: string[], params: unknown[]): Promise<KVEntryDetail | undefined> {
    const result = await this.pool.query<KVEntryRow>(
      // KV list pages stay lightweight; full value payloads are only
      // read through this explicit detail path after a user expands one row.
      `select
         storage_kind, scope, project_id, conversation_id, key, value,
         jsonb_typeof(value) as value_type,
         pg_column_size(value) as value_size_bytes,
         case
           when jsonb_typeof(value) = 'string' then left(value #>> '{}', 512)
           else left(value::text, 512)
         end as value_preview,
         updated_at,
         to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at_cursor,
         last_project_id, last_run_id, last_conversation_id
       from project_storage kv
       where ${where.join(" and ")}
       limit 1`,
      params,
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }

    return toKVEntryDetail(row);
  }

  private async countKVEntries(where: string[], params: unknown[]): Promise<number> {
    // KV summary and pagination controls need the full filtered count,
    // not just the current page of rows.
    const result = await this.pool.query<{ total: string | number }>(
      `select count(*) as total
       from project_storage kv
       where ${where.join(" and ")}`,
      params,
    );
    const value = result.rows[0]?.total ?? 0;
    const total = typeof value === "number" ? value : Number(value);
    return Number.isFinite(total) ? total : 0;
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.pool.query("delete from projects where id = $1", [projectId]);
  }
}

export class ArtifactStorage {
  constructor(private readonly storage: ObjectStorage) {}
  async init(): Promise<void> {}
  async uploadFile(objectPath: string, filePath: string): Promise<void> { await this.storage.uploadPrivateFile(objectPath, filePath, "application/gzip"); }
  async downloadFile(objectPath: string, filePath: string): Promise<void> { await this.storage.downloadPrivateFile(objectPath, filePath); }
}

export function createObjectPath(options: {
  projectId: string;
  version: string;
  hash: string;
  fileName: "source.tar.gz";
}): string {
  return [
    "projects",
    options.projectId,
    options.version,
    options.hash,
    options.fileName,
  ].join("/");
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

interface Row {
  id: string;
  name: string;
  project_type: unknown;
  project_card: unknown;
  project_info: unknown;
  package_version: string;
  has_draft: boolean;
  latest_version: string | null;
  owner_user_id: string | null;
  group_id: string | null;
  visibility: string | null;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface VersionRow {
  project_id: string;
  project_name: string;
  version: string;
  created_at: Date;
  source_hash: string;
  source_object_path: string;
  release_log: string;
  created_by_user_id: string | null;
}

interface VersionSummaryRow {
  project_id: string;
  project_name: string;
  version: string;
}

interface VersionDependencyRow {
  version: string;
  alias: string;
  dependency_project_id: string;
  delivery: string;
  dependency_version: string | null;
  source_hash: string | null;
}

interface FileRow {
  path: string;
  content: string;
  size: number;
  encoding: string | null;
}

interface KanbanConfigurationRow {
  configuration_id: string;
  name: string;
  values: unknown;
  created_at: Date;
  updated_at: Date;
}

interface ProjectMemberRow {
  project_id: string;
  user_id: string;
  role: string;
  created_by: string | null;
  created_at: Date;
}

interface DeploymentRow {
  id: string;
  root_project_id: string;
  status: string;
  manifest: unknown;
  release_log: string;
  created_by_user_id: string;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
}

interface DeploymentItemRow {
  deployment_id: string;
  project_id: string;
  alias: string | null;
  role: string;
  delivery: string;
  status: string;
  stage: string | null;
  planned_version: string | null;
  prepared_source_hash: string | null;
  prepared_configuration_revision: number | null;
  published_version: string | null;
  published_source_hash: string | null;
  error: string | null;
  updated_at: Date;
}


interface ProjectAccessRequestRow {
  id: string;
  project_id: string;
  requester_user_id: string;
  reason: string;
  status: string;
  resolved_by_user_id: string | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}


interface KVEntryRow {
  storage_kind: string;
  scope: string;
  project_id: string;
  conversation_id: string;
  key: string;
  value?: unknown;
  value_type: string | null;
  value_size_bytes: number | string | null;
  value_preview?: string | null;
  updated_at: Date;
  updated_at_cursor: string;
  last_project_id: string | null;
  last_run_id: string | null;
  last_conversation_id: string | null;
}

interface TokenUsageProjectTotalRow {
  project_id: string;
  value: unknown;
  updated_at: Date;
  updated_at_cursor: string;
}

function toProjectRecord(row: Row): DbRecord {
  if (!isProjectKind(row.project_type)) {
    throw new Error(`Workflow "${row.id}" has invalid persisted project_type.`);
  }
  return {
    id: row.id,
    name: row.name,
    projectType: row.project_type,
    projectCard: normalizeProjectCardMetadata(row.project_card, row.project_type),
    projectInfo: normalizeProjectInfo(row.project_info ?? {}),
    packageVersion: row.package_version,
    hasDraft: row.has_draft,
    latest: row.latest_version,
    ownerUserId: row.owner_user_id ?? undefined,
    groupId: row.group_id ?? null,
    visibility: row.visibility === "public" ? "public" : "private",
    createdByUserId: row.created_by_user_id ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toVersionRecord(row: VersionRow): DbVersionRecord { return { projectId: row.project_id, projectName: row.project_name, version: row.version, createdAt: row.created_at.toISOString(), sourceHash: row.source_hash, sourceObjectPath: row.source_object_path, releaseLog: row.release_log, createdByUserId: row.created_by_user_id ?? undefined, dependencies: [] }; }

function toProjectDependencyLock(
  row: VersionDependencyRow,
): ProjectDependencyLock {
  const delivery = row.delivery === "included" ? "included" as const : "external" as const;
  return {
    alias: row.alias,
    projectId: row.dependency_project_id,
    delivery,
    ...(delivery === "included" && row.dependency_version
      ? { version: row.dependency_version }
      : {}),
    ...(delivery === "included" && row.source_hash
      ? { sourceHash: row.source_hash }
      : {}),
  };
}

function toVersionSummaryRecord(row: VersionSummaryRow): DbVersionSummaryRecord { return {projectId: row.project_id, projectName: row.project_name, version: row.version}; }

function toKanbanConfigurationRecord(
  row: KanbanConfigurationRow,
): KanbanConfigurationRecord {
  return {
    id: row.configuration_id,
    name: row.name,
    values: sanitizeStringRecord(row.values),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function isProjectRole(value: unknown): value is ProjectRole {
  return value === "owner" || value === "maintainer" || value === "developer" || value === "guest";
}

function toProjectMemberRecord(
  row: ProjectMemberRow,
): ProjectMemberRecord {
  if (!isProjectRole(row.role)) throw new Error("Invalid project member role.");
  return {
    projectId: row.project_id,
    userId: row.user_id,
    role: row.role,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}

function toProjectDeploymentRecord(
  row: DeploymentRow,
  itemRows: DeploymentItemRow[],
): DeploymentRecord {
  return {
    id: row.id,
    rootProjectId: row.root_project_id,
    status: isProjectDeploymentStatus(row.status) ? row.status : "failed",
    manifest: parseProjectGroupManifest(row.manifest),
    releaseLog: row.release_log,
    createdByUserId: row.created_by_user_id,
    error: row.error ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    publishedAt: row.published_at?.toISOString(),
    items: itemRows.map((item) => ({
      deploymentId: item.deployment_id,
      projectId: item.project_id,
      alias: item.alias ?? undefined,
      role: item.role === "root" ? "root" : "dependency",
      delivery: "included",
      status: isProjectDeploymentItemStatus(item.status) ? item.status : "failed",
      stage: item.stage ?? undefined,
      plannedVersion: item.planned_version ?? undefined,
      preparedSourceHash: item.prepared_source_hash ?? undefined,
      preparedConfigurationRevision: item.prepared_configuration_revision ?? undefined,
      publishedVersion: item.published_version ?? undefined,
      publishedSourceHash: item.published_source_hash ?? undefined,
      error: item.error ?? undefined,
      updatedAt: item.updated_at.toISOString(),
    })),
  };
}


function toProjectAccessRequest(
  row: ProjectAccessRequestRow,
): ProjectAccessRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    requesterUserId: row.requester_user_id,
    reason: row.reason,
    status: isProjectAccessRequestStatus(row.status) ? row.status : "rejected",
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    resolvedByUserId: row.resolved_by_user_id ?? undefined,
    resolvedAt: row.resolved_at?.toISOString(),
  };
}


function isProjectDeploymentStatus(value: unknown): value is DeploymentStatus {
  return value === "planned" || value === "preparing" || value === "prepared" ||
    value === "publishing" || value === "published" || value === "failed";
}

function isProjectDeploymentItemStatus(value: unknown): value is DeploymentItemStatus {
  return value === "planned" || value === "preparing" || value === "prepared" ||
    value === "publishing" || value === "published" || value === "failed";
}

function isProjectAccessRequestStatus(
  value: unknown,
): value is ProjectAccessRequestStatus {
  return value === "pending" || value === "approved" || value === "rejected" || value === "revoked";
}

function sanitizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string"
    )),
  );
}

function toKVEntrySummary(row: KVEntryRow): KVEntrySummary {
  const summary: KVEntrySummary = {
    storageKind: row.storage_kind === "persistent_value" ? "persistent_value" : "kv",
    scope: isKVScope(row.scope) ? row.scope : "project",
    key: row.key,
    valueType: normalizeKVValueType(row.value_type, row.value),
    valueSizeBytes: normalizeNumber(row.value_size_bytes),
    valuePreview: createKVValuePreview(row.value, row.value_preview ?? undefined),
    projectId: row.project_id,
    conversationId: row.conversation_id || undefined,
    updatedAt: row.updated_at.toISOString(),
    lastProjectId: row.last_project_id ?? undefined,
    lastRunId: row.last_run_id ?? undefined,
    lastConversationId: row.last_conversation_id ?? undefined,
  };
  if ("value" in row) {
    summary.value = row.value;
  }
  return summary;
}

function toKVEntryDetail(row: KVEntryRow): KVEntryDetail {
  if (!("value" in row)) {
    throw new Error("Workflow KV detail row is missing value.");
  }
  return toKVEntrySummary(row) as KVEntryDetail;
}

function toProjectTokenUsageSummary(row: TokenUsageProjectTotalRow): TokenUsagePage["projects"][number] {
  return {
    projectId: row.project_id,
    total: readStoredTokenUsageAggregate(row.value) ?? createEmptyTokenUsageAggregate(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function readNormalizedKVConversationId(
  input: ReturnType<typeof normalizeProjectKVStoreInput>,
): string {
  return input.scope === "conversation" ? input.conversationId : "";
}

function createTransactionalProjectKVStore(
  client: pg.PoolClient,
  transactionNamespace: KVNamespaceLockInput,
): KVStore {
  const transactionNamespaceLockKey = createProjectKVNamespaceLockKey(transactionNamespace);
  const readValue = async (input: KVStoreGetInput): Promise<unknown | undefined> => {
    const normalized = normalizeProjectKVStoreInput(input);
    const conversationId = readNormalizedKVConversationId(normalized);
    const result = await client.query<KVEntryRow>(
      `select value
       from project_storage
       where storage_kind = $1
         and scope = $2
         and project_id = $3
         and conversation_id = $4
         and key = $5`,
      [
        normalized.storageKind,
        normalized.scope,
        normalized.projectId,
        conversationId,
        normalized.key,
      ],
    );
    return result.rows[0]?.value;
  };

  const writeValue = async (input: KVStoreSetInput): Promise<void> => {
    if (input.value === undefined) {
      throw new Error("Workflow project storage value cannot be undefined.");
    }
    const normalized = normalizeProjectKVStoreInput(input);
    const conversationId = readNormalizedKVConversationId(normalized);
    await client.query(
      `insert into project_storage (
         storage_kind, scope, project_id, conversation_id,
         key, value, last_project_id, last_run_id, last_conversation_id, updated_at
       )
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, now())
       on conflict (storage_kind, scope, project_id, conversation_id, key) do update set
         value = excluded.value,
         last_project_id = excluded.last_project_id,
         last_run_id = excluded.last_run_id,
         last_conversation_id = excluded.last_conversation_id,
         updated_at = now()`,
      [
        normalized.storageKind,
        normalized.scope,
        normalized.projectId,
        conversationId,
        normalized.key,
        JSON.stringify(input.value),
        input.source?.projectId ?? normalized.projectId,
        input.source?.runId ?? null,
        input.source?.conversationId ?? (conversationId || null),
      ],
    );
  };

  return {
    getValue: readValue,
    setValue: writeValue,
    async updateValue(input, updater) {
      const normalized = normalizeProjectKVStoreInput(input);
      const conversationId = readNormalizedKVConversationId(normalized);
      const result = await client.query<KVEntryRow>(
        `select value
         from project_storage
         where storage_kind = $1
           and scope = $2
           and project_id = $3
           and conversation_id = $4
           and key = $5
         for update`,
        [
          normalized.storageKind,
          normalized.scope,
          normalized.projectId,
          conversationId,
          normalized.key,
        ],
      );
      const value = updater(result.rows[0]?.value);
      if (value === undefined) {
        throw new Error("Workflow KV value cannot be undefined.");
      }
      await writeValue({ ...input, value });
      return value;
    },
    async deleteValue(input) {
      const normalized = normalizeProjectKVStoreInput(input);
      const conversationId = readNormalizedKVConversationId(normalized);
      const result = await client.query(
        `delete from project_storage
         where storage_kind = $1
           and scope = $2
           and project_id = $3
           and conversation_id = $4
           and key = $5`,
        [
          normalized.storageKind,
          normalized.scope,
          normalized.projectId,
          conversationId,
          normalized.key,
        ],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async withNamespaceLock(input, operation) {
      const lockKey = createProjectKVNamespaceLockKey(input);
      // The outer transaction already holds this namespace's transaction-scoped
      // advisory lock. A nested PersistentValue mutation must reuse it instead
      // of opening a separate connection or dropping atomicity.
      if (lockKey !== transactionNamespaceLockKey) {
        await client.query(
          "select pg_advisory_xact_lock(hashtext($1), hashtext($2))",
          [STEAMHARNESS_KV_NAMESPACE_LOCK_FAMILY, lockKey],
        );
      }
      return operation();
    },
  };
}

type KVPageCursor = {
  updatedAt: string;
  scope: string;
  projectId: string;
  conversationId: string;
  key: string;
};

type TokenUsageProjectCursor = {
  updatedAt: string;
  projectId: string;
};

function createKVPageCursor(
  row: Pick<KVEntryRow, "updated_at_cursor" | "scope" | "project_id" | "conversation_id" | "key"> | undefined,
): string | undefined {
  if (row === undefined) {
    return undefined;
  }

  return Buffer.from(JSON.stringify({
    updatedAt: row.updated_at_cursor,
    scope: row.scope,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    key: row.key,
  }), "utf8").toString("base64url");
}

function parseKVPageCursor(cursor: string | undefined): KVPageCursor | undefined {
  if (cursor === undefined || cursor.trim() === "") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed["updatedAt"] === "string" &&
      typeof parsed["scope"] === "string" &&
      typeof parsed["projectId"] === "string" &&
      typeof parsed["conversationId"] === "string" &&
      typeof parsed["key"] === "string"
    ) {
      return {
        updatedAt: parsed["updatedAt"],
        scope: parsed["scope"],
        projectId: parsed["projectId"],
        conversationId: parsed["conversationId"],
        key: parsed["key"],
      };
    }
  } catch {
    // Invalid cursors fall back to the first page for resilience.
  }

  return undefined;
}

function createTokenUsageProjectCursor(
  row: Pick<TokenUsageProjectTotalRow, "updated_at_cursor" | "project_id"> | undefined,
): string | undefined {
  if (row === undefined) {
    return undefined;
  }

  return Buffer.from(JSON.stringify({
    updatedAt: row.updated_at_cursor,
    projectId: row.project_id,
  }), "utf8").toString("base64url");
}

function parseTokenUsageProjectCursor(cursor: string | undefined): TokenUsageProjectCursor | undefined {
  if (cursor === undefined || cursor.trim() === "") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed["updatedAt"] === "string" &&
      typeof parsed["projectId"] === "string"
    ) {
      return {
        updatedAt: parsed["updatedAt"],
        projectId: parsed["projectId"],
      };
    }
  } catch {
    // Invalid cursors fall back to the first page for resilience.
  }

  return undefined;
}

function isKVScope(value: unknown): value is KVEntrySummary["scope"] {
  return value === "project" || value === "conversation";
}

function normalizeKVValueType(valueType: string | null, value: unknown): KVEntryValueType {
  if (
    valueType === "null" ||
    valueType === "array" ||
    valueType === "object" ||
    valueType === "string" ||
    valueType === "number" ||
    valueType === "boolean"
  ) {
    return valueType;
  }

  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  return type === "object" || type === "string" || type === "number" || type === "boolean"
    ? type
    : "string";
}

function normalizeNumber(value: number | string | null): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isNewerProjectKVRevision(candidate: string, previous: string): boolean {
  if (/^\d+$/.test(candidate) && /^\d+$/.test(previous)) {
    return BigInt(candidate) > BigInt(previous);
  }
  return candidate !== previous;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function createKVValuePreview(value: unknown, preview?: string): string {
  const serialized = preview ?? (typeof value === "string" ? value : JSON.stringify(value));
  if (serialized === undefined) {
    return "";
  }

  return serialized.length > 160 ? `${serialized.slice(0, 157)}...` : serialized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
