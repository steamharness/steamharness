import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveResourceAccess } from '@steamharness/project-access';
import { AGENT_MODELS_CONFIGURATION_FIELD, AGENT_MODELS_CONFIGURATION_KEY as key, configurationSnapshot, type ProjectConfigurationState, type ProjectConfigurationExport } from '@steamharness/project-configuration';
import { Storage } from '../storage';
const corePackage = JSON.parse(await readFile(new URL('../../node_modules/steamharness/package.json', import.meta.url), 'utf8'));
const projectId = '00000000-0000-4000-8000-000000000095';
for (const mode of ['stale-draft', 'client-override', 'private-field'] as const) {
  test(`Server cannot relax source AI policy through ${mode}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'server-source-ai-policy-'));
    try {
      const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot: root });
      const definition = (restricted: boolean) => JSON.stringify({ version: 2, fields: [{ ...AGENT_MODELS_CONFIGURATION_FIELD, ...(restricted ? { allowThirdParty: false } : {}) }] });
      await storage.createProjectFromFiles({ projectName: projectId, files: [
        { path: 'package.json', content: JSON.stringify({ id: projectId, name: 'Source policy', version: '1.0.0', devDependencies: { steamharness: corePackage.version }, steamHarness: { defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:'conversation',root:".",entry:"index.ts",configuration:"configuration.json",databases:[]}], projectInfo: { localizedNames: {}, declarations: [], platformSupport: { mode: 'agnostic' },   } } }) },
        { path: 'index.ts', content: 'throw new Error("must not execute"); steamharness.createAgentProjectParamResolver();' },
        { path: 'configuration.json', content: definition(mode !== 'stale-draft') },
      ] });
      storage.getProjectAccessSummary = async (_id, actorId) => ({ projectId, projectName: 'Source policy', visibility: 'private', access: resolveResourceAccess([{ type: 'project', id: projectId, role: actorId === 'author' ? 'owner' : 'developer' }]) });
      const options = { projectName: projectId, actorId: 'author' };
      let state = await storage.projectConfigurations(options, { action: 'get' }) as ProjectConfigurationState;
      if (mode === 'stale-draft') {
        state = await storage.projectConfigurations(options, { action: 'publication.save', revision: state.revision, publication: state.publication }) as ProjectConfigurationState;
        await storage.saveDraftFiles({ projectName: projectId, files: [{ path: 'configuration.json', content: definition(true) }] });
        state = await storage.projectConfigurations(options, { action: 'get' }) as ProjectConfigurationState;
        assert.equal(state.publication!.fields[0]!.allowThirdParty, false);
      }
      const publication = structuredClone(state.publication!);
      if (mode === 'client-override') publication.fields[0]!.allowThirdParty = true;
      if (mode === 'private-field') publication.fields[0]!.sharing = { publish: false };
      state = await storage.projectConfigurations(options, { action: 'publication.save', revision: state.revision, publication }) as ProjectConfigurationState;
      assert.equal(state.publication!.fields[0]!.allowThirdParty, false);
      await storage.publish({ projectName: projectId, createdByUserId: 'author', expectedConfigurationRevisions:{main:state.publication!.revision}, expectedSourceHash: state.sourceHash });
      const recipient = await storage.projectConfigurations({ ...options, actorId: 'other', target: '1.0.0' }, { action: 'get' }) as ProjectConfigurationState;
      assert.deepEqual(configurationSnapshot(recipient).agentModelPolicy, { allowThirdParty: false });
      if (mode === 'private-field') assert.ok(!recipient.fields.some(field => field.name === key));
      else {
        assert.equal(recipient.fields[0]!.allowThirdParty, false);
        const third = { id: 'third', name: 'Custom', source: 'third-party', model: 'custom', apiKind: 'openai-responses', baseUrl: 'https://models.example/v1', apiKey: 'test-only-key' };
        await assert.rejects(storage.projectConfigurations({ ...options, actorId: 'other', target: '1.0.0' }, { action: 'save', revision: recipient.revision, id: recipient.activeConfigurationId, values: { [key]: [third] } }), /only allows system AI/);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
test('Server saves, imports and published configurations retain a source-declared system-only AI policy', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'server-system-only-'));
  try {
    const storage=new Storage({serverRoot:process.cwd(),repoRoot:process.cwd(),dataRoot:root});
    await storage.createProjectFromFiles({projectName:projectId,files:[
      {path:'package.json',content:JSON.stringify({id:projectId,name:'System Agent',version:'1.0.0',devDependencies:{steamharness:corePackage.version},steamHarness:{defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:'conversation',root:".",entry:"index.ts",configuration:"configuration.json",databases:[]}],projectInfo:{localizedNames:{},declarations:[],platformSupport:{mode:'agnostic'},}}})},
      {path:'index.ts',content:'throw new Error("must not execute"); steamharness.createAgentProjectParamResolver();'},
      {path:'configuration.json',content:JSON.stringify({version:2,fields:[{...AGENT_MODELS_CONFIGURATION_FIELD,allowThirdParty:false},{name:'title',type:'string'}]})},
    ]});
    storage.getProjectAccessSummary=async (_id,actorId)=>({projectId,projectName:'System Agent',visibility:'private',access:resolveResourceAccess([{type:'project',id:projectId,role:actorId==='author'?'owner':'developer'}])});
    const options={projectName:projectId,actorId:'author'};
    const state=await storage.projectConfigurations(options,{action:'get'}) as ProjectConfigurationState;
    assert.equal(state.fields[0]!.allowThirdParty,false);
    const third={id:'third',name:'Custom',source:'third-party',model:'custom',apiKind:'openai-responses',baseUrl:'https://models.example/v1',apiKey:'test-only-key'};
    await assert.rejects(storage.projectConfigurations(options,{action:'save',revision:state.revision,id:state.activeConfigurationId,values:{title:'Must not save',[key]:[third]}}),/only allows system AI/);
    const document=await storage.projectConfigurations(options,{action:'export'}) as ProjectConfigurationExport;
    document.fields[0]!.allowThirdParty=true;document.configurations[0]!.values[key]=[third];
    await assert.rejects(storage.projectConfigurations(options,{action:'import',revision:state.revision,document}),/only allows system AI/);
    const unchanged=await storage.projectConfigurations(options,{action:'get'}) as ProjectConfigurationState;
    assert.equal(unchanged.revision,state.revision);assert.equal(unchanged.configurations.length,1);assert.equal(configurationSnapshot(unchanged).values.title,undefined);
    const published=await storage.projectConfigurations(options,{action:'publication.save',revision:state.revision,publication:unchanged.publication}) as ProjectConfigurationState;
    await storage.publish({projectName:projectId,createdByUserId:'author',expectedConfigurationRevisions:{main:published.publication!.revision},expectedSourceHash:published.sourceHash});
    const recipient=await storage.projectConfigurations({...options,actorId:'other',target:'1.0.0'},{action:'get'}) as ProjectConfigurationState;
    assert.equal(recipient.fields[0]!.allowThirdParty,false);assert.deepEqual(configurationSnapshot(recipient).agentModelPolicy,{allowThirdParty:false});
  } finally {await rm(root,{recursive:true,force:true});}
});
test('Server discovers Agent model fields without executing source, isolates accounts and excludes published keys', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'server-configured-agent-'));
  try {
    const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot: root });
    await storage.createProjectFromFiles({ projectName: projectId, files: [
      { path: 'package.json', content: JSON.stringify({ id: projectId, name: 'Agent config', version: '1.0.0', devDependencies: { steamharness: corePackage.version }, steamHarness: { defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:'workflow',root:".",entry:"index.ts",configuration:"configuration.json",databases:[]}], projectInfo: { localizedNames: {}, declarations: [], platformSupport: { mode: 'agnostic' },   } } }) },
      { path: 'index.ts', content: 'throw new Error("must not execute"); const node = steamharness.createAgentNode();' },
      { path: 'configuration.json', content: JSON.stringify({ version: 2, fields: [{ name: 'title', type: 'string' }] }) },
    ] });
    storage.getProjectAccessSummary = async (_id, actorId) => ({ projectId, projectName: 'Agent config', visibility: 'private', access: resolveResourceAccess([{ type: 'project', id: projectId, role: actorId === 'author' ? 'owner' : 'developer' }]) });
    const options = { projectName: projectId, actorId: 'author' };
    let state = await storage.projectConfigurations(options, { action: 'get' }) as ProjectConfigurationState;
    assert.equal(state.fields[0]?.control, 'ai-models'); assert.equal(state.fields[0]?.name, key);
    const model = { id: 'custom', name: 'Custom', source: 'third-party', model: 'real-model', apiKind: 'openai-responses', baseUrl: 'https://models.example/v1', apiKey: 'author-only-test-key' };
    state = await storage.projectConfigurations(options, { action: 'save', revision: state.revision, id: state.activeConfigurationId, values: { [key]: [model], title: 'Saved' } }) as ProjectConfigurationState;
    await assert.rejects(storage.projectConfigurations(options, { action: 'save', revision: state.revision, id: state.activeConfigurationId, values: { title: 'Must not save', [key]: [{ ...model, apiKey: '' }] } }), /apiKey/);
    const unchanged = await storage.projectConfigurations(options, { action: 'get' }) as ProjectConfigurationState;
    assert.equal(unchanged.revision, state.revision); assert.equal(configurationSnapshot(unchanged).values.title, 'Saved');
    const other = await storage.projectConfigurations({ ...options, actorId: 'other' }, { action: 'get' }) as ProjectConfigurationState;
    assert.ok(!JSON.stringify(other).includes(model.apiKey));
    state = await storage.projectConfigurations(options, { action: 'publication.save', revision: state.revision, publication: { ...unchanged.publication!, configurations: unchanged.publication!.configurations.map(profile => ({ ...profile, values: unchanged.configurations.find(item => item.id === profile.id)!.values })) } }) as ProjectConfigurationState;
    await storage.publish({ projectName: projectId, createdByUserId: 'author', expectedConfigurationRevisions:{main:state.publication!.revision}, expectedSourceHash: state.sourceHash });
    const recipient = await storage.projectConfigurations({ ...options, actorId: 'other', target: '1.0.0' }, { action: 'get' }) as ProjectConfigurationState;
    assert.equal(recipient.fields[0]?.control, 'ai-models'); assert.ok(!JSON.stringify(recipient).includes(model.apiKey));
  } finally { await rm(root, { recursive: true, force: true }); }
});
