import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolve } from 'import-meta-resolve';
import { fixtureDatabaseHost } from './approved-database-fixture.mjs';

export async function createKanbanTestServer() {
  const core=await import(resolve('steamharness',new URL('../examples/kanban/package.json',import.meta.url).href));
  const databases=fixtureDatabaseHost(core);let authenticatedRequests=0;
  const profile={userId:'kanban-user',email:'kanban@example.com',displayName:'Kanban Test'};
  const server=createServer(async(request,response)=>{
    response.setHeader('Content-Type','application/json');
    const success=data=>response.end(JSON.stringify({errCode:0,errMessage:'',data}));
    if(request.url==='/api/auth/login'){request.resume();success({authenticated:true,accessToken:'offline-kanban-identity',apiKey:{id:'kanban-key'}});return;}
    if(request.headers.authorization!=='Bearer offline-kanban-identity'){response.writeHead(401);response.end('{}');return;}
    authenticatedRequests++;
    if(request.url==='/api/auth/me'){success({profile,principal:{apiKeyId:'kanban-key',expiresAt:'2030-01-01T00:00:00Z'}});return;}
    if(request.url==='/api/ai/usage'){success({balance:10,groups:[]});return;}
    if(request.url==='/api/auth/logout'){request.resume();success({});return;}
    if(await databases.handle(request,response))return;
    response.writeHead(404);response.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {connection:{serverUrl:`http://127.0.0.1:${server.address().port}`,accessToken:'offline-kanban-identity'},profile,
    async registerProject(folder){
      const pkg=JSON.parse(await readFile(path.join(folder,'package.json'),'utf8'));
      const entry=pkg.steamHarness.entries[0];const approved=databases.create(pkg.id,entry.entryId,'data');
      entry.databases=[approved.requirement];await writeFile(path.join(folder,'package.json'),JSON.stringify(pkg));return approved.database;
    },
    get authenticatedRequests(){return authenticatedRequests;},
    close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));},
  };
}
