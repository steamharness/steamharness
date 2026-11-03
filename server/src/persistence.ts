import type { File } from "./storage";
import type { ProjectAccessRequest, ProjectAccessRequestStatus } from "@steamharness/project-access";
import { normalizeProjectManifest, type ProjectEntry } from '@steamharness/project-manifest';
import { HttpError } from "./protocol";
import { ProjectAccessRepository } from "./project-access";
import type { AccessActor, ProjectRole } from "@steamharness/project-access";
import type { ProjectConfigurationState, ConfigurationPublicationDraft, ProjectConfigurationTemplate } from "@steamharness/project-configuration";

import { createHash } from "node:crypto";
import type pg from "pg";
import { createPostgresPool } from "./postgres";
import { normalizeProjectCardMetadata, type ProjectCardMetadata } from "@steamharness/project-card-metadata";
import { normalizeProjectInfo, writeProjectInfo, type DeclaredProjectInfo, type ProjectInfoContract } from "@steamharness/project-info";
import { isProjectKind, STEAMHARNESS_PROJECT_TYPES, type ProjectKind } from "@steamharness/project-types";
import type { ObjectStorage } from "./object-storage";
const STEAMHARNESS_PROJECT_TYPES_SQL = createPostgresTextList(STEAMHARNESS_PROJECT_TYPES);
function createPostgresTextList(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}

export interface DbRecord {
  id: string;
  name: string;
  entries: ProjectEntry[];
  defaultEntry: string;
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

export interface DbVersionRecord { projectId: string; projectName: string; version: string; createdAt: string; createdByUserId?: string; releaseLog: string; sourceHash: string; sourceObjectPath: string; entries: ProjectEntry[]; defaultEntry: string; }

export interface DbVersionSummaryRecord { projectId: string; projectName: string; version: string; }

export interface SaveProjectDraftInput {
  projectId: string;
  projectName: string;
  entries: ProjectEntry[];
  defaultEntry: string;
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
  entries: ProjectEntry[];
  defaultEntry: string;
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
  entries: ProjectEntry[];
  defaultEntry: string;
  updateLatest?: boolean;
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

export class DatabaseRepository {
  private readonly pool: pg.Pool;
  readonly access: ProjectAccessRepository;
  private readonly publishLockPool: pg.Pool;

  constructor(readonly connectionString: string) {
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
        entries jsonb not null,
        default_entry text not null,
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

      alter table projects add column if not exists entries jsonb;
      alter table projects add column if not exists default_entry text;
      -- Keep unsupported legacy rows and their dependent data. Starting a newer
      -- Server must never erase projects to satisfy its current manifest schema.
      do $$ begin
        if exists (select 1 from information_schema.columns where table_schema=current_schema()
          and table_name='projects' and column_name='project_type') then
          alter table projects alter column project_type drop not null;
        end if;
      end $$;

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
        entries jsonb not null,
        default_entry text not null,
        created_at timestamptz not null,
        source_hash text not null,
        source_object_path text not null,
        release_log text not null default '',
        created_by_user_id text,
        primary key (project_id, version)
      );

      alter table project_versions add column if not exists entries jsonb;
      alter table project_versions add column if not exists default_entry text;
      -- Legacy version snapshots remain stored until explicitly migrated.

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

      create table if not exists entry_configuration_drafts (
        project_id text not null references projects(id) on delete cascade,
        entry_id text not null,
        primary key(project_id,entry_id),
        draft jsonb not null
      );
      create table if not exists entry_configuration_templates (
        project_id text not null,
        entry_id text not null,
        version text not null,
        template jsonb not null,
        primary key(project_id, entry_id, version),
        foreign key(project_id, version) references project_versions(project_id, version) on delete cascade
      );
      create table if not exists entry_configurations (
        project_id text not null references projects(id) on delete cascade,
        entry_id text not null,
        user_id text not null,
        state jsonb not null,
        primary key (project_id, entry_id, user_id)
      );








