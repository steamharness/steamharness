import type pg from 'pg';
import { DatabaseResourceError } from 'steamharness/database';
import { databaseModelMetadata } from './engine';

export interface TableDataRequest {
  operation: 'models' | 'rows' | 'insert' | 'update' | 'delete'; model?: string;
  page?: number; pageSize?: number; search?: string; where?: Record<string, unknown>;
  data?: Record<string, unknown>; key?: Record<string, unknown>; rowVersion?: string;
  schemaHash?: string;
}
const invalid = (message = 'Invalid table data request.'): never => { throw new DatabaseResourceError('DATABASE_INVALID_REQUEST', message); };
const q = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, fallback: number, max: number) => value === undefined ? fallback : Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max ? Number(value) : invalid();
type Field = Awaited<ReturnType<typeof databaseModelMetadata>>[number]['fields'][number];

/** JSON transport keeps large integers, decimals and byte arrays lossless. */
function inputValue(field: Field, value: unknown): unknown {
  if (value === undefined || value === null && field.required) return invalid(`Provide a value for ${field.name}.`);
  if (value === null) return null;
  if (field.list) {
    if (!Array.isArray(value) || value.length > 10_000) return invalid('List fields require a bounded array.');
    return value.map(item => inputValue({ ...field, list: false }, item));
  }
  if (field.type === 'Json') return JSON.stringify(value);
  if (field.type === 'Boolean') return typeof value === 'boolean' ? value : invalid('Boolean fields require true or false.');
  if (field.type === 'Int') return Number.isInteger(value) && Number(value) >= -2147483648 && Number(value) <= 2147483647 ? value : invalid('Int fields require a 32-bit integer.');
  if (field.type === 'Float') return typeof value === 'number' && Number.isFinite(value) ? value : invalid('Float fields require a finite number.');
  if (field.type === 'BigInt') return typeof value === 'string' && /^-?\d{1,20}$/.test(value) ? value : invalid('BigInt fields require a decimal string.');
  if (field.type === 'Decimal') return (typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value) || typeof value === 'number' && Number.isFinite(value)) ? String(value) : invalid('Decimal fields require a decimal string or number.');
  if (field.type === 'DateTime') return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value) : invalid('DateTime fields require an ISO date string.');
  if (field.type === 'Bytes') {
    if (typeof value !== 'string') return invalid('Bytes fields require base64.');
    const bytes = Buffer.from(value, 'base64');
    return bytes.toString('base64') === value ? bytes : invalid('Invalid Bytes encoding.');
  }
  return typeof value === 'string' && !value.includes('\0') ? value : invalid('String and enum fields require text.');
}
function outputValue(field: Field, value: unknown): unknown {
  if (value === null) return null;
  if (field.list) return (value as unknown[]).map(item => outputValue({ ...field, list: false }, item));
  if (field.type === 'BigInt' || field.type === 'Decimal') return String(value);
  if (field.type === 'Bytes') return (value as Buffer).toString('base64');
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** Bounded scalar CRUD using only names from the applied model, under a restricted SQL role. */
export async function executeTableData(client: pg.Client, schema: string, request: TableDataRequest) {
  const models = await databaseModelMetadata(schema);
  if (request.operation === 'models') return { models };
  const model = models.find(model => model.name === request.model);
  if (!model || !['rows', 'insert', 'update', 'delete'].includes(request.operation)) return invalid('Select a model from the applied schema.');
  const fields = new Map(model.fields.map(field => [field.name, field]));
  // Avoid reserving a user model field name for the transport's row version.
  let versionAlias = '__steamharness_row_version';
  while (fields.has(versionAlias)) versionAlias += '_';
  const columns = model.fields.map(field => `${q(field.column)}${['BigInt', 'Decimal'].includes(field.type) ? `::text${field.list ? '[]' : ''}` : ''} as ${q(field.name)}`).join(',');
  const table = `public.${q(model.table)}`;
  const values: unknown[] = [];
  const parameter = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const equality = (input: unknown, exactKeys?: readonly string[]) => {
    if (!record(input) || Object.keys(input).length > 100 || exactKeys && (Object.keys(input).length !== exactKeys.length || exactKeys.some(key => !Object.hasOwn(input, key)))) return invalid('Provide the complete row key.');
    return Object.entries(input).map(([name, value]) => {
      const field = fields.get(name);
      if (!field || record(value) || Array.isArray(value) || field.list) return invalid('Filters support scalar equality only.');
      return `${q(field.column)} is not distinct from ${parameter(value === null ? null : inputValue(field, value))}`;
    });
  };
  const row = (input: Record<string, unknown>) => ({ values: Object.fromEntries(model.fields.map(field => [field.name, outputValue(field, input[field.name])])), rowVersion: input[versionAlias] });
  const projection = `${columns},xmin::text as ${q(versionAlias)}`;
  if (request.operation === 'rows') {
    const page = integer(request.page, 1, 1_000_000), pageSize = integer(request.pageSize, 20, 100);
    const predicates = equality(request.where ?? {});
    if (request.search !== undefined) {
      if (typeof request.search !== 'string' || request.search.length > 500) return invalid();
      const needle = parameter(request.search);
      predicates.push('(' + model.fields.map(field => `strpos(lower(${q(field.column)}::text),lower(${needle}))>0`).join(' or ') + ')');
    }
    const where = predicates.length ? ` where ${predicates.join(' and ')}` : '';
    const total = Number((await client.query(`select count(*) as total from ${table}${where}`, values)).rows[0].total);
    const order = (model.keyFields.length ? model.keyFields : [model.fields[0].name]).map(name => q(fields.get(name)!.column)).join(',');
    const result = await client.query(`select ${projection} from ${table}${where} order by ${order} limit ${parameter(pageSize)} offset ${parameter((page - 1) * pageSize)}`, values);
    return { items: result.rows.map(row), total, page, pageSize };
  }
  if (!model.keyFields.length && request.operation !== 'insert') return invalid('This model has no stable scalar key for row mutations.');
  if (request.operation === 'delete' || request.operation === 'update') {
    const conditions = equality(request.key, model.keyFields);
    if (typeof request.rowVersion !== 'string' || !/^\d{1,20}$/.test(request.rowVersion)) return invalid('Read the current row version before changing it.');
    conditions.push(`xmin::text=${parameter(request.rowVersion)}`);
    if (request.operation === 'delete') {
      const deleted = await client.query(`delete from ${table} where ${conditions.join(' and ')} returning ${projection}`, values);
      if (!deleted.rowCount) throw new DatabaseResourceError('DATABASE_QUERY_FAILED', 'This row changed or was deleted. Reload before retrying.');
      return { deleted: true };
    }
    if (!record(request.data) || !Object.keys(request.data).length || Object.keys(request.data).length > 100) return invalid();
    const updates = Object.entries(request.data).map(([name, value]) => {
      const field = fields.get(name); if (!field || field.generated) return invalid('Only writable scalar model fields may be edited.');
      return `${q(field.column)}=${parameter(inputValue(field, value))}`;
    });
    for (const field of model.fields.filter(field => field.updatedAt && !Object.hasOwn(request.data!, field.name))) updates.push(`${q(field.column)}=${parameter(new Date())}`);
    const changed = await client.query(`update ${table} set ${updates.join(',')} where ${conditions.join(' and ')} returning ${projection}`, values);
    if (!changed.rowCount) throw new DatabaseResourceError('DATABASE_QUERY_FAILED', 'This row changed or was deleted. Reload before retrying.');
    return row(changed.rows[0]);
  }
  if (!record(request.data) || Object.keys(request.data).length > 100) return invalid();
  const data = { ...request.data };
  for (const field of model.fields.filter(field => field.updatedAt && !Object.hasOwn(data, field.name))) data[field.name] = new Date().toISOString();
  const entries = Object.entries(data);
  const names = entries.map(([name]) => { const field = fields.get(name); if (!field || field.generated) return invalid('Only writable scalar model fields may be inserted.'); return q(field.column); });
  const parameters = entries.map(([name, value]) => parameter(inputValue(fields.get(name)!, value)));
  const result = await client.query(`insert into ${table} ${entries.length ? '(' + names.join(',') + ') values(' + parameters.join(',') + ')' : 'default values'} returning ${projection}`, values);
  return row(result.rows[0]);
}
