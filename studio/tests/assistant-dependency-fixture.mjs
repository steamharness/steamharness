import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
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
  await writeFile(path.join(projectDir, 'steamharness.json'), JSON.stringify({ id: 'a3aca697-b086-459b-84e4-d357ad2d9fb2', name: 'Independent assistant' }));
  await writeProjectFixture(path.join(cli, 'package.json'), JSON.stringify({ name: '@steamharness/cli', version: '1.2.3', type: 'module', bin: { 'steamharness': 'dist/index.js' } }));
  await writeProjectFixture(path.join(core, 'package.json'), JSON.stringify({ name: 'steamharness', version: '2.3.4' }));
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
        const projectDirectory=message.assistantProjectDir??process.argv[process.argv.indexOf('web')+1];
        const manifest=JSON.parse(readFileSync(path.join(projectDirectory,'steamharness.json'),'utf8'));
        const baseProject={id:manifest.id,name:'Project Assistant',folderPath:message.assistantProjectDir,projectType:'conversation',entryId:'main',entryName:'Main',defaultEntry:'main',entries:[{entryId:'main',name:'Main',type:'conversation',root:'.',entry:'index.ts',databases:[]}],databases:[],fields:[],entrypoints:[],tools:[{name:'skill'}]};
        const entries=(manifest?.entries??baseProject.entries).map(entry=>entry.root==='.'?entry:{...JSON.parse(readFileSync(path.join(projectDirectory,entry.root,'steamharness.json'),'utf8')),...entry});
        const projects=entries.map(entry=>({...baseProject,folderPath:projectDirectory,entries,entryId:entry.entryId,entryName:entry.name,projectType:entry.type,entrypoints:entry.type==='workflow'?[{id:'studio_state',title:'Studio state',fields:[]}]:[]}));
        const selected=process.argv.includes('--entry')?process.argv[process.argv.indexOf('--entry')+1]:manifest?.defaultEntry??'main';
        const project=projects.find(entry=>entry.entryId===selected);
        if(process.argv.includes('--inspect')){
          if(JSON.parse(readFileSync(path.join(projectDirectory,'package.json'),'utf8')).testInspectionExit){console.error('Fixture inspection failed');process.exit(1);}
          const diagnostic=JSON.parse(readFileSync(path.join(projectDirectory,'package.json'),'utf8')).testInspectionError;
          const errors=diagnostic?[diagnostic]:[];
          console.log(JSON.stringify({assistantProtocolVersion:1,projects:errors.length?[]:projects,errors}));input.close();process.stdin.pause();return;
        }
        const controlUrl=process.env.STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL;
        const controlToken=process.env.STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN;
        const controlDefinition=process.env.STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER;
        const studioControl=controlUrl?{...(controlDefinition?{mcpServer:JSON.parse(controlDefinition)}:{}),bridgeUrl:controlUrl,hasToken:!!controlToken}:undefined;
        server=createServer(async (request,response)=>{
          if(request.url==='/studio-control-state'&&controlUrl&&controlToken){
            const state=await fetch(controlUrl,{method:'POST',headers:{Authorization:'Bearer '+controlToken,'Content-Type':'application/json'},body:JSON.stringify({operation:'studio.state.get',input:{}})});
            response.writeHead(state.status,{'Content-Type':'application/json'});response.end(await state.text());
          }else response.end('<html><body>Independent assistant</body></html>');
        });
        server.listen(0,'127.0.0.1',()=>{
          writeFileSync(path.join(recordDir,'assistant.pid'),String(process.pid));
          writeFileSync(path.join(recordDir,'assistant.json'),JSON.stringify({assistant:message.assistant,assistantProjectDir:message.assistantProjectDir,surface:message.surface,harnessPath,args:process.argv.slice(2),studioControl}));
          console.log(JSON.stringify({type:'ready',protocolVersion:1,hostProtocolVersion:1,accountProtocolVersion:1,assistantProtocolVersion:1,entriesProtocolVersion:1,databaseSpacesProtocolVersion:1,url:'http://127.0.0.1:'+server.address().port+'/entries/'+selected+'/#session='+'a'.repeat(64),project,runtime:{harnessVersion:'2.3.4',harnessPath}}));
        });
      }else if(message.type==='close'){input.close();process.stdin.pause();server?.close();}
    });
    input.on('close',()=>{process.stdin.pause();server?.close();});
  `);
  return { root, projectDir, dispose: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}