      create table if not exists project_membership_requests (
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

      create index if not exists project_membership_requests_project_idx
        on project_membership_requests(project_id, created_at desc);
      create unique index if not exists project_membership_requests_pending_idx
        on project_membership_requests(project_id, requester_user_id)
        where status = 'pending';

      create index if not exists project_versions_created_at_idx
        on project_versions(project_id, created_at desc);
      create index if not exists project_members_user_idx
        on project_members(user_id, project_id);
    `);
  }

  async listProjects(): Promise<DbRecord[]> {
    const result = await this.pool.query<Row>(`
      select id, name, entries, default_entry, project_card, project_info, package_version, has_draft, latest_version,
        owner_user_id, group_id, visibility, created_by_user_id,
        created_at, updated_at
      from projects
      where entries is not null and default_entry is not null
      order by name asc, id asc
    `);

    return result.rows.map(toProjectRecord);
  }

  async getProject(projectId: string): Promise<DbRecord | undefined> {
    const result = await this.pool.query<Row>(
      `select id, name, entries, default_entry, project_card, project_info, package_version, has_draft, latest_version,
        owner_user_id, group_id, visibility, created_by_user_id,
        created_at, updated_at
       from projects
       where id = $1 and entries is not null and default_entry is not null`,
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
       returning id, name, entries, default_entry, project_card, project_info, package_version, has_draft, latest_version,
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
           returning id, name, entries, default_entry, project_card, project_info, package_version, has_draft, latest_version,
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
             where project_id = $1 and path = 'steamharness.json'
             for update`,
            [update.projectId],
          );
          const packageContent = packageResult.rows[0]?.content;
          if (packageContent !== undefined) {
            const parsed = JSON.parse(packageContent) as unknown;
            if (!isRecord(parsed)) throw new Error("Workflow draft steamharness.json root must be an object.");
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
              [update.projectId, "steamharness.json", content, Buffer.byteLength(content)],
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
         entries,
         default_entry,
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
       values ($1, $2, $3::jsonb, $11, $4::jsonb, $5::jsonb, $6, false, null, $7, $8, $9, now(), now(), $10)
       on conflict (id) do nothing
       returning id, name, entries, default_entry, project_card, project_info, package_version, has_draft, latest_version,
         owner_user_id, group_id, visibility, created_by_user_id, created_at, updated_at`,
      [
        input.projectId,
        input.projectName,
        JSON.stringify(input.entries),
        JSON.stringify(input.projectCard),
        JSON.stringify(input.projectInfo),
        input.packageVersion ?? "0.0.0",
        input.ownerUserId ?? null,
        input.visibility ?? "private",
        input.createdByUserId ?? null,
        input.groupId ?? null,
        input.defaultEntry,
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



  async createProjectAccessRequest(input: {
    id: string;
    projectId: string;
    requesterUserId: string;
    reason: string;
  }): Promise<ProjectAccessRequest> {
    const result = await this.pool.query<ProjectAccessRequestRow>(
      `insert into project_membership_requests (
         id, project_id, requester_user_id, reason, status,
         created_at, updated_at
       ) values ($1, $2, $3, $4, 'pending', now(), now())
       on conflict (project_id, requester_user_id)
         where status = 'pending'
       do update set updated_at = project_membership_requests.updated_at
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
       from project_membership_requests
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
       from project_membership_requests
       where project_id = $1 and id = $2`,
      [projectId, requestId],
    );
    return result.rows[0] === undefined ? undefined : toProjectAccessRequest(result.rows[0]);
  }

  async resolveProjectAccessRequest(input: {
    projectId: string;
    requestId: string;
    status: "approved" | "rejected";
    actor: AccessActor;
  }): Promise<ProjectAccessRequest | undefined> {
    const row = await this.access.approveRequest(
      input.projectId,
      input.requestId,
      input.status,
      input.actor,
    );
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
       returning id, name, entries, default_entry, project_card, project_info, package_version, has_draft, latest_version,
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
           entries,
         default_entry,
           project_card,
           project_info,
           package_version,
           has_draft,
           owner_user_id,
           visibility,
           created_by_user_id,
           updated_at
         )
         values ($1, $2, $3::jsonb, $10, $4::jsonb, $5::jsonb, $6, true, $7, $8, $9, now())
         on conflict (id) do update set
           entries = excluded.entries,
           default_entry = excluded.default_entry,
           package_version = excluded.package_version,
           has_draft = true,
           owner_user_id = coalesce(projects.owner_user_id, excluded.owner_user_id),
           visibility = projects.visibility,
           created_by_user_id = coalesce(projects.created_by_user_id, excluded.created_by_user_id),
           updated_at = now()`,
        [
          input.projectId,
          input.projectName,
          JSON.stringify(input.entries),
          JSON.stringify(input.projectCard),
          JSON.stringify(input.projectInfo),
          input.packageVersion,
          input.ownerUserId ?? null,
          input.visibility ?? "private",
          input.createdByUserId ?? null,
          input.defaultEntry,
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
           source_object_path, release_log, created_by_user_id, entries, default_entry
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          input.projectId,
          input.version,
          input.projectName,
          input.createdAt,
          input.sourceHash,
          input.sourceObjectPath,
          input.releaseLog,
          input.createdByUserId ?? null,
          JSON.stringify(input.entries),
          input.defaultEntry,
        ],
      );
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
        source_object_path, release_log, created_by_user_id, entries, default_entry
       from project_versions
       where project_id = $1 and version = $2 and entries is not null and default_entry is not null`,
      [projectId, version],
    );

    if (result.rows[0] === undefined) return undefined;
    return toVersionRecord(result.rows[0]);
  }

  async listVersions(projectId: string): Promise<DbVersionRecord[]> {
    const result = await this.pool.query<VersionRow>(`SELECT project_id,project_name,version,created_at,source_hash,source_object_path,release_log,created_by_user_id,entries,default_entry FROM project_versions WHERE project_id=$1 AND entries IS NOT NULL AND default_entry IS NOT NULL ORDER BY created_at`, [projectId]);
    return result.rows.map(toVersionRecord);
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

  async listVersionsForProjects(
    projectIds: readonly string[],
  ): Promise<Map<string, DbVersionSummaryRecord[]>> {
    if (projectIds.length === 0) {
      return new Map();
    }

    const result = await this.pool.query<VersionSummaryRow>(
      `select project_id, project_name, version
       from project_versions
       where project_id = any($1::text[]) and entries is not null and default_entry is not null
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

