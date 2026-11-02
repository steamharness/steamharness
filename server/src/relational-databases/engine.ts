import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { bindMigrationAwareSqlAdapterFactory } from "@prisma/driver-adapter-utils";
import type * as EngineBindings from "@prisma/schema-engine-wasm/schema_engine_bg";
import { DatabaseResourceError } from "steamharness/database";
import type pg from "pg";
import { createPostgresPool } from "../postgres";
import { modelSchema } from "./schema";

const require = createRequire(import.meta.url);
const { getDMMF } = require("@prisma/internals") as typeof import("@prisma/internals");
let runtimePromise: Promise<typeof EngineBindings> | undefined;

async function runtime(): Promise<typeof EngineBindings> {
  // The pinned internals loader looks in its unpublished build/ directory. Load
  // the shipped WASM asset beside its own bindings, without binary downloads.
  return runtimePromise ??= (async () => {
    const bindings = await import(pathToFileURL(require.resolve("@prisma/schema-engine-wasm/schema_engine_bg")).href) as typeof EngineBindings;
    const bytes = await readFile(path.join(path.dirname(require.resolve("@prisma/schema-engine-wasm")), "schema_engine_bg.wasm"));
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { "./schema_engine_bg.js": bindings });
    bindings.__wbg_set_wasm(instance.exports);
    (instance.exports.__wbindgen_start as () => void)();
    return bindings;
  })();
}

export async function validateModel(source: string): Promise<void> {
  try {
    const dmmf = await getDMMF({ datamodel: modelSchema(source) });
    if (!dmmf.datamodel.models.length) throw new Error("Empty model.");
    if (dmmf.datamodel.models.some(model => model.name[0].toLowerCase() + model.name.slice(1) === "transaction")) throw new Error("Reserved model name.");
  } catch (error) {
    if (error instanceof DatabaseResourceError) throw error;
    throw new DatabaseResourceError("DATABASE_SCHEMA_INVALID", "Database models are invalid. Run steamharness database validate for authored diagnostics.");
  }
}

/** Compare only the managed public schema using a restricted database identity. */
export async function schemaDifference(connectionString: string, target?: string): Promise<string> {
  const pool = createPostgresPool({ connectionString, label: "database schema comparison", max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 120_000 });
  let engine: EngineBindings.SchemaEngine | undefined;
  try {
    const bindings = await runtime();
    const adapter = bindMigrationAwareSqlAdapterFactory(new PrismaPg(catalogPool(pool), { schema: "public" }));
    engine = await bindings.SchemaEngine.new({ datamodels: undefined }, () => undefined, adapter);
    const result = await engine.diff({
      from: { tag: "schemaDatasource", files: [{ path: "steamharness.schema", content: modelSchema("") }], configDir: process.cwd() },
      to: target === undefined ? { tag: "empty" } : { tag: "schemaDatamodel", files: [{ path: "steamharness.schema", content: modelSchema(target) }] },
      script: true, exitCode: false, filters: { externalTables: [], externalEnums: [] },
    });
    // Enum rewrites can include their own transaction wrapper. Every generated
    // statement is executed inside the runner's single recorded transaction.
    return (result.stdout ?? "").replace(/^\s*(?:BEGIN|COMMIT);\s*$/gim, "");
  } catch (error) {
    if (error instanceof DatabaseResourceError) throw error;
    // Connector exceptions may contain connection material. Keep those inside
    // the trusted process rather than returning or logging their raw text.
    throw new DatabaseResourceError("DATABASE_SCHEMA_INVALID", "Database schema comparison failed.");
  } finally { engine?.free(); await pool.end(); }
}

/**
 * The pinned pg adapter supports application CHAR(n), but not PostgreSQL's
 * internal one-byte "char" (OID 18), used by the engine's catalog queries.
 * Its values are strings, so expose that catalog result as TEXT to the adapter.
 * This wrapper is used only for schema comparison, never business queries.
 */
function catalogPool(pool: pg.Pool): pg.Pool {
  return new Proxy(pool, {
    get(target, property) {
      if (property === "query") return async (...args: unknown[]) => {
        const result = await Reflect.apply(target.query, target, args) as pg.QueryResult;
        for (const field of result.fields ?? []) if (field.dataTypeID === 18) field.dataTypeID = 25;
        return result;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function emptyDifference(sql: string): boolean {
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim() === "";
}

/** Metadata comes only from the applied, validated model; clients cannot nominate SQL identifiers. */
export async function databaseModelMetadata(source: string) {
  const { datamodel } = await getDMMF({ datamodel: modelSchema(source) });
  return datamodel.models.map(model => ({
    name: model.name, delegate: model.name[0].toLowerCase() + model.name.slice(1), table: model.dbName ?? model.name,
    fields: model.fields.filter(field => field.kind !== 'object').map(field => ({ name: field.name, column: field.dbName ?? field.name, type: field.type, required: field.isRequired, list: field.isList, generated: field.isGenerated, hasDefault: field.hasDefaultValue, updatedAt: field.isUpdatedAt, id: field.isId })),
    keyFields: model.primaryKey?.fields ?? (model.fields.some(field => field.isId) ? model.fields.filter(field => field.isId).map(field => field.name) : model.uniqueFields.find(fields => fields.every(name => model.fields.find(field => field.name === name)?.isRequired)) ?? model.fields.filter(field => field.isUnique && field.isRequired).slice(0, 1).map(field => field.name)),
  }));
}
