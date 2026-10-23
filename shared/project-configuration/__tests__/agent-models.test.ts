import { describe, expect, it } from "vitest";
import { AGENT_MODELS_CONFIGURATION_FIELD as field, AGENT_MODELS_CONFIGURATION_KEY as key, applyConfigurationAction, bindConfigurationTemplate, configurationSnapshot, createConfigurationState, createPublicationDraft, exportConfigurations, freezeConfigurationTemplate, parseAgentModelCatalog, parseAgentModels, parseConfigurationField, readConfigurationState } from "../index";

const third = { id: "third", name: "Private endpoint", source: "third-party", model: "custom-model", apiKind: "openai-completions", baseUrl: "https://models.example/v1", apiKey: "test-only-key" };
const system = { id: "system", name: "Subscription", source: "system", model: "system-model", credentialId: "subscription-a" };
describe("configured Agent models", () => {
  it("enforces a declared system-only policy on direct saves, defaults and imports without partial writes", () => {
    const restricted = { ...field, allowThirdParty: false };
    const state = createConfigurationState([restricted, {name:"title",type:"string"}], () => "profile");
    expect(() => parseConfigurationField({...restricted,defaultValue:[third]})).toThrow(/only allows system AI/);
    expect(() => parseConfigurationField({name:"ordinary",type:"string",allowThirdParty:false})).toThrow(/allowThirdParty/);
    expect(() => parseConfigurationField({...field,allowThirdParty:"false"})).toThrow(/boolean/);
    expect(() => applyConfigurationAction(state, {action:"save",revision:0,id:"profile",values:{title:"must not save",[key]:[third] as any}}, () => "new")).toThrow(/only allows system AI/);
    const document = {version:1 as const,kind:"steamharness-project-configurations" as const,fields:[{...field,allowThirdParty:true}],configurations:[{name:"valid first",values:{[key]:[system] as any}},{name:"invalid second",values:{[key]:[third] as any}}]};
    expect(() => applyConfigurationAction(state,{action:"import",revision:0,document},()=>"new")).toThrow(/only allows system AI/);
    expect(state.configurations).toHaveLength(1); expect(state.revision).toBe(0); expect(state.configurations[0]!.values).toEqual({[key]:[]});
    const saved = applyConfigurationAction(state,{action:"save",revision:0,id:"profile",values:{[key]:[system] as any}},()=>"new");
    expect(configurationSnapshot(saved).agentModelPolicy).toEqual({allowThirdParty:false});
    const template=freezeConfigurationTemplate(createPublicationDraft(saved),{projectId:"project",projectVersion:"1",sourceHash:"0".repeat(64)});
    const recipient=bindConfigurationTemplate(createConfigurationState(template.fields,()=>"personal"),template);
    expect(template.fields[0]!.allowThirdParty).toBe(false);
    expect(configurationSnapshot(recipient).agentModelPolicy).toEqual({allowThirdParty:false});
    expect(() => applyConfigurationAction(recipient,{action:"save",revision:recipient.revision,id:recipient.activeConfigurationId,values:{[key]:[third] as any}},()=>"new")).toThrow(/only allows system AI/);
  });
  it("keeps previously saved third-party entries readable and exportable after a code policy change", () => {
    const before = createConfigurationState([field],()=>"profile"); before.configurations[0]!.values[key]=[third,system] as any;
    const state=readConfigurationState(before,[{...field,allowThirdParty:false}],()=>"new");
    expect(configurationSnapshot(state).values[key]).toEqual([third,system]);
    expect(exportConfigurations(state).configurations[0]!.values[key]).toEqual([third,system]);
    expect(() => applyConfigurationAction(state,{action:"save",revision:0,id:"profile",values:{[key]:[third,system] as any}},()=>"new")).toThrow(/only allows system AI/);
    const cleaned=applyConfigurationAction(state,{action:"save",revision:0,id:"profile",values:{[key]:[system] as any}},()=>"new");
    expect(configurationSnapshot(cleaned).values[key]).toEqual([system]);
  });
  it("validates a mixed ordered list and normalizes only connection whitespace", () => {
    expect(parseAgentModels([system, { ...third, baseUrl: " https://models.example/v1/ " }])).toEqual([system, third]);
  });
  it.each([
    null, {}, [false], [{ ...third, id: "" }], [third, third], [{ ...third, name: " " }],
    [{ ...third, model: "" }], [{ ...third, apiKey: "" }], [{ ...third, apiKind: "unsupported" }],
    [{ ...third, baseUrl: "file:///secret" }], [{ ...third, baseUrl: "https://key:secret@example.com" }],
    [{ ...third, baseUrl: "https://example.com?apiKey=key" }], [{ ...third, baseUrl: "https://example.com/#secret" }],
    [{ ...third, hiddenCredential: "secret" }], [{ ...system, credentialId: "" }], [{ ...system, apiKey: "unexpected" }],
  ])("refuses malformed model lists without mutating saved configuration", value => {
    const state = createConfigurationState([field], () => "profile");
    expect(() => applyConfigurationAction(state, { action: "save", revision: 0, id: "profile", values: { [key]: value as any } }, () => "new")).toThrow();
    expect(state.configurations[0]!.values[key]).toEqual([]);
  });
  it("round-trips a complete backup and never publishes keys by default", () => {
    let state = createConfigurationState([field], () => "profile");
    state = applyConfigurationAction(state, { action: "save", revision: 0, id: "profile", values: { [key]: [system, third] as any } }, () => "unused");
    const backup = exportConfigurations(state);
    const imported = applyConfigurationAction(createConfigurationState([field], () => "other"), { action: "import", revision: 0, document: backup }, () => "imported");
    expect(configurationSnapshot(imported, "imported").values[key]).toEqual([system, third]);
    const template = freezeConfigurationTemplate(createPublicationDraft(state), { projectId: "project", projectVersion: "1", sourceHash: "0".repeat(64) });
    expect(JSON.stringify(template)).not.toContain(third.apiKey);
    expect(template.fields[0]!.defaultValue).toBeUndefined();
    expect(template.configurations[0]!.values[key]).toBeUndefined();
  });
  it("treats model arrays as one permission unit, including direct writes and imports", () => {
    const owner = createConfigurationState([{ ...field, sharing: { publish: true, includeValue: true, editable: false } }], () => "official");
    owner.configurations[0]!.values[key] = [system] as any;
    const template = freezeConfigurationTemplate(createPublicationDraft(owner), { projectId: "project", projectVersion: "1", sourceHash: "0".repeat(64) });
    const state = bindConfigurationTemplate(createConfigurationState(template.fields, () => "personal"), template);
    expect(() => applyConfigurationAction(state, { action: "save", revision: state.revision, id: state.activeConfigurationId, values: { [key]: [third] as any } }, () => "new")).toThrow(/locked/);
    const document = exportConfigurations(state); document.configurations[0]!.values[key] = [third] as any;
    expect(() => applyConfigurationAction(state, { action: "import", revision: state.revision, document }, () => "new")).toThrow(/locked/);
    expect(configurationSnapshot(state).values[key]).toEqual([system]);
  });
  it("whitelists catalogue display metadata and excludes unsupported providers", () => {
    expect(parseAgentModelCatalog({ credentials: [
      { id: "account", name: "Subscribed", providerType: "anthropic", models: ["model", "model"], modelDetails: [{ id: "model", name: "Model" }], apiKey: "never-copy-this" },
      { id: "other", name: "Unsupported", providerType: "unsupported", models: ["model"] },
    ] })).toEqual([{ id: "account", name: "Subscribed", models: [{ id: "model", name: "model" }] }]);
    expect(parseAgentModelCatalog({ credentials: [null, false, { id: "account", name: "Plan", providerType: "openai-responses", models: ["model"], modelDetails: {} }] })).toEqual([{ id: "account", name: "Plan", models: [{ id: "model", name: "model" }] }]);
  });
});
