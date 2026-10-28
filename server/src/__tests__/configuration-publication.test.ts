import {resolveResourceAccess} from "@steamharness/project-access";
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {Storage} from '../storage';
import {configurationSnapshot,type ConfigurationProfilePolicy,type ProjectConfigurationState,type ProjectConfigurationField} from '@steamharness/project-configuration';
const projectId='00000000-0000-4000-8000-000000000094';
const pkg=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'));
test('role profiles filter guest responses and exports and enforce writes in the storage service',async()=>{
  const {root,storage,options}=await fixture([
    {name:'mode',type:'string',sharing:{publish:true,includeValue:true,editable:false}},
    {name:'model',type:'string'},
  ],{version:1,defaultProfileKey:'ask',manageMinimumRole:'developer',profiles:[
    {key:'ask',name:'Ask',minimumRole:'guest',fixedValues:{mode:'ask'}},
    {key:'build',name:'Build',minimumRole:'developer',fixedValues:{mode:'build'}},
  ]});
  try{
    await assert.rejects(storage.projectConfigurations({...options,actorId:'developer'},{action:'get'}),/Publish the project configuration template/);
    const author=await storage.projectConfigurations(options,{action:'get'}) as ProjectConfigurationState;
    assert.deepEqual(author.configurations.map(profile=>profile.profileKey),['ask','build']);
    await storage.projectConfigurations(options,{action:'publication.save',revision:author.revision,publication:author.publication});
    await storage.publish({projectName:projectId,createdByUserId:'author',expectedConfigurationRevisions:{main:1},expectedSourceHash:author.sourceHash});
    const guestOptions={...options,actorId:'downloader',target:'1.0.0'};
    let guest=await storage.projectConfigurations(guestOptions,{action:'get'}) as ProjectConfigurationState;
    assert.deepEqual(guest.configurations.map(profile=>profile.profileKey),['ask']);
    assert.equal(guest.capabilities?.manageConfigurations,false);
    assert.ok(!JSON.stringify(guest).includes('"mode":"build"'));
    const originalRevision=guest.revision;
    for(const action of ['create','duplicate','rename','delete','field.save'] as const)await assert.rejects(storage.projectConfigurations(guestOptions,{action,id:guest.activeConfigurationId,revision:originalRevision,name:'Build'}),/Developer access/);
    await assert.rejects(storage.projectConfigurations(guestOptions,{action:'save',id:guest.activeConfigurationId,revision:originalRevision,values:{mode:'build',model:'must-not-save'}}),/fixes/);
    guest=await storage.projectConfigurations(guestOptions,{action:'get'}) as ProjectConfigurationState;
    assert.equal(guest.revision,originalRevision);
    assert.equal(configurationSnapshot(guest).values.model,undefined);
    guest=await storage.projectConfigurations(guestOptions,{action:'save',id:guest.activeConfigurationId,revision:guest.revision,values:{model:'guest-model'}}) as ProjectConfigurationState;
    assert.equal(configurationSnapshot(guest).values.model,'guest-model');
    const exported=await storage.projectConfigurations(guestOptions,{action:'export'});
    assert.ok(!JSON.stringify(exported).includes('"mode":"build"'));
    const devOptions={...guestOptions,actorId:'developer'};
    let developer=await storage.projectConfigurations(devOptions,{action:'get'}) as ProjectConfigurationState;
    const build=developer.configurations.find(profile=>profile.profileKey==='build')!;
    developer=await storage.projectConfigurations(devOptions,{action:'select',revision:developer.revision,id:build.id}) as ProjectConfigurationState;
    assert.equal(configurationSnapshot(developer).values.mode,'build');
    assert.equal(configurationSnapshot(developer).values.model,undefined);
    const defaultDeveloper=await storage.projectConfigurations({...devOptions,target:undefined},{action:'get'}) as ProjectConfigurationState;
    assert.deepEqual(defaultDeveloper.configurations.map(profile=>profile.profileKey),['ask','build']);
  }finally{await rm(root,{recursive:true,force:true});}
});
async function fixture(fields:ProjectConfigurationField[],profilePolicy?:ConfigurationProfilePolicy) {
  const root=await mkdtemp(path.join(tmpdir(),'configuration-publication-'));
  const storage=new Storage({serverRoot:process.cwd(),repoRoot:process.cwd(),dataRoot:root});
  const prepared=await storage.createProjectFromFiles({projectName:projectId,files:[
    {path:'package.json',content:JSON.stringify({id:projectId,name:'Config test',version:'1.0.0',devDependencies:{steamharness:pkg.dependencies.steamharness},steamHarness:{defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:'workflow',root:".",entry:"index.ts",configuration:"configuration.json",databases:[]}],projectInfo:{localizedNames:{},declarations:[],platformSupport:{mode:'agnostic'},}}})},
    {path:'index.ts',content:'throw new Error("Server must never execute source");'},
    {path:'configuration.json',content:JSON.stringify({version:2,fields,...(profilePolicy?{profilePolicy}:{})})},
  ]});
  storage.getProjectAccessSummary=async(_id,userId)=>({projectId,projectName:"Config test",visibility:"private",access:resolveResourceAccess([{type:"project",id:projectId,role:userId==="author"?"owner":userId==="downloader"?"guest":"developer"}])});
  const options={projectName:projectId,actorId:'author'};
  return {root,storage,options,prepared};
}
test('published personal configurations do not require a draft for any project role', async () => {
  const { root, storage, options } = await fixture([{ name: 'endpoint', type: 'string' }]);
  try {
    const author = await storage.projectConfigurations(options, { action: 'get' }) as ProjectConfigurationState;
    await storage.projectConfigurations(options, { action: 'publication.save', revision: author.revision, publication: author.publication! });
    await storage.publish({ projectName: projectId, createdByUserId: 'author', expectedConfigurationRevisions:{main:1}, expectedSourceHash: author.sourceHash });
    await rm(path.join(root, 'projects', projectId, 'draft'), { recursive: true, force: true });
    for (const actorId of ['author', 'developer', 'downloader']) {
      const published = { projectName: projectId, actorId, target: '1.0.0' };
      const state = await storage.projectConfigurations(published, { action: 'get' }) as ProjectConfigurationState;
      assert.equal(state.publicationRevision, undefined);
      const saved = await storage.projectConfigurations(published, {
        action: 'save', revision: state.revision, id: state.activeConfigurationId, values: { endpoint: `${actorId}.test` },
      }) as ProjectConfigurationState;
      assert.equal(configurationSnapshot(saved).values.endpoint, `${actorId}.test`);
      await storage.projectConfigurations(published, { action: 'export' });
    }
    await assert.rejects(storage.projectConfigurations({ ...options, target: 'draft' }, { action: 'get' }), /no draft/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('official templates filter source, lock JSON edits, isolate accounts and reject stale drafts',async()=>{
  const {root,storage,options,prepared}=await fixture([
    {name:'private',type:'string',defaultValue:'PRIVATE-MUST-NOT-SHIP',sharing:{publish:false,includeValue:true}},
    {name:'own',type:'string',defaultValue:'AUTHOR-TOKEN-MUST-NOT-SHIP'},
    {name:'settings',type:'json',defaultValue:{locked:0,open:false},sharing:{includeValue:true},paths:{'/locked':{editable:false}}},
  ]);
  try {
    const author=await storage.projectConfigurations(options,{action:'get'}) as ProjectConfigurationState;
    assert.equal(author.canManagePublication,true);
    const draft=author.publication!;
    const attempts=await Promise.allSettled([1,2].map(()=>storage.projectConfigurations(options,{action:'publication.save',revision:author.revision,publication:draft})));
    assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
    await assert.rejects(storage.projectConfigurations({...options,actorId:'downloader',administrator:false},{action:'publication.save',revision:0,publication:draft}),/Maintainer/);
    await assert.rejects(storage.publish({projectName:projectId,createdByUserId:'author',expectedSourceHash:prepared.sourceHash,expectedConfigurationRevisions:{main:0}}),/revision/);
    await storage.publish({projectName:projectId,createdByUserId:'author',expectedSourceHash:prepared.sourceHash,expectedConfigurationRevisions:{main:1}});
    const distributed=await storage.getFiles({projectName:projectId,target:'1.0.0',includeBinary:true});
    const text=JSON.stringify(distributed.files);
    assert.ok(!text.includes('PRIVATE-MUST-NOT-SHIP'));assert.ok(!text.includes('AUTHOR-TOKEN-MUST-NOT-SHIP'));
    const recipientOptions={...options,actorId:'downloader',target:'1.0.0'};
    const recipient=await storage.projectConfigurations(recipientOptions,{action:'get'}) as ProjectConfigurationState;
    assert.equal(recipient.canManagePublication,false);assert.ok(!recipient.fields.some(f=>f.name==='private'));
    await assert.rejects(storage.uploadConfigurationFile({...recipientOptions,key:'private',name:'hidden.png',mimeType:'image/png',buffer:Buffer.from('hidden'),field:{name:'private',type:'file'}}),/author field/);
    assert.deepEqual(configurationSnapshot(recipient,undefined,false).values,{settings:{locked:0,open:false}});
    await assert.rejects(storage.projectConfigurations(recipientOptions,{action:'save',revision:recipient.revision,id:recipient.activeConfigurationId,values:{settings:{open:true}}}),/locked/);
    const unchanged=await storage.projectConfigurations(recipientOptions,{action:'get'}) as ProjectConfigurationState;
    assert.equal(unchanged.revision,recipient.revision);
    const next=await storage.projectConfigurations(recipientOptions,{action:'save',revision:recipient.revision,id:recipient.activeConfigurationId,values:{own:'user-token',settings:{locked:0,open:true}}}) as ProjectConfigurationState;
    assert.equal(configurationSnapshot(next).values.own,'user-token');
    const other=await storage.projectConfigurations({...recipientOptions,actorId:'other'},{action:'get'}) as ProjectConfigurationState;
    assert.ok(!Object.hasOwn(configurationSnapshot(other,undefined,false).values,'own'));
    await assert.rejects(storage.projectConfigurations({...options,actorId:'manager'},{action:'publication.save',revision:author.revision,publication:{...draft,revision:1}}),/Maintainer/);
  } finally {await rm(root,{recursive:true,force:true});}
});
test('publication freezes only included attachments and preserves bytes after original deletion',async()=>{
  const {root,storage,options}=await fixture([{name:'image',type:'file',sharing:{includeValue:true,editable:false}},{name:'hidden',type:'file',sharing:{publish:false,includeValue:true}}]);
  try {
    const refs=await storage.saveManagedFiles({projectName:projectId,entryId:'main',files:[{name:'included.png',mimeType:'image/png',buffer:Buffer.from('included')},{name:'hidden.png',mimeType:'image/png',buffer:Buffer.from('hidden')}]});
    let author=await storage.projectConfigurations(options,{action:'get'}) as ProjectConfigurationState;
    author=await storage.projectConfigurations(options,{action:'save',revision:author.revision,id:author.activeConfigurationId,values:JSON.parse(JSON.stringify({image:refs[0],hidden:refs[1]}))}) as ProjectConfigurationState;
    await storage.projectConfigurations(options,{action:'publication.save',revision:author.revision,publication:author.publication});
    await storage.publish({projectName:projectId,createdByUserId:'author',expectedConfigurationRevisions:{main:1},expectedSourceHash:author.sourceHash});
    const template=(await storage.configurationTemplate(projectId,'1.0.0'))!;
    assert.equal(template.attachments?.length,1);
    assert.ok(!JSON.stringify(template).includes(refs[1]!.id));
    await storage.deleteManagedFile(refs[0]!.id);
    const file=await storage.configurationAttachment({projectName:projectId,actorId:'downloader',target:'1.0.0'},template.attachments![0]!.id);
    assert.equal((await readFile(file.filePath)).toString(),'included');
    await assert.rejects(storage.uploadConfigurationFile({projectName:projectId,actorId:'downloader',target:'1.0.0',key:'image',name:'new.png',mimeType:'image/png',buffer:Buffer.from('new')}),/locked/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('configuration file upload permissions follow the selected published version',async()=>{
 const {root,storage,options}=await fixture([{name:'image',type:'file'}]);
 try {
  let author=await storage.projectConfigurations(options,{action:'get'}) as ProjectConfigurationState;
  await storage.projectConfigurations(options,{action:'publication.save',revision:author.revision,publication:author.publication});
  await storage.publish({projectName:projectId,createdByUserId:'author',expectedConfigurationRevisions:{main:1},expectedSourceHash:author.sourceHash});
  const source=await storage.getFiles({projectName:projectId,target:'draft'});
  await storage.saveDraftFiles({projectName:projectId,files:source.files.filter(file=>file.path==='package.json').map(file=>({...file,content:JSON.stringify({...JSON.parse(file.content!),version:'2.0.0'})}))});
  author=await storage.projectConfigurations(options,{action:'get'}) as ProjectConfigurationState;
  const publication=structuredClone(author.publication!);publication.fields[0]!.sharing={editable:false};
  await storage.projectConfigurations(options,{action:'publication.save',revision:author.revision,publication});
  await storage.publish({projectName:projectId,createdByUserId:'author',expectedConfigurationRevisions:{main:2},expectedSourceHash:author.sourceHash});
  const upload={projectName:projectId,actorId:'downloader',key:'image',name:'mine.png',mimeType:'image/png',buffer:Buffer.from('mine')};
  await assert.rejects(storage.uploadConfigurationFile({...upload,target:'2.0.0'}),/locked/);
  const refs=await storage.uploadConfigurationFile({...upload,target:'1.0.0'});
  assert.equal(refs.length,1);assert.equal(refs[0]!.name,'mine.png');
  await assert.rejects(storage.uploadConfigurationFile(upload),/locked/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('personal configuration uploads remain account isolated through generic file and import paths',async()=>{
 const {root,storage,options}=await fixture([{name:'image',type:'file'}]);
 try {
  const ref=(await storage.uploadConfigurationFile({...options,name:'mine.png',mimeType:'image/png',key:'image',buffer:Buffer.from('mine')}))[0]!;
  await storage.assertManagedFileAccountAccess(ref.id,'author');
  await assert.rejects(storage.assertManagedFileAccountAccess(ref.id,'other'),/does not exist/);
  await assert.rejects(storage.configurationAttachment({...options,actorId:'other'},ref.id),/does not exist/);
  const other=await storage.projectConfigurations({...options,actorId:'other'},{action:'get'}) as ProjectConfigurationState;
  await assert.rejects(storage.projectConfigurations({...options,actorId:'other'},{action:'import',revision:other.revision,document:{version:1,kind:'steamharness-project-configurations',fields:[{name:'customImage',type:'file'}],configurations:[{name:'Injected',values:{customImage:JSON.parse(JSON.stringify(ref))}}]}}),/not available/);
  assert.equal((await storage.projectConfigurations({...options,actorId:'other'},{action:'get'}) as ProjectConfigurationState).revision,other.revision);
  await assert.rejects(storage.uploadConfigurationFile({...options,name:'bad.png',mimeType:'image/png',key:'new',buffer:Buffer.from('bad'),field:{name:'new',type:'invalid'}}),error=>(error as {statusCode:number}).statusCode===400);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('file defaults cannot import or publish another account attachment',async()=>{
 const {root,storage,options}=await fixture([{name:'image',type:'file'}]);
 try {
  const ref=JSON.parse(JSON.stringify((await storage.uploadConfigurationFile({...options,actorId:'other',field:{name:'image',type:'file'},name:'personal.png',mimeType:'image/png',key:'image',buffer:Buffer.from('private')}))[0]));
  const author=await storage.projectConfigurations(options,{action:'get'}) as ProjectConfigurationState;
  const field:ProjectConfigurationField={name:'image',type:'file',defaultValue:ref,sharing:{includeValue:true}};
  await assert.rejects(storage.projectConfigurations(options,{action:'import',revision:author.revision,document:{version:1,kind:'steamharness-project-configurations',fields:[{...field,name:'customImage'}],configurations:[{name:'Default injection',values:{}}]}}),/not available/);
  await assert.rejects(storage.projectConfigurations(options,{action:'publication.save',revision:author.revision,publication:{...author.publication!,fields:[field],configurations:author.publication!.configurations.map(profile=>({...profile,values:{}}))}}),/not available/);
  assert.equal((await storage.projectConfigurations(options,{action:'get'}) as ProjectConfigurationState).revision,author.revision);
  await storage.saveDraftFiles({projectName:projectId,files:[{path:'configuration.json',content:JSON.stringify({version:2,fields:[field]})}]});
  await assert.rejects(storage.publish({projectName:projectId,createdByUserId:'author'}),/attachment does not exist/);
  assert.deepEqual((await storage.listVersions(projectId)).versions,[]);
 }finally{await rm(root,{recursive:true,force:true});}
});

for(const publisher of ['author','administrator'])test(`${publisher} publishes administrator drafts using the actual source account, ignoring forged identity`,async()=>{
 const {root,storage}=await fixture([{name:'fixed',type:'number',defaultValue:0,sharing:{includeValue:true,editable:false}}]);
 try {
  const options={projectName:projectId,actorId:'administrator',administrator:true};
  let state=await storage.projectConfigurations(options,{action:'get'}) as ProjectConfigurationState;
  state=await storage.projectConfigurations(options,{action:'save',revision:state.revision,id:state.activeConfigurationId,values:{fixed:7}}) as ProjectConfigurationState;
  state=await storage.projectConfigurations(options,{action:'publication.save',revision:state.revision,publication:{...state.publication!,configurationAccountId:'forged-account'}}) as ProjectConfigurationState;
  assert.equal(state.publication!.configurationAccountId,'administrator');
  await storage.publish({projectName:projectId,createdByUserId:publisher,administrator:publisher==='administrator',expectedConfigurationRevisions:{main:state.publication!.revision},expectedSourceHash:state.sourceHash});
  const recipient=await storage.projectConfigurations({projectName:projectId,actorId:'recipient',target:'1.0.0'},{action:'get'}) as ProjectConfigurationState;
  assert.equal(configurationSnapshot(recipient).values.fixed,7);
  assert.ok(!JSON.stringify(recipient.template).includes('configurationAccountId'));
 }finally{await rm(root,{recursive:true,force:true});}
});
