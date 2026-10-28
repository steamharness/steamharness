import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { DatabaseCatalog, type DatabaseCatalogState, type CreateDatabaseRequest } from '@steamharness/database-spaces/catalog';
import { assertDatabaseAuthorization, DATABASE_IDENTIFIER_PATTERN, DATABASE_UUID_PATTERN, type DatabaseActor, type DatabaseAuthorization, type DatabasePermissions, type DatabaseRequirement } from '@steamharness/database-spaces';
import { databaseReadPrefixes, isKnowledgeDocumentStorageKey } from 'steamharness';
import { createPostgresPool } from './postgres';
import { HttpError } from './protocol';

interface Address { spaceId: string; storageKind: 'kv' | 'persistent_value'; scope: 'project' | 'conversation'; conversationId?: string; key: string }
interface Consumer { projectId: string; entryId: string; alias: string; bindingRef: string; credentialVersion?: number }
interface Value { exists: boolean; value?: unknown; revision?: string }
const emptyCatalog = (): DatabaseCatalogState => ({ spaces: [], requests: [], grants: [], bindings: [] });

/** Independent host resources: intentionally no foreign key to projects. */
export class DatabaseSpaceRepository {
  private readonly pool?: pg.Pool;
  constructor(connectionString?: string) { if (connectionString) this.pool = createPostgresPool({ connectionString, label: 'database spaces' }); }
  private requirePool() { if (!this.pool) throw new HttpError(501, 501, 'Database spaces require the host PostgreSQL registry.'); return this.pool; }
  async init() {
    if (!this.pool) return;
    await this.pool.query(`CREATE TABLE IF NOT EXISTS database_space_catalog (id INTEGER PRIMARY KEY CHECK(id=1), content JSONB NOT NULL);
      INSERT INTO database_space_catalog VALUES(1,'{"spaces":[],"requests":[],"grants":[],"bindings":[]}') ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS database_entry_bindings (project_id UUID NOT NULL, entry_id TEXT NOT NULL, alias TEXT NOT NULL, binding_ref UUID NOT NULL, PRIMARY KEY(project_id,entry_id,alias));
      CREATE SEQUENCE IF NOT EXISTS database_space_revision;
      CREATE TABLE IF NOT EXISTS database_space_values (space_id UUID NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('kv','persistent_value')), namespace TEXT NOT NULL, key TEXT NOT NULL, value JSONB NOT NULL, revision BIGINT NOT NULL DEFAULT nextval('database_space_revision'), source JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(space_id,kind,namespace,key));
      CREATE TABLE IF NOT EXISTS database_space_revisions (space_id UUID PRIMARY KEY, revision BIGINT NOT NULL);`);
  }
  async close() { await this.pool?.end(); }
  private async transaction<T>(writeCatalog: boolean, run: (catalog: DatabaseCatalog, client: pg.PoolClient) => Promise<T> | T): Promise<T> {
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      const row = await client.query(`SELECT content FROM database_space_catalog WHERE id=1 FOR ${writeCatalog ? 'UPDATE' : 'SHARE'}`);
      const state = row.rows[0]?.content as DatabaseCatalogState ?? emptyCatalog();
      const result = await run(new DatabaseCatalog('server', state, randomUUID, () => new Date().toISOString()), client);
      if (writeCatalog) await client.query('UPDATE database_space_catalog SET content=$1 WHERE id=1', [JSON.stringify(state)]);
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  read(actor: DatabaseActor) { return this.transaction(false, catalog => catalog.visible(actor)); }
  page(actor: DatabaseActor, options: {section:string;page:number;pageSize:number;search?:string;projectId?:string;entryId?:string}) {
    const page=Math.max(1,Math.floor(options.page)||1),pageSize=Math.min(100,Math.max(1,Math.floor(options.pageSize)||20));
    return this.transaction(false,catalog=>{
      const visible=catalog.visible(actor);
      if(!["spaces","requests","grants"].includes(options.section)) throw new HttpError(400,400,"Unknown database collection.");
      const items=(visible[options.section as "spaces"|"requests"|"grants"] as any[]).filter(item=>((!options.projectId&&!options.entryId)|| (options.section==="spaces" ? visible.bindings.some(binding=>binding.spaceId===item.spaceId&&(!options.projectId||binding.projectId===options.projectId)&&(!options.entryId||binding.entryId===options.entryId)) : (!options.projectId||item.projectId===options.projectId)&&(!options.entryId||item.entryId===options.entryId)))&&(!options.search||JSON.stringify(item).toLowerCase().includes(options.search.toLowerCase()))).map(item=>({...item,canManage:actor.isSystemAdmin||item.ownerId===actor.userId||visible.spaces.find(space=>space.spaceId===item.spaceId)?.ownerId===actor.userId,canReview:actor.isSystemAdmin||item.target?.kind==="access"&&visible.spaces.find(space=>space.spaceId===item.target.spaceId)?.ownerId===actor.userId}));
      return {items:items.slice((page-1)*pageSize,page*pageSize),total:items.length,page,pageSize};
    });
  }
  request(input: CreateDatabaseRequest, actor: DatabaseActor) { return this.transaction(true, catalog => catalog.request(input, actor)); }
  review(requestId: string, decision: { approve: boolean; permissions?: DatabasePermissions; reason?: string }, actor: DatabaseActor) { return this.transaction(true, catalog => catalog.review(requestId, decision, actor)); }
  manage(grantId: string, action: 'revoke' | 'rotate' | 'narrow', actor: DatabaseActor, permissions?: DatabasePermissions) { return this.transaction(true, catalog => action === 'revoke' ? catalog.revoke(grantId, actor) : action === 'rotate' ? catalog.rotate(grantId, actor) : catalog.narrow(grantId, permissions!, actor)); }
  authorization(bindingRef: string, consumer: { projectId: string; entryId: string }) {
    return this.transaction(false, catalog => {
      const authorization = catalog.authorization(bindingRef);
      if (!authorization || authorization.binding.projectId !== consumer.projectId || authorization.binding.entryId !== consumer.entryId || authorization.grant.revokedAt) throw new HttpError(403, 403, 'Database binding is unavailable or revoked.');
      return authorization;
    });
  }
  async bind(consumer: { projectId: string; entryId: string; alias: string }, bindingRef: string) {
    return this.transaction(false, async (catalog, client) => {
      const authorization = catalog.authorization(bindingRef);
      const requirement = { ...consumer, bindingRef, host: "server" as const };
      if (!authorization) throw new HttpError(403,403,"Database binding is unavailable.");
      assertDatabaseAuthorization({ ...authorization, grant: { ...authorization.grant, permissions: fullPermissions() } }, requirement, "kv", "read", "");
      await client.query("INSERT INTO database_entry_bindings VALUES($1,$2,$3,$4) ON CONFLICT(project_id,entry_id,alias) DO UPDATE SET binding_ref=excluded.binding_ref", [consumer.projectId,consumer.entryId,consumer.alias,bindingRef]);
      return authorization.binding;
    });
  }
  async bindingFor(consumer: { projectId: string; entryId: string; alias: string }): Promise<string | undefined> {
    const result = await this.requirePool().query("SELECT binding_ref FROM database_entry_bindings WHERE project_id=$1 AND entry_id=$2 AND alias=$3", [consumer.projectId,consumer.entryId,consumer.alias]);
    return result.rows[0]?.binding_ref;
  }
  async listValues(spaceId: string, actor: DatabaseActor, page = 1, pageSize = 30, search = "") {
    page = Math.max(1,Math.floor(page)); pageSize = Math.max(1,Math.min(100,Math.floor(pageSize)));
    return this.transaction(false, async (catalog,client) => {
      managerAuthorization(catalog,spaceId,actor);
      const args = [spaceId, `%${search.replaceAll("%","\\%").replaceAll("_","\\_")}%`];
      const total = await client.query("SELECT count(*)::int AS count FROM database_space_values WHERE space_id=$1 AND kind='kv' AND key ILIKE $2",args);
      const result = await client.query("SELECT namespace,key,value,revision::text,source,updated_at FROM database_space_values WHERE space_id=$1 AND kind='kv' AND key ILIKE $2 ORDER BY namespace,key LIMIT $3 OFFSET $4",[...args,pageSize,(page-1)*pageSize]);
      return { items: result.rows, total: total.rows[0].count, page, pageSize };
    });
  }
  async managementDatabase(spaceId: string, actor: DatabaseActor, namespace?: string) {
    const {createDatabasesContext,RemoteDatabaseSpaceStore} = await import("steamharness");
    const requirement: DatabaseRequirement = { alias:"space",host:"server",bindingRef:spaceId,permissions:fullPermissions() };
    if (namespace && namespace !== "space" && (!namespace.startsWith("conversation:") || namespace.length > 525)) throw new HttpError(400,400,"Invalid database namespace.");
    return createDatabasesContext({projectId:spaceId,entryId:"management",conversationNamespace: namespace?.startsWith("conversation:") ? namespace.slice(13) : undefined,requirements:[requirement],resolver:{resolve:async()=>{
      const authorization=await this.transaction(false,catalog=>managerAuthorization(catalog,spaceId,actor));
      const store=new RemoteDatabaseSpaceStore({serverUrl:"",token:""},{projectId:spaceId,entryId:"management",alias:"space",bindingRef:spaceId},spaceId,1,async <T>(body:Record<string,unknown>)=>await this.data(spaceId,body,actor,true) as T,true);
      return {authorization,store};
    }}}).get("space");
  }
  async data(spaceId: string, raw: Record<string, any>, actor: DatabaseActor, management = false, requirement?: DatabaseRequirement): Promise<unknown> {
    if (!DATABASE_UUID_PATTERN.test(spaceId)) throw new HttpError(400, 400, 'Invalid database space.');
    const consumer: Consumer = { projectId: raw.projectId, entryId: raw.entryId, alias: raw.alias, bindingRef: raw.bindingRef, credentialVersion: raw.credentialVersion };
    if (!DATABASE_UUID_PATTERN.test(consumer.projectId ?? '') || !DATABASE_IDENTIFIER_PATTERN.test(consumer.entryId ?? '') || !DATABASE_IDENTIFIER_PATTERN.test(consumer.alias ?? '') || !DATABASE_UUID_PATTERN.test(consumer.bindingRef ?? '')) throw new HttpError(400, 400, 'A database binding and consumer identity are required.');
    return this.transaction(false, async (catalog, client) => {
      const authorization = management ? managerAuthorization(catalog,spaceId,actor) : catalog.authorization(consumer.bindingRef);
      if (!authorization || authorization.space.spaceId !== spaceId || authorization.grant.revokedAt || authorization.grant.credentialVersion !== consumer.credentialVersion) throw new HttpError(403, 403, 'Database authorization changed. Restore this binding.');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`database-space:${spaceId}`]);
      const address = (value: any): Address => {
        if (!value || value.spaceId !== spaceId || !['kv', 'persistent_value'].includes(value.storageKind) || !['project', 'conversation'].includes(value.scope) || typeof value.key !== 'string' || !value.key.trim() || value.key.length > 1024 || /\0/.test(value.key)) throw new HttpError(400, 400, 'Invalid database address.');
        if (value.scope === 'conversation' && (typeof value.conversationId !== 'string' || !management && !value.conversationId.startsWith(`${consumer.projectId}:${consumer.entryId}:`) || value.conversationId.length > 512)) throw new HttpError(403, 403, 'Invalid database conversation namespace.');
        return value as Address;
      };
      const check = (entry: Address, operation: 'read' | 'write') => {
        const knowledge = isKnowledgeDocumentStorageKey(entry.key) || entry.key.startsWith('__knowledge_file:');
        if (entry.storageKind === 'kv' && knowledge || entry.storageKind === 'persistent_value' && !knowledge) throw new HttpError(403, 403, 'Knowledge storage must use the knowledge API.');
        try {
          assertDatabaseAuthorization(authorization,{...consumer,host:'server'},entry.storageKind==='kv'?'kv':'knowledge',operation,entry.key);
          if(requirement) assertDatabaseAuthorization({...authorization,grant:{...authorization.grant,permissions:requirement.permissions}},{...consumer,host:'server'},entry.storageKind==='kv'?'kv':'knowledge',operation,entry.key);
        }
        catch (error) { throw new HttpError(403, 403, error instanceof Error ? error.message : 'Database access denied.'); }
      };
      const args = (entry: Address) => [spaceId, entry.storageKind, entry.scope === 'conversation' ? `conversation:${entry.conversationId}` : 'space', entry.key];
      const read = async (entry: Address): Promise<Value> => { check(entry, 'read'); const result = await client.query('SELECT value,revision::text FROM database_space_values WHERE space_id=$1 AND kind=$2 AND namespace=$3 AND key=$4', args(entry)); return result.rows[0] ? { exists: true, value: result.rows[0].value, revision: result.rows[0].revision } : { exists: false }; };
      const write = async (entry: Address, value: unknown) => {
        check(entry, 'write'); const json = JSON.stringify(value); if (json === undefined || json.length > 70 * 1024 * 1024) throw new HttpError(400, 400, 'Invalid database JSON value.');
        // Consumer attribution is trusted host data, never caller-supplied identity.
        const source = { projectId: consumer.projectId, entryId: consumer.entryId, userId: actor.userId };
        const result = await client.query(`INSERT INTO database_space_values(space_id,kind,namespace,key,value,source) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(space_id,kind,namespace,key) DO UPDATE SET value=excluded.value,source=excluded.source,revision=nextval('database_space_revision'),updated_at=now() RETURNING revision::text`, [...args(entry), json, JSON.stringify(source)]);
        await revision(result.rows[0].revision);
      };
      const revision = async (value?: string) => { const next = value ?? (await client.query("SELECT nextval('database_space_revision')::text AS revision")).rows[0].revision; await client.query('INSERT INTO database_space_revisions VALUES($1,$2) ON CONFLICT(space_id) DO UPDATE SET revision=excluded.revision', [spaceId, next]); };
      const remove = async (entry: Address) => { check(entry, 'write'); const result = await client.query('DELETE FROM database_space_values WHERE space_id=$1 AND kind=$2 AND namespace=$3 AND key=$4', args(entry)); if (result.rowCount) await revision(); return { removed: !!result.rowCount }; };
      if (raw.operation === 'revision') {
        const grant = authorization.grant;
        if (authorization.binding.projectId !== consumer.projectId || authorization.binding.entryId !== consumer.entryId || authorization.binding.alias !== consumer.alias || !(['kv', 'knowledge'] as const).some(resource => databaseReadPrefixes(grant.permissions[resource].read, requirement?.permissions[resource].read ?? { mode: 'all' })?.length !== 0)) throw new HttpError(403, 403, 'Database revisions require read access.');
        const result = await client.query('SELECT revision::text FROM database_space_revisions WHERE space_id=$1', [spaceId]); return { revision: result.rows[0]?.revision ?? '0' };
      }
      if (raw.operation === 'list') {
        const entry = address(raw.entry);
        if (entry.storageKind !== 'kv') throw new HttpError(403,403,'Use the knowledge API.');
        const identity = {...authorization, grant:{...authorization.grant,permissions:fullPermissions()}};
        assertDatabaseAuthorization(identity,{...consumer,host:'server'},'kv','read','');
        if (raw.keyPrefixes !== undefined && (!Array.isArray(raw.keyPrefixes) || raw.keyPrefixes.length > 1024 || raw.keyPrefixes.some((prefix: unknown) => typeof prefix !== 'string' || !prefix.length || prefix.length > 1024 || prefix.includes('\0')))) throw new HttpError(400,400,'Invalid database key prefixes.');
        const prefixes = databaseReadPrefixes(
          authorization.grant.permissions.kv.read,
          requirement?.permissions.kv.read ?? {mode:'all'},
          raw.keyPrefixes === undefined ? {mode:'all'} : {mode:'prefixes',prefixes:raw.keyPrefixes},
        );
        if (prefixes?.length === 0) throw new HttpError(403,403,'KV read access is required.');
        const size = Math.min(100, Math.max(1, Math.floor(raw.pageSize ?? 30))), offset = Number(raw.cursor ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400,400,'Invalid database cursor.');
        const namespace = entry.scope === 'conversation' ? `conversation:${entry.conversationId}` : 'space';
        const parameters: unknown[] = [spaceId, namespace];
        const clauses = ["space_id=$1", "kind='kv'", "namespace=$2"];
        if (prefixes) {
          clauses.push(`(${prefixes.map(prefix => { parameters.push(prefix); return `left(key,length($${parameters.length}::text))=$${parameters.length}`; }).join(' OR ')})`);
        }
        if (raw.query) { parameters.push(String(raw.query)); clauses.push(`position(lower($${parameters.length}::text) in lower(key))>0`); }
        const where = clauses.join(' AND ');
        const count = await client.query(`SELECT count(*)::int AS total FROM database_space_values WHERE ${where}`, parameters);
        const total = count.rows[0].total;
        const result = await client.query(`SELECT key,value,updated_at FROM database_space_values WHERE ${where} ORDER BY key LIMIT $${parameters.length+1} OFFSET $${parameters.length+2}`, [...parameters,size,offset]);
        const items = result.rows.map(row => ({key:row.key,value:row.value,updatedAt:new Date(row.updated_at).toISOString(),scope:entry.scope,conversationId:entry.conversationId}));
        return {items,total,hasMore:offset+size<total,...(offset+size<total?{nextCursor:String(offset+size)}:{})};
      }
      if (raw.operation === 'transaction') {
        if (!Array.isArray(raw.entries) || raw.entries.length > 10000) throw new HttpError(400, 400, 'Invalid database transaction.');
        const entries = raw.entries.map((item: any) => ({ ...item, entry: address(item.entry) }));
        if (new Set(entries.map((item: any) => JSON.stringify(args(item.entry)))).size !== entries.length) throw new HttpError(400, 400, 'Duplicate transaction address.');
        for (const item of entries) { const before = await read(item.entry); if ((before.revision ?? null) !== item.expectedRevision) return { applied: false }; if (item.mutation) { if (!['set', 'delete'].includes(item.mutation.operation)) throw new HttpError(400, 400, 'Invalid transaction mutation.'); check(item.entry, 'write'); } }
        for (const item of entries) if (item.mutation) { if (item.mutation.operation === 'set') await write(item.entry, item.mutation.value); else await remove(item.entry); }
        return { applied: true };
      }
      const entry = address(raw.entry);
      if (raw.operation === 'get') return read(entry);
      if (raw.operation === 'set') { await write(entry, raw.value); return { written: true }; }
      if (raw.operation === 'delete') return remove(entry);
      if (raw.operation === 'compare-and-set') { const before = await read(entry); check(entry, 'write'); if ((before.revision ?? null) !== raw.expectedRevision) return { applied: false }; await write(entry, raw.value); return { applied: true }; }
      throw new HttpError(400, 400, 'Unsupported database operation.');
    });
  }
}

function fullPermissions(): DatabasePermissions { const all={mode:"all" as const}; return {kv:{read:all,write:all},knowledge:{read:all,write:all}}; }
function managerAuthorization(catalog: DatabaseCatalog, spaceId: string, actor: DatabaseActor): DatabaseAuthorization {
  const space=catalog.state.spaces.find(item=>item.spaceId===spaceId);
  if(!space || (!actor.isSystemAdmin && space.ownerId!==actor.userId)) throw new HttpError(403,403,"Only the database space owner or host administrator may manage its data.");
  return {space,grant:{grantId:spaceId,spaceId,projectId:spaceId,entryId:"management",permissions:fullPermissions(),credentialVersion:1,createdAt:space.createdAt},binding:{bindingRef:spaceId,alias:"space",host:"server",spaceId,grantId:spaceId,projectId:spaceId,entryId:"management"}};
}
