import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

export async function createAssistantDependencyFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-assistant-runtime-'));
  const projectDir = path.join(root, 'build-in', 'build-in-developer-assistant');
  const cli = path.join(projectDir, 'node_modules/@steamharness/cli');
  const core = path.join(projectDir, 'node_modules/steamharness');
  await mkdir(path.join(cli, 'dist'), { recursive: true });
  await mkdir(path.join(core, 'dist'), { recursive: true });
  await writeFile(path.join(projectDir, 'package.json'), JSON.stringify({ id: 'a3aca697-b086-459b-84e4-d357ad2d9fb2', name: 'Independent assistant' }));
  await writeFile(path.join(cli, 'package.json'), JSON.stringify({ name: '@steamharness/cli', version: '1.2.3', type: 'module', bin: { 'steamharness': 'dist/index.js' } }));
  await writeFile(path.join(core, 'package.json'), JSON.stringify({ name: 'steamharness', version: '2.3.4' }));
  await writeFile(path.join(cli, 'dist/index.js'), `
    import { createServer } from 'node:http';
    import { createInterface } from 'node:readline';
    import { readFileSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    const recordDir=${JSON.stringify(projectDir)},harnessPath=${JSON.stringify(path.join(core, 'dist/index.js'))};
    const input=createInterface({input:process.stdin});let server;
    input.on('line',line=>{
      const message=JSON.parse(line);
      if(message.type==='configure'){
        const manifest=JSON.parse(readFileSync(path.join(message.assistantProjectDir,'package.json'),'utf8'));
        const project={id:manifest.id,name:'Project Assistant',folderPath:message.assistantProjectDir,projectType:'conversation',entryId:'main',entryName:'Main',defaultEntry:'main',entries:[{entryId:'main',name:'Main',type:'conversation',root:'.',entry:'index.ts',databases:[]}],databases:[],fields:[],entrypoints:[],tools:[{name:'skill'}]};
        if(process.argv.includes('--inspect')){
          if(manifest.testInspectionExit){console.error('Fixture inspection failed');process.exit(1);}
          const errors=manifest.testInspectionError?[manifest.testInspectionError]:[];
          console.log(JSON.stringify({assistantProtocolVersion:1,projects:errors.length?[]:[project],errors}));input.close();process.stdin.pause();return;
        }
        const controlUrl=process.env.STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL;
        const controlToken=process.env.STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN;
        const controlDefinition=process.env.STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER;
        const studioControl=controlDefinition?{mcpServer:JSON.parse(controlDefinition),bridgeUrl:controlUrl,hasToken:!!controlToken}:undefined;
        server=createServer(async (request,response)=>{
          if(request.url==='/studio-control-state'&&controlUrl&&controlToken){
            const state=await fetch(controlUrl,{method:'POST',headers:{Authorization:'Bearer '+controlToken,'Content-Type':'application/json'},body:JSON.stringify({operation:'studio.state.get',input:{}})});
            response.writeHead(state.status,{'Content-Type':'application/json'});response.end(await state.text());
          }else response.end('<html><body>Independent assistant</body></html>');
        });
        server.listen(0,'127.0.0.1',()=>{
          writeFileSync(path.join(recordDir,'assistant.pid'),String(process.pid));
          writeFileSync(path.join(recordDir,'assistant.json'),JSON.stringify({assistant:message.assistant,assistantProjectDir:message.assistantProjectDir,surface:message.surface,harnessPath,args:process.argv.slice(2),studioControl}));
          console.log(JSON.stringify({type:'ready',protocolVersion:1,hostProtocolVersion:1,accountProtocolVersion:1,assistantProtocolVersion:1,entriesProtocolVersion:1,databaseSpacesProtocolVersion:1,url:'http://127.0.0.1:'+server.address().port+'/entries/main/#session='+'a'.repeat(64),project,runtime:{harnessVersion:'2.3.4',harnessPath}}));
        });
      }else if(message.type==='close'){input.close();process.stdin.pause();server?.close();}
    });
    input.on('close',()=>{process.stdin.pause();server?.close();});
  `);
  return { root, projectDir, dispose: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}
