import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolve } from 'import-meta-resolve';
import { runDatabaseHostRequest } from './database-host.mjs';

/** Inspect an explicit approved alias using exactly the runtime's data API. */
export async function runResourceRequest(request, core) {
  const input = request.input;
  if (!['kv','knowledge'].includes(input.kind) || !['list','get','save','delete'].includes(input.action)) throw new Error('Invalid resource operation.');
  const folder = await realpath(request.project.folderPath);
  const manifest = await core.readProjectManifestFromDirectory(folder);
  if (manifest.projectId !== request.project.id) throw new Error('The project identity changed.');
  const entry = core.selectProjectEntry(manifest, request.project.entryId);
  const requirement = entry.databases.find(item => item.alias === input.database);
  if (!requirement) throw new Error('Select a declared database alias.');
  let source, sources = [];
  const local = core.createLocalDatabaseResolver();
  const remote = request.connection && core.createRemoteDatabaseResolver({serverUrl:request.connection.serverUrl,token:request.connection.accessToken});
  const resolver = {resolve:async(requirement, consumer)=>await local.resolve(requirement,consumer)??remote?.resolve(requirement,consumer)};
  const database = core.createDatabasesContext({projectId:manifest.projectId,entryId:entry.entryId,requirements:entry.databases,resolver,conversationId:input.conversationId}).get(requirement.alias);
  try {
    source = (await database.getBinding()).space.host; sources = [source];
    if (input.source && input.source !== source) throw new Error('Database host mismatch.');
    if (input.kind==='kv') {
      if (input.action==='list') {
        const page = await database.listValues({...input,pageSize:30,scope:input.scope??'project'});
        return {...page,source,sources,items:page.items.map(item=>({...item,id:JSON.stringify([item.scope,item.conversationId??'',item.key]),title:item.key,preview:JSON.stringify(item.value)}))};
      }
      if (typeof input.key!=='string'||!input.key.trim()) throw new Error('A KV key is required.');
      const kv = input.scope==='conversation'?database.kv.conversation:database.kv;
      if(input.action==='delete') return {removed:await kv.deleteValue(input.key)};
      if(input.action==='save') await database.transaction(async()=>{
        if(input.create && await kv.getValue(input.key)!==undefined) throw new Error('This key already exists.');
        await kv.setValue(input.key,input.value);
      });
      const value = await kv.getValue(input.key);
      return value===undefined?null:{key:input.key,scope:input.scope??'project',conversationId:input.conversationId,value};
    }
    const knowledge=database.knowledge;
    if (input.action==='list') {
      const page = input.query?.trim()?await knowledge.searchDocuments({query:input.query,pageSize:30,cursor:input.cursor}):await knowledge.listDocuments({pageSize:30,cursor:input.cursor});
      if (input.query?.trim()) return {items:page.matches.map(match=>({...match,id:`${match.documentId}:${match.lineNumber}`,preview:match.line})),total:page.totalMatches,hasMore:page.hasMore,nextCursor:page.nextCursor,source,sources,search:true};
      return {...page,source,sources,items:page.items.map(item=>({...item,documentId:item.id,preview:item.markdownPreview}))};
    }
    if(input.action==='get') return await knowledge.getDocument(input.documentId)??null;
    if(input.action==='delete') return {removed:await knowledge.deleteDocument(input.documentId)};
    return input.create?knowledge.createDocument({title:input.title,markdown:input.markdown}):knowledge.editDocument({id:input.documentId,title:input.title,markdown:input.markdown});
  } catch(error) {throw Object.assign(error,{source,sources});}
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) { chunks.push(chunk); }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const write = process.stdout.write.bind(process.stdout);
  console.log = console.error;
  try {
    const core = await import(resolve('steamharness', pathToFileURL(path.join(request.project.folderPath, 'package.json')).href));
    const value = await (request.input.kind === 'host' ? runDatabaseHostRequest(request, core) : runResourceRequest(request, core));
    write(`${JSON.stringify({ value })}\n`);
  } catch (error) {
    const message = String(error.message).replaceAll(request.connection?.accessToken || '\0', '[redacted]');
    write(`${JSON.stringify({ error: message, status: error.status, source: error.source, sources: error.sources })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) { await main(); }