  async configurationPublicationDraft(projectId: string, entryId: string, update?: (stored: unknown) => ConfigurationPublicationDraft): Promise<ConfigurationPublicationDraft | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([projectId,entryId,"configuration-publication"])]);
      const stored = await client.query("SELECT draft FROM entry_configuration_drafts WHERE project_id=$1 AND entry_id=$2 FOR UPDATE", [projectId,entryId]);
      const next = update ? update(stored.rows[0]?.draft) : stored.rows[0]?.draft;
      if (update) await client.query("INSERT INTO entry_configuration_drafts(project_id,entry_id,draft) VALUES($1,$2,$3::jsonb) ON CONFLICT(project_id,entry_id) DO UPDATE SET draft=excluded.draft", [projectId,entryId,JSON.stringify(next)]);
      await client.query("COMMIT"); return next;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async saveConfigurationTemplate(projectId: string, entryId: string, version: string, template: ProjectConfigurationTemplate): Promise<void> {
    await this.pool.query("INSERT INTO entry_configuration_templates(project_id,entry_id,version,template) VALUES($1,$2,$3,$4::jsonb)",[projectId,entryId,version,JSON.stringify(template)]);
  }
  async readConfigurationTemplate(projectId: string, entryId: string, version: string): Promise<ProjectConfigurationTemplate | undefined> {
    return (await this.pool.query("SELECT template FROM entry_configuration_templates WHERE project_id=$1 AND entry_id=$2 AND version=$3",[projectId,entryId,version])).rows[0]?.template;
  }
  async projectConfigurationState(projectId: string, entryId: string, userId: string, update: (stored: unknown) => ProjectConfigurationState): Promise<ProjectConfigurationState> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([projectId,entryId,userId,"configuration"])]);
      const stored = await client.query("SELECT state FROM entry_configurations WHERE project_id=$1 AND entry_id=$2 AND user_id=$3 FOR UPDATE",[projectId,entryId,userId]);
      const next = update(stored.rows[0]?.state);
      await client.query("INSERT INTO entry_configurations(project_id,entry_id,user_id,state) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(project_id,entry_id,user_id) DO UPDATE SET state=excluded.state",[projectId,entryId,userId,JSON.stringify(next)]);
      await client.query("COMMIT"); return next;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
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
  entries: unknown;
  default_entry: string;
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
  entries: ProjectEntry[];
  default_entry: string;
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

interface FileRow {
  path: string;
  content: string;
  size: number;
  encoding: string | null;
}

interface ProjectMemberRow {
  project_id: string;
  user_id: string;
  role: string;
  created_by: string | null;
  created_at: Date;
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


function toProjectRecord(row: Row): DbRecord {
  const manifest = normalizeProjectManifest({ projectId: row.id, name: row.name, entries: row.entries, defaultEntry: row.default_entry });
  return {
    id: row.id,
    name: row.name,
    entries: manifest.entries,
    defaultEntry: manifest.defaultEntry,
    projectCard: normalizeProjectCardMetadata(row.project_card, manifest.entries[0]!.type),
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

function toVersionRecord(row: VersionRow): DbVersionRecord { return { projectId: row.project_id, projectName: row.project_name, version: row.version, createdAt: row.created_at.toISOString(), sourceHash: row.source_hash, sourceObjectPath: row.source_object_path, releaseLog: row.release_log, createdByUserId: row.created_by_user_id ?? undefined, entries: row.entries, defaultEntry: row.default_entry }; }

function toVersionSummaryRecord(row: VersionSummaryRow): DbVersionSummaryRecord { return {projectId: row.project_id, projectName: row.project_name, version: row.version}; }

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

function isProjectAccessRequestStatus(
  value: unknown,
): value is ProjectAccessRequestStatus {
  return value === "pending" || value === "approved" || value === "rejected";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
