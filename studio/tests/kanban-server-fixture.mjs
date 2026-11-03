import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { fixtureDatabaseHost } from './approved-database-fixture.mjs';

export async function createKanbanTestServer() {
  const databases=fixtureDatabaseHost();let authenticatedRequests=0;
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
      const pkg=JSON.parse(await readFile(path.join(folder,'steamharness.json'),'utf8'));
      const cliEntry = process.env.STEAMHARNESS_UI_CLI_ENTRY ?? path.join(folder, 'node_modules/@steamharness/cli/dist/index.js');
      await promisify(execFile)(process.execPath, [cliEntry, 'database', 'generate', folder]);
      await promisify(execFile)(process.execPath, ['build.mjs'], { cwd: folder });
      const { data } = await import(pathToFileURL(path.join(folder, '.steamharness/generated/database/browser/index.js')).href);
      const entry=pkg.entries.find(entry => entry.entryId === pkg.defaultEntry);
      const approved=databases.create(pkg.id,entry.entryId,'data',{schemaHash:data.schemaHash});
      entry.databases=['data']; databases.registerProject(pkg);
      await writeFile(path.join(folder,'steamharness.json'),JSON.stringify(pkg));
      approved.database.seed([
        { id:'requirements',title:'确认需求',description:'明确交付范围',status:'todo',priority:'high',label:'design' },
        { id:'implementation',title:'实现看板交互',description:'管理任务',status:'doing',priority:'normal',label:'development' },
        { id:'verification',title:'完成验收',description:'验证功能',status:'done',priority:'normal',label:'test' },
      ]);
      return approved.database;
    },
    get authenticatedRequests(){return authenticatedRequests;},
    close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));},
  };
}
