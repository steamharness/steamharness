export { Decimal, DbNull, JsonNull, AnyNull } from "./engine-browser";

/** Project-authored database definitions. Resource IDs and credentials belong to the host. */
export interface DatabaseDefinition {
  readonly schema: string;
}

export interface DatabaseDefinitions<Definitions extends Record<string, DatabaseDefinition> = Record<string, DatabaseDefinition>> {
  readonly kind: "steamharness.database.definitions";
  readonly version: 1;
  readonly databases: Readonly<Definitions>;
}

const reservedAliases = new Set(("await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield arguments eval constructor prototype databases").split(" "));

export class DatabaseDefinitionError extends Error {
  readonly code = "DATABASE_DEFINITION_INVALID";
  constructor(message: string) { super(message); this.name = "DatabaseDefinitionError"; }
}

export function assertDatabaseAlias(alias: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(alias) || reservedAliases.has(alias)) {
    throw new DatabaseDefinitionError(`Invalid database alias ${JSON.stringify(alias)}. Use 1–63 lowercase letters, digits or underscores, starting with a letter; reserved words are unavailable.`);
  }
}

/** A single database uses the entry-local alias `main`. */
export function defineDatabase<const Definition extends DatabaseDefinition>(definition: Definition): DatabaseDefinitions<{ main: Definition }> {
  return defineDatabases({ main: definition });
}

export function defineDatabases<const Definitions extends Record<string, DatabaseDefinition>>(definitions: Definitions): DatabaseDefinitions<Definitions> {
  if (!isRecord(definitions) || Object.keys(definitions).length === 0) throw new DatabaseDefinitionError("Define at least one database.");
  const databases: Record<string, DatabaseDefinition> = {};
  for (const [alias, definition] of Object.entries(definitions)) {
    assertDatabaseAlias(alias);
    if (!isRecord(definition) || Object.keys(definition).some(key => key !== "schema") || typeof definition.schema !== "string"
      || !definition.schema.endsWith("/steamharness.schema") && definition.schema !== "steamharness.schema"
      || definition.schema.includes("\\") || definition.schema.includes("\0") || definition.schema.startsWith("/") || /^[a-z]:/i.test(definition.schema)
      || definition.schema.split("/").some(part => part === ".." || part === "")) {
      throw new DatabaseDefinitionError(`Database ${JSON.stringify(alias)} must specify only a project-relative steamharness.schema path.`);
    }
    databases[alias] = Object.freeze({ schema: definition.schema });
  }
  return Object.freeze({ kind: "steamharness.database.definitions", version: 1, databases: Object.freeze(databases) }) as DatabaseDefinitions<Definitions>;
}

/** Validate the default export loaded by the local build tool. */
export function parseDatabaseDefinitions(value: unknown): DatabaseDefinitions {
  if (!isRecord(value) || value.kind !== "steamharness.database.definitions" || value.version !== 1
    || Object.keys(value).some(key => !["kind", "version", "databases"].includes(key))) {
    throw new DatabaseDefinitionError("steamharness.database.ts must default-export defineDatabase(...) or defineDatabases(...).");
  }
  return defineDatabases(value.databases as Record<string, DatabaseDefinition>);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export type DatabaseTarget = "node" | "browser";
export interface DatabaseFieldMetadata {
  readonly name: string;
  readonly column: string;
  readonly kind: "scalar" | "enum" | "object" | "unsupported";
  readonly type: string;
  readonly required: boolean;
  readonly list: boolean;
  readonly id: boolean;
  readonly unique: boolean;
  readonly relation?: { readonly name: string; readonly from: readonly string[]; readonly to: readonly string[] };
}
export interface DatabaseModelMetadata {
  readonly name: string;
  readonly delegate: string;
  readonly table: string;
  readonly fields: readonly DatabaseFieldMetadata[];
  readonly primaryKey: readonly string[];
  readonly uniqueKeys: readonly (readonly string[])[];
}
export interface DatabaseMetadata {
  readonly models: readonly DatabaseModelMetadata[];
  readonly enums: readonly { readonly name: string; readonly values: readonly string[] }[];
}

declare const databaseClientType: unique symbol;

/** A portable description, never a connection or a resource identity. */
export interface DatabaseDescriptor<Alias extends string = string, Client = unknown, Target extends DatabaseTarget = DatabaseTarget> {
  readonly kind: "steamharness.database";
  readonly version: 1;
  readonly alias: Alias;
  readonly target: Target;
  readonly provider: "postgresql";
  readonly schemaHash: string;
  readonly metadata: DatabaseMetadata;
  readonly [databaseClientType]?: Client;
}

/** Used by the trusted Node host when connections are enabled. Importing a descriptor is inert. */
export interface NodeDatabaseDescriptor<Alias extends string = string, Client = unknown> extends DatabaseDescriptor<Alias, Client, "node"> {
  readonly loadEngine: () => Promise<unknown>;
}

export type DatabaseClient<Descriptor extends DatabaseDescriptor> = NonNullable<Descriptor[typeof databaseClientType]>;
export type DatabaseOperation = "findUnique" | "findUniqueOrThrow" | "findFirst" | "findFirstOrThrow" | "findMany" | "count" | "aggregate" | "groupBy"
  | "create" | "createMany" | "createManyAndReturn" | "update" | "updateMany" | "updateManyAndReturn" | "upsert" | "delete" | "deleteMany";
export type DatabaseModelDelegate<Delegate> = Pick<Delegate, Extract<keyof Delegate, DatabaseOperation>>;
