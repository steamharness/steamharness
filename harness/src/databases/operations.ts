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
    case 'knowledge.listDocuments': return database.knowledge.listDocuments(input);
    case 'knowledge.getDocument': return await database.knowledge.getDocument(String(input.documentId)) ?? null;
    case 'knowledge.createDocument': return database.knowledge.createDocument(input as any);
    case 'knowledge.editDocument': return database.knowledge.editDocument({id:String(input.documentId),title:input.title,markdown:input.markdown});
    case 'knowledge.deleteDocument': return database.knowledge.deleteDocument(String(input.documentId));
    case 'knowledge.searchDocuments': return database.knowledge.searchDocuments(input as any);
    case 'knowledge.readDocumentLines': return database.knowledge.readDocumentLines(input as any);
    case 'files.createFile': return database.knowledge.files.createFile({name:String(input.name),mimeType:input.mimeType,buffer:Buffer.from(String(input.base64),'base64')});
    case 'files.readFile': { const file=await database.knowledge.files.readFile(String(input.fileId)); return {file:file.toJSON(),base64:await file.readBase64()}; }
    case 'files.deleteFile': return database.knowledge.files.deleteFile(String(input.fileId));
    default: throw new Error('Unsupported database operation.');
  }
}
