import type { DatabaseContext } from './index';
/** Host data tools use the same authorization and transactions as project code. */
export async function executeDatabaseOperation(database: DatabaseContext, operation: string, input: Record<string, any>): Promise<unknown> {
  const kv = input.scope === 'conversation' ? database.kv.conversation : database.kv;
  switch (operation) {
    case 'kv.listValues': return database.listValues(input);
    case 'database.revision': return database.getRevision();
    case 'kv.getValue': return await kv.getValue(String(input.key)) ?? null;
    case 'kv.getEntry': { const value = await kv.getValue(String(input.key)); return { exists: value !== undefined, value }; }
    case 'kv.setValue':
      await database.transaction(async () => {
        if (input.create && await kv.getValue(String(input.key)) !== undefined) throw new Error('This key already exists.');
        await kv.setValue(String(input.key), input.value);
      });
      return null;
    case 'kv.deleteValue': return kv.deleteValue(String(input.key));
    default: throw new Error('Unsupported database operation.');
  }
}
