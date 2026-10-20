import { describe, it, expect } from "vitest";
import { applyConfigurationAction, createConfigurationState, configurationSnapshot, exportConfigurations, parseConfigurationDefinition, readConfigurationState, type ProjectConfigurationAction } from "../index";
let serial = 0;
const id = () => `config-${++serial}`;
const fields = parseConfigurationDefinition({version:1, fields:[
  {name:"token",type:"string",secret:true}, {name:"count",type:"number",defaultValue:2},
  {name:"enabled",type:"boolean"}, {name:"choice",type:"string",options:[{value:"a"},{value:"b"}],multiple:true},
  {name:"data",type:"json"}
]}).fields;
describe("portable project configurations", () => {
  it("supports typed values, defaults, clearing, profiles and custom field lifecycle", () => {
    let state = createConfigurationState(fields,id);
    const act = (call: Omit<ProjectConfigurationAction,"revision">) => state = applyConfigurationAction(state,{...call,revision:state.revision},id);
    act({action:"save",id:state.activeConfigurationId,values:{token:"secret",enabled:false,choice:["b"],data:{a:[true,1,null]}}});
    expect(configurationSnapshot(state).values).toEqual({count:2,token:"secret",enabled:false,choice:["b"],data:{a:[true,1,null]}});
    act({action:"duplicate",id:state.activeConfigurationId});
    expect(state.configurations).toHaveLength(2);
    act({action:"field.save",field:{name:"custom",type:"string"}});
    act({action:"save",id:state.activeConfigurationId,values:{custom:"value"},unset:["token"]});
    expect(configurationSnapshot(state).values.token).toBeUndefined();
    act({action:"field.delete",key:"custom"});
    expect(configurationSnapshot(state).values.custom).toBeUndefined();
    act({action:"delete",id:state.activeConfigurationId});
    expect(() => act({action:"delete",id:state.activeConfigurationId})).toThrow("last configuration");
  });
  it("round trips every value, generates IDs and keeps the selected profile", () => {
    let original = createConfigurationState(fields,id);
    original = applyConfigurationAction(original,{action:"save",revision:0,id:original.activeConfigurationId,values:{token:"full secret",enabled:false,data:[0,false,null]}},id);
    const document = exportConfigurations(original);
    const target = createConfigurationState([],id), active = target.activeConfigurationId;
    const imported = applyConfigurationAction(target,{action:"import",revision:0,document},id);
    expect(imported.activeConfigurationId).toBe(active);
    expect(imported.configurations[1]!.id).not.toBe(original.activeConfigurationId);
    expect(configurationSnapshot(imported,imported.configurations[1]!.id).values).toEqual(configurationSnapshot(original).values);
  });
  it("rejects all of an invalid import or conflicting schema and enforces versions", () => {
    const state = createConfigurationState(fields,id), before = structuredClone(state);
    const document = exportConfigurations(state);
    document.configurations.push({name:"invalid",values:{count:"bad"}});
    expect(() => applyConfigurationAction(state,{action:"import",revision:0,document},id)).toThrow("count");
    document.fields[0]!.type = "number";
    expect(() => applyConfigurationAction(state,{action:"import",revision:0,document},id)).toThrow("Conflicting");
    expect(state).toEqual(before);
    expect(() => applyConfigurationAction(state,{action:"create",revision:2},id)).toThrow("changed");
  });
  it("rejects untrusted keys, non-JSON values, duplicate keys and unknown fields", () => {
    expect(() => parseConfigurationDefinition({version:1,fields:[{name:"__proto__",type:"json"}]})).toThrow();
    expect(() => parseConfigurationDefinition({version:1,fields:[fields[0],fields[0]]})).toThrow("Duplicate");
    const state = createConfigurationState(fields,id);
    for (const values of [{data:NaN},{count:"1"},{choice:["x"]},{unknown:true}]) expect(() => applyConfigurationAction(state,{action:"save",revision:0,id:state.activeConfigurationId,values:values as any},id)).toThrow();
  });
});

it("keeps inactive declared values across schema visits without exposing them to runs or exports", () => {
  const declared = [{name:"token",type:"string" as const}];
  let state = createConfigurationState(declared,id);
  state = applyConfigurationAction(state,{action:"save",revision:0,id:state.activeConfigurationId,values:{token:"saved"}},id);
  const older = readConfigurationState(state,[],id);
  expect(configurationSnapshot(older).values).toEqual({});
  expect(exportConfigurations(older).configurations[0]!.values).toEqual({});
  const edited = applyConfigurationAction(older,{action:"rename",revision:older.revision,id:older.activeConfigurationId,name:"Renamed"},id);
  const restored = readConfigurationState(JSON.parse(JSON.stringify(edited)),declared,id);
  expect(configurationSnapshot(restored).values).toEqual({token:"saved"});
});

it("restores a custom definition after a project declaration stops shadowing it", () => {
  let state = createConfigurationState([],id);
  state = applyConfigurationAction(state,{action:"field.save",revision:0,field:{name:"token",type:"string",secret:true}},id);
  state = applyConfigurationAction(state,{action:"save",revision:state.revision,id:state.activeConfigurationId,values:{token:"saved"}},id);
  const shadowed = readConfigurationState(state,[{name:"token",type:"string",label:"Declared"}],id);
  expect(shadowed.customFields).toEqual([]);
  expect(() => applyConfigurationAction(shadowed,{action:"field.delete",revision:shadowed.revision,key:"token"},id)).toThrow("Only custom");
  const restored = readConfigurationState(JSON.parse(JSON.stringify(shadowed)),[],id);
  expect(restored.customFields).toEqual([{name:"token",type:"string",secret:true}]);
  expect(configurationSnapshot(restored).values.token).toBe("saved");
  const deleted = applyConfigurationAction(restored,{action:"field.delete",revision:restored.revision,key:"token"},id);
  expect(deleted.configurations[0]!.values).toEqual({});
  expect(readConfigurationState(deleted,[],id).fields).toEqual([]);
});

it("requires an own value for fields whose names also exist on Object.prototype", () => {
  const state = createConfigurationState([{name:"toString",type:"string",required:true}],id);
  expect(() => configurationSnapshot(state)).toThrow("Missing required configuration");
});

it("renames custom keys across profiles and rejects a conflicting type without partial changes", () => {
  let state=createConfigurationState([],id);
  state=applyConfigurationAction(state,{action:"field.save",revision:state.revision,field:{name:"old",type:"json",secret:true}},id);
  state=applyConfigurationAction(state,{action:"save",revision:state.revision,id:state.activeConfigurationId,values:{old:{nested:[false,null]}}},id);
  state=applyConfigurationAction(state,{action:"duplicate",revision:state.revision,id:state.activeConfigurationId},id);
  state=applyConfigurationAction(state,{action:"field.save",revision:state.revision,key:"old",field:{name:"new",type:"json",secret:true}},id);
  for(const profile of state.configurations)expect(profile.values).toEqual({new:{nested:[false,null]}});
  const before=structuredClone(state);
  expect(()=>applyConfigurationAction(state,{action:"field.save",revision:state.revision,field:{name:"new",type:"number"}},id)).toThrow();
  expect(state).toEqual(before);
  for(const call of [null,{}, {action:"save"}, {action:"exec",revision:state.revision}])expect(()=>applyConfigurationAction(state,call as any,id)).toThrow();
});
