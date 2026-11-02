import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { FileReference, KnowledgeBaseBinding, KnowledgeBaseIdentity, KnowledgeBaseResource } from 'steamharness';
import { createPostgresPool } from './postgres';
import type { ObjectStorage } from './object-storage';
import { HttpError } from './protocol';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const aliasPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const ddl = `
create extension if not exists pg_trgm with schema public;
create table __S__.bases(id uuid primary key, owner_user_id text not null, name text not null, request_id uuid not null unique, revision bigint not null default 0, created_at timestamptz not null default clock_timestamp());
create table __S__.grants(base_id uuid references __S__.bases on delete cascade, user_id text not null, mode text not null check(mode in ('read','write')), revision integer not null default 1, revoked boolean not null default false, primary key(base_id,user_id));
create table __S__.bindings(id uuid primary key, user_id text not null, project_id uuid not null, entry_id text not null, alias text not null, base_id uuid not null references __S__.bases, mode text not null check(mode in ('read','write')), revision integer not null default 1, unique(user_id,project_id,entry_id,alias));
create sequence __S__.document_sequence;
create table __S__.documents(base_id uuid not null references __S__.bases on delete cascade, id text not null, title text not null, markdown text not null, preview text not null, sequence bigint not null default nextval('__S__.document_sequence'), revision integer not null default 1, created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(), primary key(base_id,id));
create index on __S__.documents(base_id,sequence desc);
create table __S__.chunks(base_id uuid not null, document_id text not null, ordinal integer not null, content text not null, search tsvector generated always as (to_tsvector('simple',content)) stored, primary key(base_id,document_id,ordinal), foreign key(base_id,document_id) references __S__.documents on delete cascade);
create index on __S__.chunks using gin(search);
create index on __S__.chunks using gin(lower(content) public.gin_trgm_ops);
create table __S__.objects(path text primary key, state text not null check(state in ('pending','active','garbage')), created_at timestamptz not null default clock_timestamp());
create table __S__.attachments(base_id uuid not null references __S__.bases on delete cascade, id uuid not null, name text not null, mime_type text not null, kind text not null, size integer not null, sha256 text not null, created_at timestamptz not null default clock_timestamp(), primary key(base_id,id));
`;
type Client = pg.PoolClient;
function fail(status: number, message: string): never { throw new HttpError(status, status, message); }
function text(value: unknown, field: string, max = 256, empty = false): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || !empty && !value.trim()) fail(400, `Invalid knowledge ${field}.`);
  return value;
}
function uuid(value: unknown): string { const id = text(value, 'identity'); if (!uuidPattern.test(id)) fail(400, 'Invalid knowledge identity.'); return id.toLowerCase(); }
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(400, 'Invalid knowledge pagination or line range.');
  return value as number;
}
function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decode(value: unknown): any {
  if (value === undefined) return undefined;
  try { const cursor = JSON.parse(Buffer.from(text(value, 'cursor', 4096), 'base64url').toString('utf8')); if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) fail(400, 'Invalid knowledge cursor.'); return cursor; } catch { fail(400, 'Invalid knowledge cursor.'); }
}
function document(row: any) { return { id: row.id, title: row.title, markdown: row.markdown, revision: row.revision, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() }; }
function summary(row: any) { return { id: row.id, title: row.title, markdownPreview: row.preview, revision: row.revision, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() }; }
function resource(row: any): KnowledgeBaseResource { return { id: row.id, name: row.name, ownerUserId: row.owner_user_id, revision: Number(row.revision), createdAt: row.created_at.toISOString() }; }

