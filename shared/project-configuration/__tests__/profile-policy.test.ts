import {describe,it,expect} from 'vitest';
import {applyConfigurationAction,bindConfigurationProfiles,bindConfigurationTemplate,configurationAccessView,configurationSnapshot,createConfigurationState,createPublicationDraft,exportConfigurations,freezeConfigurationTemplate,parseConfigurationDefinition,parseConfigurationTemplate,validateConfigurationSnapshotAccess,type ConfigurationAccess} from '../index';

const fields=[{name:'mode',type:'string' as const,defaultValue:'ask',sharing:{publish:true,includeValue:true,editable:false}},{name:'models',type:'json' as const}];
const policy={version:1 as const,defaultProfileKey:'ask',manageMinimumRole:'developer' as const,profiles:[
  {key:'ask',name:'Ask',minimumRole:'guest' as const,fixedValues:{mode:'ask'},tags:['Read only']},
  {key:'build',name:'Build',minimumRole:'developer' as const,fixedValues:{mode:'build'},tags:['Write']},
]};
const developer:ConfigurationAccess={subject:'alice',role:'developer',online:true};
const guest:ConfigurationAccess={subject:'alice',role:'guest',online:true};
const state=()=>bindConfigurationProfiles(createConfigurationState(fields,()=> 'legacy'),policy);
const mutate=(s:ReturnType<typeof state>,call:Parameters<typeof applyConfigurationAction>[1],access=developer)=>applyConfigurationAction(s,{...call,revision:s.revision},()=> 'copy',undefined,access);

