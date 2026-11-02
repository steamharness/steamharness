export interface HostDatabaseRequest { kind: 'host'; action: 'catalog' | 'bindings'; projectId?: string; entryId?: string }
export interface HostDatabaseCatalog { resources: { id: string; kind: 'databases' | 'knowledge-bases'; name: string }[]; bindings?: { alias: string; databaseId: string; projectId: string; entryId: string }[] }
