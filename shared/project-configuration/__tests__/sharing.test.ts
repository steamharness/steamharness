import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {applyConfigurationAction,bindConfigurationTemplate,configurationSnapshot,configurationRule,configurationRuleHash,exportConfigurations,createConfigurationState,createPublicationDraft,freezeConfigurationTemplate,parseConfigurationDefinition,parseConfigurationTemplate,validateConfigurationAction,type ConfigurationValue,type ProjectConfigurationField} from '../index';
let sequence=0;const id=()=>String(++sequence);
const binding={projectId:'project',entryId:"main",projectVersion:'1.0.0',sourceHash:'a'.repeat(64)};
function published(fields:ProjectConfigurationField[]) {const author=createConfigurationState(fields,id),draft=createPublicationDraft(author);return freezeConfigurationTemplate(draft,binding);}
describe('versioned configuration publication',()=>{
  it('filters private fields, defaults and nested values, preserving falsy values',()=>{
    const template=published([
      {name:'privateToken',type:'string',defaultValue:'never-distribute',sharing:{publish:false,includeValue:true}},
      {name:'ownToken',type:'string',defaultValue:'author-secret'},
      {name:'json',type:'json',defaultValue:{zero:0,no:false,empty:'',nil:null,secret:'nested-secret'},sharing:{includeValue:true},paths:{'/secret':{publish:false}}},
    ]);
    const text=JSON.stringify(template);expect(text).not.toContain('never-distribute');expect(text).not.toContain('privateToken');expect(text).not.toContain('author-secret');expect(text).not.toContain('nested-secret');expect(text).not.toContain('/secret');
    expect(template.fields.every(f=>f.defaultValue===undefined)).toBe(true);
    expect(template.configurations[0]!.values).toEqual({json:{zero:0,no:false,empty:'',nil:null}});
    expect(parseConfigurationDefinition({version:2,fields:template.fields}).version).toBe(2);
    expect(parseConfigurationTemplate(template)).toEqual(template);
  });
  it('reserves omitted fields and paths without distributing their names',()=>{
    const template=published([{name:'privateKey',type:'string',sharing:{publish:false}},{name:'settings',type:'json',defaultValue:{hidden:{token:'author'},open:1},sharing:{includeValue:true},paths:{'/hidden':{publish:false}}}]);
    const state=bindConfigurationTemplate(createConfigurationState([],id),template);
    expect(()=>applyConfigurationAction(state,{action:'field.save',revision:state.revision,field:{name:'privateKey',type:'string'}},id)).toThrow(/author field/);
    expect(()=>applyConfigurationAction(state,{action:'save',id:state.activeConfigurationId,revision:state.revision,values:{settings:{hidden:{token:'mine'},open:1}}},id)).toThrow(/locked/);
    for(const value of ['','privateKey','/hidden','/a~1b/~0key','配置'.repeat(80)])expect(configurationRuleHash(value)).toBe(createHash('sha256').update(value).digest('hex'));
  });
  it('allows a specific open child beneath a locked object, including an initially absent object',()=>{
    const template=published([{name:'settings',type:'json',sharing:{editable:false},paths:{'/open':{editable:true}}}]);
    let state=bindConfigurationTemplate(createConfigurationState([],id),template);
    state=applyConfigurationAction(state,{action:'save',id:state.activeConfigurationId,revision:state.revision,values:{settings:{open:0}}},id);
    expect(configurationSnapshot(state).values.settings).toEqual({open:0});
    expect(()=>applyConfigurationAction(state,{action:'save',id:state.activeConfigurationId,revision:state.revision,values:{settings:{open:1,locked:false}}},id)).toThrow(/locked/);
  });
  it('applies more specific publication rules inside an excluded JSON object',()=>{
    const template=published([{name:'settings',type:'json',defaultValue:{group:{private:'never-share',open:0}},sharing:{includeValue:true},paths:{'/group':{publish:false},'/group/open':{publish:true}}}]);
    expect(template.configurations[0]!.values).toEqual({settings:{group:{open:0}}});
    expect(JSON.stringify(template)).not.toContain('never-share');
    expect(JSON.stringify(template)).not.toContain('private');
    let state=bindConfigurationTemplate(createConfigurationState([],id),template);
    state=applyConfigurationAction(state,{action:'save',id:state.activeConfigurationId,revision:state.revision,values:{settings:{group:{open:false}}}},id);
    expect(configurationSnapshot(state).values.settings).toEqual({group:{open:false}});
    expect(()=>applyConfigurationAction(state,{action:'save',id:state.activeConfigurationId,revision:state.revision,values:{settings:{group:{open:false,private:'mine'}}}},id)).toThrow(/locked/);
    const excluded=published([{name:'settings',type:'json',defaultValue:{open:0},sharing:{publish:false,includeValue:true},paths:{'/open':{publish:true}}}]);
    expect(excluded.fields).toEqual([]);
  });
  it('preserves inherited locks and value rules when an omitted parent republishes a child',()=>{
    const field:ProjectConfigurationField={name:'settings',type:'json',defaultValue:{group:{fixed:0,own:'author-secret'}},sharing:{includeValue:true},paths:{'/group':{publish:false,editable:false,includeValue:false},'/group/fixed':{publish:true,includeValue:true},'/group/own':{publish:true,editable:true}}};
    const template=published([field]),publishedField=template.fields[0]!;
    for(const pointer of ['/group/fixed','/group/own']) expect(configurationRule(publishedField,pointer)).toEqual(configurationRule(field,pointer));
    expect(template.configurations[0]!.values).toEqual({settings:{group:{fixed:0}}});
    expect(JSON.stringify(template)).not.toContain('author-secret');
    const state=bindConfigurationTemplate(createConfigurationState([],id),template),before=structuredClone(state);
    const denied:ConfigurationValue[]=[{group:{fixed:1}},{group:null},{group:{}},null];
    for(const settings of denied) {
      expect(()=>applyConfigurationAction(state,{action:'save',id:state.activeConfigurationId,revision:state.revision,values:{settings}},id)).toThrow(/locked/);
    }
    const document=exportConfigurations(state);document.configurations.push({name:'Tampered',values:{settings:{group:{fixed:1}}}});
    expect(()=>applyConfigurationAction(state,{action:'import',revision:state.revision,document},id)).toThrow(/locked/);
    expect(state).toEqual(before);
    const next=applyConfigurationAction(state,{action:'save',id:state.activeConfigurationId,revision:state.revision,values:{settings:{group:{fixed:0,own:''}}}},id);
    expect(configurationSnapshot(next).values.settings).toEqual({group:{fixed:0,own:''}});
  });
  it('round trips multiple templates and adds new version profiles while retaining personal profiles',()=>{
    const author=createConfigurationState([{name:'fixed',type:'number',defaultValue:0,sharing:{includeValue:true,editable:false}}],id);
    let draft=createPublicationDraft(author);draft.configurations.push({id:'second',name:'Second',values:{fixed:2}});draft.defaultConfigurationId='second';
    const first=freezeConfigurationTemplate(draft,binding);
    let state=bindConfigurationTemplate(createConfigurationState([],id),first);
    expect(configurationSnapshot(state).values.fixed).toBe(2);
    state=applyConfigurationAction(state,{action:'import',revision:state.revision,document:exportConfigurations(state)},id);
    expect(state.configurations.map(c=>configurationSnapshot(state,c.id,false).values.fixed)).toEqual([0,2,0,2]);
    const upgrade=structuredClone(first);upgrade.projectVersion='2';upgrade.configurations.push({id:'third',name:'Third',values:{fixed:3}});
    const next=bindConfigurationTemplate(state,upgrade);
    expect(next.configurations).toHaveLength(5);
    expect(bindConfigurationTemplate(next,upgrade)).toEqual(next);
  });
  it('checks whole-object replacements, parent deletion and escaped pointers atomically',()=>{
    const template=published([{name:'settings',type:'json',defaultValue:{locked:1,open:1,'a/b':{'~key':2}},sharing:{includeValue:true},paths:{'/locked':{editable:false},'/a~1b/~0key':{editable:false}}}]);
    const state=bindConfigurationTemplate(createConfigurationState([],id),template),current=state.activeConfigurationId;
    const save=(value:unknown)=>applyConfigurationAction(state,{action:'save',id:current,revision:state.revision,values:{settings:value as any}},id);
    expect(()=>save({locked:2,open:3})).toThrow(/locked/i);
    expect(()=>save({open:3})).toThrow(/locked/i);
    expect(()=>save(null)).toThrow(/locked/i);
    expect(()=>save({locked:1,open:3,'a/b':{'~key':8}})).toThrow(/locked/i);
    const next=save({locked:1,open:3,'a/b':{'~key':2}});
    expect(configurationSnapshot(next).values.settings).toEqual({locked:1,open:3,'a/b':{'~key':2}});
    expect(configurationSnapshot(state).values.settings).toEqual({locked:1,open:1,'a/b':{'~key':2}});
  });
  it('rejects import and custom-definition bypasses without changing any profile',()=>{
    const template=published([{name:'fixed',type:'string',defaultValue:'official',sharing:{includeValue:true,editable:false}}]);
    const state=bindConfigurationTemplate(createConfigurationState([],id),template),before=structuredClone(state);
    expect(()=>applyConfigurationAction(state,{action:'import',revision:state.revision,document:{version:1,kind:'steamharness-project-configurations',fields:template.fields,configurations:[{name:'good',values:{fixed:'official'}},{name:'bad',values:{fixed:'tampered'}}]}},id)).toThrow(/locked/i);
    expect(()=>applyConfigurationAction(state,{action:'field.save',revision:state.revision,field:{name:'fixed',type:'string'}},id)).toThrow(/declared/);
    expect(()=>applyConfigurationAction(state,{action:'import',revision:state.revision,document:{version:1,kind:'steamharness-project-configurations',fields:[{...template.fields[0]!,sharing:{editable:true}}],configurations:[{name:'policy bypass',values:{fixed:'official'}}]}},id)).toThrow(/definitions/);
    expect(state).toEqual(before);
  });
  it('keeps editable personal values and custom fields on upgrade, dropping newly locked overlays',()=>{
    const first=published([{name:'settings',type:'json',defaultValue:{a:1,b:1},sharing:{includeValue:true}}]);
    let state=bindConfigurationTemplate(createConfigurationState([],id),first);
    state=applyConfigurationAction(state,{action:'save',id:state.activeConfigurationId,revision:state.revision,values:{settings:{a:8,b:9}}},id);
    state=applyConfigurationAction(state,{action:'field.save',revision:state.revision,field:{name:'personal',type:'number',defaultValue:0}},id);
    const upgraded=structuredClone(first);upgraded.projectVersion='2.0.0';upgraded.fields[0]!.paths={'/a':{editable:false}};upgraded.configurations[0]!.values.settings={a:2,b:2};
    const next=bindConfigurationTemplate(state,upgraded);
    expect(configurationSnapshot(next).values).toEqual({settings:{a:2,b:9},personal:0});
  });
  it('updates untouched initial values while retaining only actual personal changes',()=>{
    const first=published([{name:'settings',type:'json',defaultValue:{a:1,b:1},sharing:{includeValue:true}},{name:'title',type:'string',defaultValue:'old',sharing:{includeValue:true}}]);
    let state=bindConfigurationTemplate(createConfigurationState([],id),first);
    expect(state.configurations[0]!.values).toEqual({});
    state=applyConfigurationAction(state,{action:'save',id:state.activeConfigurationId,revision:state.revision,values:{settings:{a:8,b:1},title:'old'}},id);
    expect(state.configurations[0]!.values).toEqual({settings:{a:8}});
    state=applyConfigurationAction(state,{action:'duplicate',id:state.activeConfigurationId,revision:state.revision},id);
    const upgrade=structuredClone(first);upgrade.projectVersion='2';upgrade.configurations[0]!.values={settings:{a:2,b:2},title:'new'};
    state=bindConfigurationTemplate(state,upgrade);
    for(const profile of state.configurations)expect(configurationSnapshot(state,profile.id).values).toEqual({settings:{a:8,b:2},title:'new'});
  });
  it('retains incompatible personal values as drafts until explicitly resolved',()=>{
    const first=published([{name:'value',type:'string',sharing:{includeValue:true}}]);
    let state=bindConfigurationTemplate(createConfigurationState([],id),first);
    state=applyConfigurationAction(state,{action:'save',id:state.activeConfigurationId,revision:state.revision,values:{value:'my draft'}},id);
    const upgrade=structuredClone(first);upgrade.projectVersion='2';upgrade.fields[0]!.type='number';upgrade.configurations[0]!.values={value:0};
    state=bindConfigurationTemplate(state,upgrade);
    expect(configurationSnapshot(state).values).toEqual({value:0});
    expect(state.conflicts).toEqual([{configurationId:state.activeConfigurationId,key:'value',value:'my draft',reason:expect.any(String)}]);
    state=bindConfigurationTemplate(state,upgrade);
    expect(state.conflicts).toHaveLength(1);
    state=applyConfigurationAction(state,{action:'save',id:state.activeConfigurationId,revision:state.revision,values:{value:2}},id);
    expect(configurationSnapshot(state).values).toEqual({value:2});expect(state.conflicts).toEqual([]);
  });
  it('persists permitted JSON deletions through reload, copy, import and upgrades without deleting new defaults',()=>{
    const first=published([{name:'settings',type:'json',defaultValue:{locked:0,remove:1,keep:2},sharing:{includeValue:true},paths:{'/locked':{editable:false}}}]);
    let state=bindConfigurationTemplate(createConfigurationState([],id),first);
    state=applyConfigurationAction(state,{action:'save',id:state.activeConfigurationId,revision:state.revision,values:{settings:{locked:0,keep:3}}},id);
    expect(configurationSnapshot(state).values.settings).toEqual({locked:0,keep:3});
    state=bindConfigurationTemplate(state,first);expect(configurationSnapshot(state).values.settings).toEqual({locked:0,keep:3});
    state=applyConfigurationAction(state,{action:'duplicate',id:state.activeConfigurationId,revision:state.revision},id);
    expect(configurationSnapshot(state).values.settings).toEqual({locked:0,keep:3});
    state=applyConfigurationAction(state,{action:'import',revision:state.revision,document:exportConfigurations(state,state.activeConfigurationId)},id);
    expect(configurationSnapshot(state,state.configurations.at(-1)!.id).values.settings).toEqual({locked:0,keep:3});
    const upgraded=structuredClone(first);upgraded.projectVersion='2';upgraded.configurations[0]!.values.settings={locked:0,remove:8,keep:2,newValue:4};
    state=bindConfigurationTemplate(state,upgraded);expect(configurationSnapshot(state).values.settings).toEqual({locked:0,keep:3,newValue:4});
    upgraded.projectVersion='3';upgraded.fields[0]!.paths!['/remove']={editable:false};state=bindConfigurationTemplate(state,upgraded);
    expect(configurationSnapshot(state).values.settings).toEqual({locked:0,remove:8,keep:3,newValue:4});
  });
  it('requires a value for required locked fields and treats arrays as a whole',()=>{
    expect(()=>published([{name:'required',type:'string',required:true,defaultValue:'secret',sharing:{editable:false}}])).toThrow(/published value/);
    expect(()=>published([{name:'data',type:'json',defaultValue:[1],paths:{'/0':{editable:false}}}])).toThrow(/Arrays/);
    expect(()=>parseConfigurationDefinition({version:2,fields:[{name:'x',type:'json',paths:{'/bad~2':{editable:false}}}]})).toThrow(/Pointer/);
    for(const version of ['2',true,null])expect(()=>parseConfigurationDefinition({version,fields:[]})).toThrow(/version/);
    for(const action of [['get'],['publication.preview'],null])expect(()=>validateConfigurationAction({action})).toThrow(/action/);
  });
});