/** Platform knowledge records are relational; binary contents live only in private object storage. */
export class KnowledgeBaseRepository {
  private readonly pool?: pg.Pool;
  private readonly schema: string;
  private garbageTimer?: ReturnType<typeof setInterval>;
  constructor(connectionString: string | undefined, private readonly objects: ObjectStorage, schema = 'steamharness_knowledge') {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid knowledge schema.');
    this.schema = `"${schema}"`;
    if (connectionString) this.pool = createPostgresPool({ connectionString, label: 'knowledge bases' });
  }
  private db() { if (!this.pool) fail(503, 'Knowledge storage requires PostgreSQL.'); return this.pool; }
  private async transaction<T>(work: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.db().connect();
    try { await client.query('begin'); const result = await work(client); await client.query('commit'); return result; }
    catch (error) { await client.query('rollback').catch(() => undefined); throw error; } finally { client.release(); }
  }
  async init(): Promise<void> {
    if (!this.pool) return;
    await this.transaction(async client => {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`knowledge:migrations:${this.schema}`]);
      await client.query(`create schema if not exists ${this.schema}; create table if not exists ${this.schema}.schema_migrations(version integer primary key,checksum text not null)`);
      const checksum = createHash('sha256').update(ddl).digest('hex');
      const previous = (await client.query(`select checksum from ${this.schema}.schema_migrations where version=1`)).rows[0];
      if (previous && previous.checksum !== checksum) throw new Error('Knowledge migration checksum does not match.');
      if (!previous) { await client.query(ddl.replaceAll('__S__', this.schema)); await client.query(`insert into ${this.schema}.schema_migrations values(1,$1)`, [checksum]); }
    });
    await this.collectGarbage();
    this.garbageTimer = setInterval(() => { void this.collectGarbage().catch(() => undefined); }, 60_000);
    this.garbageTimer.unref();
  }
  async close() { clearInterval(this.garbageTimer); await this.pool?.end(); }
  async collectGarbage(): Promise<void> {
    await this.transaction(async client => {
      const rows = (await client.query(`select path from ${this.schema}.objects where state='garbage' or state='pending' and created_at<clock_timestamp()-interval '1 hour' for update skip locked limit 100`)).rows;
      for (const row of rows) { await this.objects.deletePrivateObject(row.path); await client.query(`delete from ${this.schema}.objects where path=$1`, [row.path]); }
    });
  }
  private async access(client: Client, actor: string, id: string, write = false) {
    text(actor, 'account'); uuid(id);
    const base = (await client.query(`select * from ${this.schema}.bases where id=$1 for ${write ? 'update' : 'share'}`, [id])).rows[0];
    if (!base) fail(404, 'Knowledge base does not exist.');
    const grant = base.owner_user_id === actor ? { mode: 'write', revision: 0 } : (await client.query(`select * from ${this.schema}.grants where base_id=$1 and user_id=$2 and not revoked for share`, [id, actor])).rows[0];
    if (!grant || write && grant.mode !== 'write') fail(403, 'Knowledge access is unavailable or read-only.');
    return { base, grant };
  }
  describe(actor: string, id: string) { return this.transaction(async client => { const { base, grant } = await this.access(client, actor, id); return { ...resource(base), mode: grant.mode, canManage: base.owner_user_id === actor }; }); }
  async list(actor: string, input: { page?: number; pageSize?: number; search?: string } = {}) {
    const page = integer(input.page, 1, 1, 1_000_000), pageSize = integer(input.pageSize, 20, 1, 100), search = text(input.search ?? '', 'search', 256, true);
    const where = `(owner_user_id=$1 or exists(select 1 from ${this.schema}.grants g where g.base_id=b.id and g.user_id=$1 and not g.revoked)) and strpos(lower(name),lower($2))>0`;
    const count = await this.db().query(`select count(*)::int as total from ${this.schema}.bases b where ${where}`, [actor, search]);
    const rows = await this.db().query(`select * from ${this.schema}.bases b where ${where} order by created_at desc,id limit $3 offset $4`, [actor, search, pageSize, (page - 1) * pageSize]);
    return { items: rows.rows.map(resource), total: count.rows[0].total, page, pageSize };
  }
  async create(actor: string, input: { name: string; requestId: string }) {
    const name = text(input.name, 'name', 128).trim(), requestId = uuid(input.requestId); text(actor, 'account');
    const rows = await this.db().query(`insert into ${this.schema}.bases(id,owner_user_id,name,request_id) values($1,$2,$3,$4) on conflict(request_id) do update set request_id=excluded.request_id where bases.owner_user_id=excluded.owner_user_id and bases.name=excluded.name returning *`, [randomUUID(), actor, name, requestId]);
    if (!rows.rowCount) fail(409, 'Knowledge creation request already has a different result.');
    return resource(rows.rows[0]);
  }
  private async owner(client: Client, actor: string, id: string) { const access = await this.access(client, actor, id, true); if (access.base.owner_user_id !== actor) fail(403, 'Only the knowledge base owner may manage access.'); return access; }
  async grants(actor: string, id: string) { return this.transaction(async client => { await this.owner(client, actor, id); return (await client.query(`select user_id as "userId",mode,revision,revoked from ${this.schema}.grants where base_id=$1 order by user_id`, [id])).rows; }); }
  async grant(actor: string, id: string, userId: string, mode: 'read' | 'write', revoke = false) {
    text(userId, 'account'); if (!['read', 'write'].includes(mode)) fail(400, 'Invalid knowledge access mode.');
    return this.transaction(async client => {
      await this.owner(client, actor, id);
      const rows = await client.query(`insert into ${this.schema}.grants(base_id,user_id,mode,revoked) values($1,$2,$3,$4) on conflict(base_id,user_id) do update set mode=excluded.mode,revoked=excluded.revoked,revision=grants.revision+1 returning user_id as "userId",mode,revision,revoked`, [id, userId, mode, revoke]);
      return rows.rows[0];
    });
  }
  private identity(input: KnowledgeBaseIdentity) { uuid(input.projectId); uuid(input.knowledgeBaseId); if (!aliasPattern.test(input.entryId) || !aliasPattern.test(input.alias)) fail(400, 'Invalid knowledge consumer.'); }
  async bind(actor: string, input: KnowledgeBaseIdentity & { mode?: 'read' | 'write' }) {
    this.identity(input);
    return this.transaction(async client => {
      const previous = (await client.query(`select * from ${this.schema}.bindings where user_id=$1 and project_id=$2 and entry_id=$3 and alias=$4 for update`, [actor, input.projectId, input.entryId, input.alias])).rows[0];
      const access = await this.access(client, actor, input.knowledgeBaseId), mode = input.mode ?? access.grant.mode;
      if (!['read', 'write'].includes(mode) || mode === 'write' && access.grant.mode !== 'write') fail(403, 'Knowledge binding exceeds account access.');
      const row = (await client.query(`insert into ${this.schema}.bindings(id,user_id,project_id,entry_id,alias,base_id,mode) values($1,$2,$3,$4,$5,$6,$7) on conflict(user_id,project_id,entry_id,alias) do update set id=excluded.id,base_id=excluded.base_id,mode=excluded.mode,revision=case when bindings.base_id=excluded.base_id and bindings.mode=excluded.mode then bindings.revision else bindings.revision+1 end returning *`, [previous?.base_id === input.knowledgeBaseId && previous?.mode === mode ? previous.id : randomUUID(), actor, input.projectId, input.entryId, input.alias, input.knowledgeBaseId, mode])).rows[0];
      return this.binding(row, access.grant.revision);
    });
  }
  async bindings(actor: string, projectId: string, entryId: string) {
    uuid(projectId); if (!aliasPattern.test(entryId)) fail(400, 'Invalid knowledge entry.');
    const result = await this.db().query(`select b.*, coalesce(g.revision,0) as access_revision from ${this.schema}.bindings b left join ${this.schema}.grants g on g.base_id=b.base_id and g.user_id=b.user_id where b.user_id=$1 and b.project_id=$2 and b.entry_id=$3 order by b.alias`, [actor, projectId, entryId]);
    return result.rows.map(row => ({ ...this.binding(row, row.access_revision), alias: row.alias, projectId: row.project_id, entryId: row.entry_id }));
  }
  async unbind(actor: string, projectId: string, entryId: string, alias: string) {
    uuid(projectId); if (!aliasPattern.test(entryId) || !aliasPattern.test(alias)) fail(400, 'Invalid knowledge consumer.');
    await this.db().query(`delete from ${this.schema}.bindings where user_id=$1 and project_id=$2 and entry_id=$3 and alias=$4`, [actor, projectId, entryId, alias]);
  }
  private binding(row: any, accessRevision: number): KnowledgeBaseBinding { return { id: row.id, revision: row.revision, knowledgeBaseId: row.base_id, mode: row.mode, accessRevision }; }
  private async resolve(client: Client, actor: string, input: KnowledgeBaseIdentity, write = false) {
    this.identity(input);
    const row = (await client.query(`select * from ${this.schema}.bindings where user_id=$1 and project_id=$2 and entry_id=$3 and alias=$4 for share`, [actor, input.projectId, input.entryId, input.alias])).rows[0];
    if (!row || row.base_id !== input.knowledgeBaseId) fail(403, 'Knowledge binding is missing or changed.');
    const access = await this.access(client, actor, row.base_id, write);
    if (write && row.mode !== 'write') fail(403, 'Knowledge binding is read-only.');
    return { ...access, binding: this.binding(row, access.grant.revision) };
  }
  resolveBinding(actor: string, input: KnowledgeBaseIdentity) { return this.transaction(async client => (await this.resolve(client, actor, input)).binding); }
  async operation(actor: string, id: string, operation: string, input: Record<string, any> = {}, consumer?: { identity: KnowledgeBaseIdentity; binding: KnowledgeBaseBinding }): Promise<any> {
    const reads = new Set(['knowledge.listDocuments', 'knowledge.getDocument', 'knowledge.searchDocuments', 'knowledge.readDocumentLines', 'knowledge.revision', 'files.readFile', 'files.stat', 'files.list']);
    const writes = new Set(['knowledge.createDocument', 'knowledge.editDocument', 'knowledge.deleteDocument', 'files.createFile', 'files.deleteFile']);
    if (!reads.has(operation) && !writes.has(operation)) fail(400, 'Unknown knowledge operation.');
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Invalid knowledge input.');
    let upload: { id: string; name: string; mime_type: string; kind: string; size: number; sha256: string; created_at: Date } | undefined;
    if (operation === 'files.createFile') {
      await this.transaction(async client => { const access = consumer ? await this.resolve(client, actor, consumer.identity, true) : await this.access(client, actor, id, true); this.checkBinding(access, id, consumer); });
      const name = text(input.name, 'attachment name', 512); if (/[\\/]/.test(name)) fail(400, 'Invalid attachment name.');
      const mime_type = text(input.mimeType || 'application/octet-stream', 'attachment media type', 256), kind = input.kind ?? (mime_type.startsWith('image/') ? 'image' : 'file');
      if (!['file', 'image'].includes(kind)) fail(400, 'Invalid attachment kind.');
      const base64 = text(input.base64, 'attachment content', Math.ceil(50 * 1024 * 1024 / 3) * 4, true);
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.toString('base64') !== base64) fail(400, 'Invalid attachment encoding.'); if (bytes.length > 50 * 1024 * 1024) fail(400, 'Attachment exceeds 50 MiB.');
      upload = { id: randomUUID(), name, mime_type, kind, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), created_at: new Date() };
      const objectPath = this.objectPath(id, upload);
      // Persist upload intent before writing bytes, so crashes and failed metadata commits are recoverable.
      await this.db().query(`insert into ${this.schema}.objects(path,state) values($1,'pending')`, [objectPath]);
      await this.objects.uploadPrivateBuffer(objectPath, bytes, mime_type);
    }
    const result = await this.transaction(async client => {
      const access = consumer ? await this.resolve(client, actor, consumer.identity, writes.has(operation)) : await this.access(client, actor, id, writes.has(operation));
      this.checkBinding(access, id, consumer);
      const bump = () => client.query(`update ${this.schema}.bases set revision=revision+1 where id=$1`, [id]);
      const docId = () => text(input.documentId ?? input.id, 'document ID', 256);
      const get = async () => (await client.query(`select * from ${this.schema}.documents where base_id=$1 and id=$2`, [id, docId()])).rows[0];
      const expected = (row: any) => { if (input.expectedRevision !== undefined && integer(input.expectedRevision, 1, 1, 2147483647) !== row?.revision) fail(409, 'Knowledge document changed. Reload before saving.'); };
      if (operation === 'knowledge.revision') return { revision: String(access.base.revision) };
      if (operation === 'knowledge.listDocuments') {
        const size = integer(input.pageSize, 20, 1, 100), cursor = decode(input.cursor);
        if (cursor && (cursor.base !== id || (typeof cursor.before !== 'string' || !/^[1-9]\d{0,18}$/.test(cursor.before) || BigInt(cursor.before) > 9223372036854775807n))) fail(400, 'Invalid knowledge cursor.');
        const count = (await client.query(`select count(*)::int as total from ${this.schema}.documents where base_id=$1`, [id])).rows[0].total;
        const rows = (await client.query(`select * from ${this.schema}.documents where base_id=$1 and ($2::bigint is null or sequence<$2) order by sequence desc limit $3`, [id, cursor?.before ?? null, size + 1])).rows;
        const page = rows.slice(0, size), hasMore = rows.length > size;
        return { items: page.map(summary), total: count, hasMore, ...(hasMore ? { nextCursor: encode({ base: id, before: String(page.at(-1).sequence) }) } : {}) };
      }
      if (operation === 'knowledge.getDocument') { const row = await get(); return row ? document(row) : null; }
      if (operation === 'knowledge.createDocument' || operation === 'knowledge.editDocument') {
        const creating = operation === 'knowledge.createDocument', documentId = creating ? text(input.id ?? randomUUID(), 'document ID', 256) : docId();
        const previous = creating ? undefined : await get();
        if (!creating && !previous) fail(404, 'Knowledge document does not exist.'); expected(previous);
        const title = text(input.title ?? previous?.title, 'title', 512), markdown = text(input.markdown ?? previous?.markdown, 'markdown', 4 * 1024 * 1024, true);
        const preview = markdown.replace(/\s+/gu, ' ').trim().slice(0, 160);
        if (creating && (await client.query(`select 1 from ${this.schema}.documents where base_id=$1 and id=$2`, [id, documentId])).rowCount) fail(409, 'Knowledge document already exists.');
        const row = creating ? (await client.query(`insert into ${this.schema}.documents(base_id,id,title,markdown,preview) values($1,$2,$3,$4,$5) returning *`, [id, documentId, title, markdown, preview])).rows[0]
          : (await client.query(`update ${this.schema}.documents set title=$3,markdown=$4,preview=$5,revision=revision+1,sequence=nextval('${this.schema}.document_sequence'),updated_at=clock_timestamp() where base_id=$1 and id=$2 returning *`, [id, documentId, title, markdown, preview])).rows[0];
        await client.query(`delete from ${this.schema}.chunks where base_id=$1 and document_id=$2`, [id, documentId]);
        await client.query(`insert into ${this.schema}.chunks(base_id,document_id,ordinal,content) select $1,$2,ordinality::int,content from unnest($3::text[]) with ordinality as lines(content,ordinality)`, [id, documentId, markdown.split(/\r?\n/)]);
        await bump(); return document(row);
      }
      if (operation === 'knowledge.deleteDocument') {
        const row = await get(); expected(row);
        if (row) { await client.query(`delete from ${this.schema}.documents where base_id=$1 and id=$2`, [id, docId()]); await bump(); }
        return { id: docId(), deleted: !!row };
      }
      if (operation === 'knowledge.readDocumentLines') {
        const row = await get(); if (!row) fail(404, 'Knowledge document does not exist.');
        const startLine = integer(input.startLine, 1, 1, 10_000_000), endLine = integer(input.endLine, startLine, startLine, startLine + 999);
        const totalLines = Number((await client.query(`select count(*) as count from ${this.schema}.chunks where base_id=$1 and document_id=$2`, [id, docId()])).rows[0].count);
        const lines = (await client.query(`select ordinal as "lineNumber",content from ${this.schema}.chunks where base_id=$1 and document_id=$2 and ordinal between $3 and $4 order by ordinal`, [id, docId(), startLine, endLine])).rows;
        return { documentId: row.id, title: row.title, startLine, endLine: Math.min(endLine, totalLines), totalLines, lines };
      }
      if (operation === 'knowledge.searchDocuments') return this.search(client, id, String(access.base.revision), input);
      if (operation.startsWith('files.')) return this.files(client, id, operation, input, bump, upload);
      fail(400, 'Unknown knowledge operation.');
    });
    if (operation === 'files.deleteFile') await this.collectGarbage().catch(() => undefined);
    return result;
  }
  private objectPath(id: string, row: { id: string; sha256: string }) { return `knowledge-bases/${id}/${row.id}/${row.sha256}`; }
  private checkBinding(access: { base: any; binding?: KnowledgeBaseBinding }, id: string, consumer?: { binding: KnowledgeBaseBinding }) {
    if (access.base.id !== id || consumer && (['id', 'revision', 'knowledgeBaseId', 'mode', 'accessRevision'] as const).some(key => access.binding?.[key] !== consumer.binding[key])) fail(403, 'Knowledge binding or authorization changed.');
  }
  private async search(client: Client, id: string, revision: string, input: Record<string, any>) {
    const query = text(input.query, 'query', 4096), before = integer(input.beforeLines, 0, 0, 100), after = integer(input.afterLines, 0, 0, 100);
    const maxMatches = integer(input.maxMatches, 200, 1, 1000), size = integer(input.pageSize, maxMatches, 1, 1000);
    const documentId = input.documentId === undefined ? null : text(input.documentId, 'document ID');
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    const fingerprint = createHash('sha256').update(JSON.stringify([query, documentId, before, after, maxMatches, size])).digest('hex');
    const cursor = decode(input.cursor), offset = cursor ? integer(cursor.offset, 0, 0, maxMatches) : 0;
    if (cursor && (cursor.base !== id || cursor.fingerprint !== fingerprint || cursor.revision !== revision)) fail(409, 'Knowledge changed or the search cursor belongs to another query. Restart the search.');
    const counts = (await client.query(`select count(*)::int as total from ${this.schema}.chunks c where c.base_id=$1 and ($2::text is null or document_id=$2) and lower(content) like lower($3)`, [id, documentId, pattern])).rows[0];
    const documentsSearched = (await client.query(`select count(*)::int as count from ${this.schema}.documents where base_id=$1 and ($2::text is null or id=$2)`, [id, documentId])).rows[0].count;
    const limit = Math.min(size, Math.max(0, maxMatches - offset));
    const matches = (await client.query(`select c.document_id as "documentId",d.title,c.ordinal as "lineNumber",c.content as line,
      (select coalesce(json_agg(json_build_object('lineNumber',n.ordinal,'content',n.content) order by n.ordinal),'[]') from ${this.schema}.chunks n where n.base_id=c.base_id and n.document_id=c.document_id and n.ordinal between c.ordinal-$6 and c.ordinal-1) as before,
      (select coalesce(json_agg(json_build_object('lineNumber',n.ordinal,'content',n.content) order by n.ordinal),'[]') from ${this.schema}.chunks n where n.base_id=c.base_id and n.document_id=c.document_id and n.ordinal between c.ordinal+1 and c.ordinal+$7) as after
      from ${this.schema}.chunks c join ${this.schema}.documents d on d.base_id=c.base_id and d.id=c.document_id where c.base_id=$1 and ($2::text is null or c.document_id=$2) and lower(c.content) like lower($3) order by d.sequence desc,c.ordinal limit $4 offset $5`, [id, documentId, pattern, limit, offset, before, after])).rows;
    const hasMore = offset + matches.length < Math.min(maxMatches, counts.total);
    return { query, documentsSearched, totalMatches: counts.total, matchesTruncated: counts.total > maxMatches, maxMatches, pageSize: size, matches, hasMore,
      ...(input.cursor ? { cursor: input.cursor } : {}), ...(hasMore ? { nextCursor: encode({ base: id, fingerprint, revision, offset: offset + matches.length }) } : {}) };
  }
  private async files(client: Client, id: string, operation: string, input: Record<string, any>, bump: () => Promise<unknown>, upload?: any) {
    const view = (row: any): FileReference => ({ id: row.id, spaceId: id, storage: 'database', name: row.name, mimeType: row.mime_type, kind: row.kind, size: row.size, createdAt: row.created_at.toISOString() });
    const objectPath = (row: any) => `knowledge-bases/${id}/${row.id}/${row.sha256}`;
    if (operation === 'files.createFile') {
      const row = upload; if (!row) fail(503, 'Attachment upload is unavailable.');
      const { name, mime_type: mimeType, kind } = row;
      await client.query(`insert into ${this.schema}.attachments(base_id,id,name,mime_type,kind,size,sha256,created_at) values($1,$2,$3,$4,$5,$6,$7,$8)`, [id, row.id, name, mimeType, kind, row.size, row.sha256, row.created_at]);
      await client.query(`update ${this.schema}.objects set state='active' where path=$1`, [objectPath(row)]);
      await bump(); return view(row);
    }
    if (operation === 'files.list') {
      const page = integer(input.page, 1, 1, 1_000_000), pageSize = integer(input.pageSize, 20, 1, 100);
      const total = (await client.query(`select count(*)::int as total from ${this.schema}.attachments where base_id=$1`, [id])).rows[0].total;
      const rows = (await client.query(`select * from ${this.schema}.attachments where base_id=$1 order by created_at desc,id limit $2 offset $3`, [id, pageSize, (page - 1) * pageSize])).rows;
      return { items: rows.map(view), total, page, pageSize };
    }
    const fileId = uuid(input.fileId), row = (await client.query(`select * from ${this.schema}.attachments where base_id=$1 and id=$2`, [id, fileId])).rows[0];
    if (operation === 'files.deleteFile') { if (row) { await client.query(`delete from ${this.schema}.attachments where base_id=$1 and id=$2`, [id, fileId]); await client.query(`update ${this.schema}.objects set state='garbage' where path=$1`, [objectPath(row)]); await bump(); } return { deleted: !!row }; }
    if (!row) fail(404, 'Knowledge attachment is unavailable.');
    if (operation === 'files.stat') return view(row);
    const bytes = await this.objects.downloadPrivateBuffer(objectPath(row));
    if (bytes.length !== row.size || createHash('sha256').update(bytes).digest('hex') !== row.sha256) fail(503, 'Knowledge attachment content is damaged.');
    return { file: view(row), base64: bytes.toString('base64') };
  }
}