describe('role controlled configuration profiles',()=>{
  it('guests see and export only the base Ask profile, even after developer copies and renames',()=>{
    let s=mutate(state(),{action:'duplicate',id:'profile-ask'});
    s=mutate(s,{action:'rename',id:'copy',name:'Pretend Build'});
    expect(()=>mutate(s,{action:'rename',id:'profile-ask',name:'Build'})).toThrow(/base configurations/);
    expect(()=>mutate(s,{action:'delete',id:'profile-ask'})).toThrow(/base configurations/);
    const view=configurationAccessView(s,guest);
    expect(view.configurations.map(profile=>[profile.name,profile.profileKey])).toEqual([['Ask','ask']]);
    expect(view.activeConfigurationId).toBe('profile-ask');
    expect(view.capabilities?.manageConfigurations).toBe(false);
    expect(exportConfigurations(s,undefined,guest).configurations.map(profile=>profile.values.mode)).toEqual(['ask']);
    expect(()=>exportConfigurations(s,'profile-build',guest)).toThrow(/not available/);
  });
  it('rejects every guest structure operation and mode override without partial writes',()=>{
    const s=state(),before=structuredClone(s);
    for(const action of ['create','duplicate','rename','delete','field.save','field.delete','import'] as const)expect(()=>mutate(s,{action,id:'profile-ask',name:'Build'},guest)).toThrow(/Developer access/);
    expect(()=>mutate(s,{action:'select',id:'profile-build'},guest)).toThrow(/not available/);
    expect(()=>mutate(s,{action:'save',id:'profile-ask',values:{mode:'build',models:[1]}},guest)).toThrow(/fixes/);
    expect(()=>mutate(s,{action:'save',id:'profile-ask',unset:['mode']},guest)).toThrow(/fixes/);
    expect(s).toEqual(before);
    expect(mutate(s,{action:'save',id:'profile-ask',values:{models:[false,0,'',null]}},guest).configurations.find(profile=>profile.id==='profile-ask')?.values.models).toEqual([false,0,'',null]);
  });
  it('inherits the source profile on duplicates and validates imports rather than trusting labels',()=>{
    const s=mutate(state(),{action:'duplicate',id:'profile-build'});
    expect(s.configurations.find(profile=>profile.id==='copy')?.profileKey).toBe('build');
    const document=exportConfigurations(s,undefined,developer);
    document.configurations[0]!.values.mode='build';
    expect(()=>mutate(state(),{action:'import',document})).toThrow(/protected/);
  });
  it('rechecks role, account and fixed values for supplied or resumed snapshots',()=>{
    const s=state(),snapshot=configurationSnapshot(s,'profile-build');
    const valid=validateConfigurationSnapshotAccess(s,snapshot,developer);
    expect(valid.accessSubject).toBe('alice');
    expect(()=>validateConfigurationSnapshotAccess(s,valid,guest)).toThrow(/not available/);
    expect(()=>validateConfigurationSnapshotAccess(s,valid,{...developer,online:false})).toThrow(/not available/);
    expect(()=>validateConfigurationSnapshotAccess(s,valid,{...developer,subject:'bob'})).toThrow(/not available/);
    const ask=configurationSnapshot(s,'profile-ask');ask.values.mode='build';
    expect(()=>validateConfigurationSnapshotAccess(s,ask,guest)).toThrow(/fixed value/);
  });
  it('freezes policy into a version 3 template and filters hidden template values from responses',()=>{
    const draft=createPublicationDraft(state());
    const template=freezeConfigurationTemplate(draft,{projectId:'project',projectVersion:'1',sourceHash:'0'.repeat(64)});
    expect(template.version).toBe(3);expect(parseConfigurationTemplate(template)).toEqual(template);
    const downloaded=bindConfigurationTemplate(createConfigurationState([],()=> 'new'),template);
    const view=configurationAccessView(downloaded,guest);
    expect(view.template?.configurations.map(profile=>profile.profileKey)).toEqual(['ask']);
    expect(JSON.stringify(view)).not.toContain('"mode":"build"');
    expect(()=>parseConfigurationTemplate({...template,version:2})).toThrow(/policy version/);
  });
  it('rejects unsupported policy versions and inaccessible defaults',()=>{
    expect(()=>parseConfigurationDefinition({version:2,fields,profilePolicy:{...policy,version:2}})).toThrow(/Unsupported/);
    expect(()=>parseConfigurationDefinition({version:2,fields,profilePolicy:{...policy,defaultProfileKey:'build'}})).toThrow(/guests/);
  });
  it('removes hidden attachments and stale author drafts when access is downgraded',()=>{
    const s=state();
    s.fields.push({name:'image',type:'file',sharing:{publish:true,includeValue:true}});
    const ref={id:'wf_ab12',name:'build.png',mimeType:'image/png',size:3,storage:'server' as const};
    s.configurations.find(profile=>profile.profileKey==='build')!.values.image=ref;
    const template=freezeConfigurationTemplate(createPublicationDraft(s),{projectId:'project',projectVersion:'1',sourceHash:'0'.repeat(64)});
    template.attachments=[{id:ref.id,path:`configuration-assets/${ref.id}`,sha256:'1'.repeat(64)}];
    const downloaded=bindConfigurationTemplate(createConfigurationState([],()=> 'new'),template);
    downloaded.publication=createPublicationDraft(s);downloaded.canManagePublication=true;
    const view=configurationAccessView(downloaded,guest);
    expect(view.template?.attachments).toEqual([]);
    expect(view.publication).toBeUndefined();expect(view.canManagePublication).toBe(false);
    expect(JSON.stringify(view)).not.toContain('build.png');
  });
  it('inherits fixed false, zero, empty and null values and rejects obsolete snapshots',()=>{
    const s=bindConfigurationProfiles(createConfigurationState([{name:'value',type:'json'}],()=> 'legacy'),{...policy,profiles:[{...policy.profiles[0]!,fixedValues:{value:{enabled:false,count:0,text:'',extra:null}}}]});
    const snapshot=configurationSnapshot(s,'profile-ask');
    expect(snapshot.values.value).toEqual({enabled:false,count:0,text:'',extra:null});
    delete snapshot.profilePolicyVersion;
    expect(()=>validateConfigurationSnapshotAccess(s,snapshot,guest)).toThrow(/not available/);
  });
});
