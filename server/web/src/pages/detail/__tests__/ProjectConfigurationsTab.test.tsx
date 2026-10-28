import {act,fireEvent,render as renderPage,screen,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {i18n} from "@steamharness/i18n/react";
import {applyConfigurationAction,bindConfigurationProfiles,configurationAccessView,bindConfigurationTemplate,configurationSnapshot,createPublicationDraft,freezeConfigurationTemplate,createConfigurationState} from "@steamharness/project-configuration";
import {apiClient} from "../../../api";
import {ProjectConfigurationsTab} from "../ProjectConfigurationsTab";
import type {Summary} from "../../../types";
const project={id:"project-a",hasDraft:true,entries:[],defaultEntry:"main"} as Pick<Summary,"id"|"hasDraft"|"access"> as Summary;
const initial=()=>createConfigurationState([{name:"label",type:"string",defaultValue:"Original"},{name:"active",type:"boolean",defaultValue:false}],()=>"default");
const ok=(data:unknown)=>({errCode:0,errMessage:"",data} as any);
beforeEach(async()=>{await i18n.changeLanguage("en");});
afterEach(()=>vi.restoreAllMocks());
async function openConfiguration(name="Default") {fireEvent.click(await screen.findByRole("button",{name}));}
async function render(ui:Parameters<typeof renderPage>[0]) {const view=renderPage(ui);await openConfiguration();return view;}
const imageFile={id:"wf_ab12",name:"底图.png",mimeType:"image/png",size:3,storage:"server" as const,projectId:"project-a"};
const fileState=()=>createConfigurationState([{name:"image",type:"file",accept:["image/png"]}],()=>"default");
it("uploads files directly to server storage before applying the reference to the draft",async()=>{
 let state=fileState();const service=vi.spyOn(apiClient,"projectConfigurations").mockImplementation(async(_id,call)=>ok(call.action==="get"?state:(state=applyConfigurationAction(state,call,()=>"new"))));
 let finish!:(value:any)=>void;const upload=vi.spyOn(apiClient,"uploadProjectConfigurationFile").mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 await render(<ProjectConfigurationsTab entryId="main" project={project}/>);
 await screen.findByLabelText("Choose file for image");
 const input=screen.getByLabelText("Choose file for image");expect(input).toHaveAttribute("accept","image/png");
 expect(screen.queryByRole("textbox")).toBeNull();
 const selected=new File(['png'],"底图.png",{type:"image/png"});fireEvent.change(input,{target:{files:[selected]}});
 expect(upload).toHaveBeenCalledWith("project-a",selected,"image","draft","main");expect(screen.getByRole("button",{name:"Save"})).toBeDisabled();
 await act(async()=>finish(ok([imageFile])));
 expect(screen.getByText("底图.png")).toBeTruthy();fireEvent.click(screen.getByRole("button",{name:"Save"}));
 await waitFor(()=>expect(service).toHaveBeenLastCalledWith("project-a",expect.objectContaining({action:"save",revision:0,values:{image:imageFile}}),"draft","main"));
 await waitFor(()=>expect(screen.getByRole("button",{name:"Clear file selection"})).toBeEnabled());
 fireEvent.click(screen.getByRole("button",{name:"Clear file selection"}));fireEvent.click(screen.getByRole("button",{name:"Save"}));
 await waitFor(()=>expect(service).toHaveBeenLastCalledWith("project-a",expect.objectContaining({action:"save",values:{},unset:["image"]}),"draft","main"));
});
it("keeps the previous reference on failure and validates file type without network side effects",async()=>{
 const state=fileState();state.configurations[0]!.values.image=imageFile;
 vi.spyOn(apiClient,"projectConfigurations").mockResolvedValue(ok(state));
 const upload=vi.spyOn(apiClient,"uploadProjectConfigurationFile").mockResolvedValue({errCode:403,errMessage:"Permission denied"});
 await render(<ProjectConfigurationsTab entryId="main" project={project}/>);await screen.findByText("底图.png");
 const input=screen.getByLabelText("Choose file for image");
 fireEvent.change(input,{target:{files:[new File(['png'],"new.png",{type:"image/png"})]}});
 expect(await screen.findByText("Permission denied")).toBeTruthy();expect(screen.getByText("底图.png")).toBeTruthy();
 upload.mockClear();fireEvent.change(input,{target:{files:[new File(['bad'],"bad.txt",{type:"text/plain"})]}});
 expect(await screen.findByText(/not accepted/)).toBeTruthy();expect(upload).not.toHaveBeenCalled();
});
it("ignores an upload from a project that has been closed",async()=>{
 vi.spyOn(apiClient,"projectConfigurations").mockResolvedValue(ok(fileState()));
 let finish!:(value:any)=>void;vi.spyOn(apiClient,"uploadProjectConfigurationFile").mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const {rerender}=await render(<ProjectConfigurationsTab entryId="main" project={project}/>);await screen.findByLabelText("Choose file for image");
 fireEvent.change(screen.getByLabelText("Choose file for image"),{target:{files:[new File(['png'],"底图.png",{type:"image/png"})]}});
 rerender(<ProjectConfigurationsTab entryId="main" project={{...project,id:"project-b"}}/>);await openConfiguration();await screen.findByLabelText("Choose file for image");
 await act(async()=>finish(ok([imageFile])));
 expect(screen.queryByText("底图.png")).toBeNull();expect(screen.getByRole("button",{name:"Save"})).toBeDisabled();
});
it("creates custom file definitions with accept restrictions through the panel",async()=>{
 let state=initial();vi.spyOn(apiClient,"projectConfigurations").mockImplementation(async(_id,call)=>ok(call.action==="get"?state:(state=applyConfigurationAction(state,call,()=>"new"))));
 await render(<ProjectConfigurationsTab entryId="main" project={project}/>);fireEvent.click(await screen.findByRole("button",{name:"Add field"}));
 fireEvent.change(screen.getByLabelText("Field key"),{target:{value:"photo"}});
 fireEvent.keyDown(screen.getByRole("combobox",{name:"Field type"}),{key:"ArrowDown"});
 fireEvent.click(await screen.findByRole("option",{name:"file"}));
 fireEvent.change(screen.getByLabelText("Accepted file types (one per line)"),{target:{value:"image/png\n.webp"}});
 fireEvent.click(screen.getAllByRole("button",{name:"Save"}).at(-1)!);
 await waitFor(()=>expect(state.customFields[0]).toMatchObject({name:"photo",type:"file",accept:["image/png",".webp"]}));
 expect(await screen.findByLabelText("Choose file for photo")).toBeTruthy();
});
it.each(["workflow","conversation","kanban"] as const)("shows the same configuration editor for %s",async projectType=>{
 vi.spyOn(apiClient,"projectConfigurations").mockResolvedValue(ok(initial()));
 await render(<ProjectConfigurationsTab entryId="main" project={{...project,entries:[{entryId:"main",name:"Main",type:projectType,root:".",entry:"index.ts",databases:[]}]}}/>);
 expect(await screen.findByLabelText("label")).toHaveProperty("value","Original");
 expect(screen.getByRole("button",{name:"Add field"})).toBeTruthy();
});
it("edits inherited defaults directly and preserves explicit empty, false, zero and null values",async()=>{
 let state=createConfigurationState([
  {name:"label",type:"string",defaultValue:"Original"},{name:"blank",type:"string"},
  {name:"count",type:"number",defaultValue:2},{name:"active",type:"boolean",defaultValue:true},
  {name:"data",type:"json",defaultValue:{original:true}},
  {name:"mode",type:"string",options:[{value:"auto"},{value:"manual"}],defaultValue:"auto"},
  {name:"tags",type:"string",multiple:true,options:[{value:"east"},{value:"west"}],defaultValue:["east"]},
 ],()=>"default");state.configurations[0]!.values={};
 vi.spyOn(apiClient,"projectConfigurations").mockImplementation(async(_id,call)=>ok(call.action==="get"?state:(state=applyConfigurationAction(state,call,()=>"new"))));
 const {container}=await render(<ProjectConfigurationsTab entryId="main" project={project}/>);
 await screen.findByLabelText("label");
 expect(screen.queryByRole("checkbox",{name:/Set value/})).toBeNull();
 for(const key of ["label","blank","count","active","data","mode","east","west"])expect(screen.getByLabelText(key)).toBeEnabled();
 fireEvent.change(screen.getByLabelText("label"),{target:{value:""}});
 fireEvent.change(screen.getByLabelText("blank"),{target:{value:"custom"}});fireEvent.change(screen.getByLabelText("blank"),{target:{value:""}});
 fireEvent.change(screen.getByLabelText("count"),{target:{value:"0"}});fireEvent.change(screen.getByLabelText("data"),{target:{value:"null"}});
 fireEvent.click(screen.getByLabelText("active"));fireEvent.click(screen.getByLabelText("east"));fireEvent.click(screen.getByLabelText("west"));
 fireEvent.keyDown(screen.getByLabelText("mode"),{key:"ArrowDown"});fireEvent.click(await screen.findByRole("option",{name:"manual"}));
 fireEvent.click(screen.getByRole("button",{name:"Save"}));
 await waitFor(()=>expect(state.configurations[0]!.values).toEqual({label:"",blank:"",count:0,active:false,data:null,mode:"manual",tags:["west"]}));
 await waitFor(()=>expect(screen.getByRole("button",{name:"Restore default for label"})).toBeEnabled());
 for(const key of ["label","count","active","data","mode","tags"])fireEvent.click(screen.getByRole("button",{name:`Restore default for ${key}`}));
 fireEvent.click(screen.getByRole("button",{name:"Clear value for blank"}));
 expect(screen.getByLabelText("label")).toHaveValue("Original");expect(screen.getByLabelText("count")).toHaveValue(2);
 expect(screen.getByLabelText("active")).toBeChecked();expect(screen.getByLabelText("east")).toBeChecked();expect(screen.getByLabelText("west")).not.toBeChecked();
 expect(screen.getByLabelText("data")).toHaveValue('{\n  "original": true\n}');expect(container.querySelector('button[id="configuration-mode"]')).toHaveTextContent("auto");
 fireEvent.change(screen.getByLabelText("label"),{target:{value:"Only this field"}});fireEvent.click(screen.getByRole("button",{name:"Save"}));
 await waitFor(()=>expect(state.configurations[0]!.values).toEqual({label:"Only this field"}));
 expect(screen.getByLabelText("count")).toBeEnabled();expect(screen.getByLabelText("data")).toHaveValue('{\n  "original": true\n}');
});
it("shows the inherited file immediately after clearing an override",async()=>{
 let state=createConfigurationState([{name:"image",type:"file",defaultValue:imageFile}],()=>"default");
 state.configurations[0]!.values.image={...imageFile,id:"wf_cd34",name:"replacement.png"};
 vi.spyOn(apiClient,"projectConfigurations").mockImplementation(async(_id,call)=>ok(call.action==="get"?state:(state=applyConfigurationAction(state,call,()=>"new"))));
 await render(<ProjectConfigurationsTab entryId="main" project={project}/>);await screen.findByText("replacement.png");
 fireEvent.click(screen.getByRole("button",{name:"Clear file selection"}));expect(screen.getByText("底图.png")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Save"}));await waitFor(()=>expect(state.configurations[0]!.values).toEqual({}));
 expect(screen.getByText("底图.png")).toBeTruthy();
});
it("keeps an optional enum unset until selected, including its first option",async()=>{
 let state=createConfigurationState([{name:"label",type:"string"},{name:"mode",type:"string",options:[{value:"auto"},{value:"manual"}]}],()=>"default");
 vi.spyOn(apiClient,"projectConfigurations").mockImplementation(async(_id,call)=>ok(call.action==="get"?state:(state=applyConfigurationAction(state,call,()=>"new"))));
 await render(<ProjectConfigurationsTab entryId="main" project={project}/>);await screen.findByLabelText("mode");
 expect(screen.getByLabelText("mode")).toHaveTextContent(/^$/);
 fireEvent.change(screen.getByLabelText("label"),{target:{value:"Draft"}});fireEvent.click(screen.getByRole("button",{name:"Save"}));
 await waitFor(()=>expect(state.configurations[0]!.values).toEqual({label:"Draft"}));
 await waitFor(()=>expect(screen.getByLabelText("mode")).toBeEnabled());
 fireEvent.keyDown(screen.getByLabelText("mode"),{key:"ArrowDown"});fireEvent.click(await screen.findByRole("option",{name:"auto"}));
 fireEvent.click(screen.getByRole("button",{name:"Save"}));await waitFor(()=>expect(state.configurations[0]!.values).toEqual({label:"Draft",mode:"auto"}));
 await waitFor(()=>expect(screen.getByRole("button",{name:"Clear value for mode"})).toBeEnabled());
 fireEvent.click(screen.getByRole("button",{name:"Clear value for mode"}));expect(screen.getByLabelText("mode")).toHaveTextContent(/^$/);
});
it("preserves a draft after a conflict, sends native values and can discard it",async()=>{
 const state=initial();const service=vi.spyOn(apiClient,"projectConfigurations").mockResolvedValue(ok(state));
 await render(<ProjectConfigurationsTab entryId="main" project={project}/>);
 const input=await screen.findByLabelText("label");fireEvent.change(input,{target:{value:"Draft"}});
 service.mockResolvedValueOnce({errCode:409,errMessage:"Configuration changed"});
 fireEvent.click(screen.getByRole("button",{name:"Save"}));
 expect(await screen.findByText("Configuration changed")).toBeTruthy();
 expect(input).toHaveProperty("value","Draft");
 expect(service).toHaveBeenLastCalledWith("project-a",expect.objectContaining({action:"save",revision:0,values:{label:"Draft",active:false}}),"draft","main");
 fireEvent.click(screen.getByRole("button",{name:"Refresh and discard draft"}));
 await waitFor(()=>expect(screen.getByLabelText("label")).toHaveProperty("value","Original"));
});
it("distinguishes a load failure from loading and retries without reloading the page",async()=>{
 const service=vi.spyOn(apiClient,"projectConfigurations").mockResolvedValueOnce({errCode:500,errMessage:"Unavailable"}).mockResolvedValue(ok(initial()));
 renderPage(<ProjectConfigurationsTab entryId="main" project={project}/>);
 expect(await screen.findByText("Unavailable")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Retry"}));await openConfiguration();
 expect(await screen.findByLabelText("label")).toBeTruthy();expect(service).toHaveBeenCalledTimes(2);
});
it("offers custom fields for an empty declaration",async()=>{
 vi.spyOn(apiClient,"projectConfigurations").mockResolvedValue(ok(createConfigurationState([],()=>"empty")));
 await render(<ProjectConfigurationsTab entryId="main" project={project}/>);
 expect(await screen.findByRole("button",{name:"Add field"})).toBeTruthy();
 expect(screen.getByText("No fields. Add a custom configuration field.")).toBeTruthy();
});
it("groups profile and transfer actions in accessible icon menus",async()=>{
 vi.spyOn(apiClient,"projectConfigurations").mockResolvedValue(ok(initial()));
 await render(<ProjectConfigurationsTab entryId="main" project={project}/>);
 await screen.findByLabelText("label");
 expect(screen.getByRole("heading",{name:"Configuration fields 2"})).toBeTruthy();
 expect(screen.queryByText(/Exports include every value/)).toBeNull();
 expect(screen.getByRole("button",{name:"Back to list"})).toBeTruthy();
 const actions=screen.getByRole("button",{name:"Configuration actions"});
 fireEvent.keyDown(actions,{key:"ArrowDown"});
 const remove=await screen.findByRole("menuitem",{name:"Delete configuration"});
 expect(remove).toHaveAttribute("aria-disabled","true");
 fireEvent.keyDown(remove,{key:"Escape"});
 await waitFor(()=>expect(screen.queryByRole("menu")).toBeNull());
 const transfer=screen.getByRole("button",{name:"Import / export"});
 fireEvent.keyDown(transfer,{key:"ArrowDown"});
 expect(await screen.findByRole("menuitem",{name:"Export all"})).toBeTruthy();
 expect(screen.getByText(/Exports include every value/)).toBeTruthy();
 fireEvent.keyDown(screen.getByRole("menu"),{key:"Escape"});
 await waitFor(()=>expect(transfer).toHaveFocus());
});
it("copies a configuration from the menu and places custom field icons beside its heading",async()=>{
 let state=applyConfigurationAction(initial(),{action:"field.save",revision:0,field:{name:"custom",type:"string"}},()=>"other");
 const service=vi.spyOn(apiClient,"projectConfigurations").mockImplementation(async(_id,call)=>{
   state=call.action==="get"?state:applyConfigurationAction(state,call,()=>"copy");return ok(state);
 });
 await render(<ProjectConfigurationsTab entryId="main" project={project}/>);await screen.findByLabelText("custom");
 expect(screen.getByRole("button",{name:"Edit field"}).textContent).toBe("");
 fireEvent.keyDown(screen.getByRole("button",{name:"Configuration actions"}),{key:"ArrowDown"});
 fireEvent.click(await screen.findByRole("menuitem",{name:"Copy configuration"}));
 await waitFor(()=>expect(state.configurations).toHaveLength(2));
 expect(service).toHaveBeenLastCalledWith(project.id,expect.objectContaining({action:"duplicate",id:"default",revision:1}),"draft","main");
 fireEvent.change(screen.getByLabelText("custom"),{target:{value:"Draft"}});
 expect(screen.getByRole("status").textContent).toBe("Unsaved changes");
});

it("ignores a previous visit's save response after returning to the same project",async()=>{
 let finishSave!:(value:ReturnType<typeof ok>)=>void;
 vi.spyOn(apiClient,"projectConfigurations").mockImplementation((_id,call)=>call.action==="get"
   ? Promise.resolve(ok(initial())) : new Promise(resolve=>{finishSave=resolve;}));
 const view=await render(<ProjectConfigurationsTab entryId="main" project={project}/>);
 fireEvent.change(await screen.findByLabelText("label"),{target:{value:"Previous visit"}});
 fireEvent.click(screen.getByRole("button",{name:"Save"}));
 view.rerender(<ProjectConfigurationsTab entryId="main" project={{...project,id:"project-b"}}/>);await openConfiguration();
 await waitFor(()=>expect(screen.getByLabelText("label")).toHaveProperty("value","Original"));
 view.rerender(<ProjectConfigurationsTab entryId="main" project={project}/>);await openConfiguration();
 await waitFor(()=>expect(screen.getByLabelText("label")).toHaveProperty("value","Original"));
 fireEvent.change(screen.getByLabelText("label"),{target:{value:"Current draft"}});
 const saved=initial();saved.revision=1;saved.configurations[0]!.values.label="Previous visit";
 await act(async()=>finishSave(ok(saved)));
 expect(screen.getByLabelText("label")).toHaveProperty("value","Current draft");
 expect(screen.getByRole("button",{name:"Save"})).toBeEnabled();
});

it.each([23,null,{old:true}])("allows repairing a previous value after its field changes to multiple options: %j",async value=>{
 const state=createConfigurationState([{name:"tags",type:"json",defaultValue:value}],()=>"default");
 state.fields=[{name:"tags",type:"string",multiple:true,options:[{value:"east"},{value:"west"}]}];
 const service=vi.spyOn(apiClient,"projectConfigurations").mockResolvedValue(ok(state));
 await render(<ProjectConfigurationsTab entryId="main" project={project}/>);
 const east=await screen.findByRole("checkbox",{name:"east"});
 expect(east).not.toBeChecked();
 fireEvent.click(east);
 fireEvent.click(screen.getByRole("button",{name:"Save"}));
 expect(service).toHaveBeenLastCalledWith(project.id,expect.objectContaining({action:"save",values:{tags:["east"]}}),"draft","main");
});

it("shows locked fields and JSON child permissions, and preserves a denied raw edit as a draft",async()=>{
 const author=createConfigurationState([{name:"fixed",type:"string",defaultValue:"Official",sharing:{includeValue:true,editable:false}},{name:"settings",type:"json",defaultValue:{locked:0,open:false},sharing:{includeValue:true},paths:{"/locked":{editable:false}}}],()=>"author");
 let state=bindConfigurationTemplate(createConfigurationState([],()=>"personal"),freezeConfigurationTemplate(createPublicationDraft(author),{projectId:project.id,entryId:"main",projectVersion:"1.0.0",sourceHash:"a".repeat(64)}));
 const service=vi.spyOn(apiClient,"projectConfigurations").mockImplementation(async(_id,call)=>{try{if(call.action!=="get")state=applyConfigurationAction(state,call,()=>"new");return ok(state);}catch(error){return {errCode:403,errMessage:(error as Error).message} as any;}});
 await render(<ProjectConfigurationsTab entryId="main" project={project}/>);
 expect(await screen.findByLabelText("fixed")).toBeDisabled();expect(screen.queryByRole("tab",{name:"Publication and permissions"})).toBeNull();
 expect(screen.getByLabelText("/locked")).toBeDisabled();expect(screen.getByLabelText("/open")).toBeEnabled();
 fireEvent.change(screen.getByLabelText("/open"),{target:{value:"true"}});fireEvent.blur(screen.getByLabelText("/open"));
 fireEvent.click(screen.getByRole("button",{name:"Save"}));
 await waitFor(()=>expect(configurationSnapshot(state).values.settings).toEqual({locked:0,open:true}));
 const raw=screen.getByLabelText("Edit raw JSON (permissions checked on save)");fireEvent.change(raw,{target:{value:'{'}});expect(screen.getByLabelText("Edit raw JSON (permissions checked on save)")).toBe(raw);fireEvent.change(raw,{target:{value:'{"open":false}'}});fireEvent.click(screen.getByRole("button",{name:"Save"}));
 expect(await screen.findByText(/Configuration is locked by the author/)).toBeTruthy();expect(raw).toHaveValue('{"open":false}');
 expect(service).toHaveBeenCalled();expect(configurationSnapshot(state).values.settings).toEqual({locked:0,open:true});
});
it("keeps publication controls separate, previews filtered values and preserves an author draft on conflict",async()=>{
 const state=initial();state.canManagePublication=true;state.publication=createPublicationDraft(state);
 vi.spyOn(apiClient,"projectConfigurations").mockImplementation(async(_id,call)=>call.action==="get"?ok(state):{errCode:409,errMessage:"Publication draft changed"} as any);
 await render(<ProjectConfigurationsTab entryId="main" project={project}/>);await screen.findByLabelText("label");
 fireEvent.mouseDown(screen.getByRole("tab",{name:"Publication and permissions"}),{button:0,ctrlKey:false});
 const include=screen.getAllByRole("checkbox",{name:"Include value"})[0]!;expect(include).not.toBeChecked();fireEvent.click(include);
 fireEvent.click(screen.getByRole("button",{name:"Recipient preview"}));
 expect((screen.getByRole("textbox",{name:"Recipient preview"}) as HTMLTextAreaElement).value).toContain('"Original"');
 fireEvent.click(screen.getByRole("button",{name:"Save publication draft"}));
 expect(await screen.findByText("Publication draft changed")).toBeTruthy();expect(include).toBeChecked();
});
it("preserves JSON publication edits across folding and refreshes fields through the action menu",async()=>{
 const state=createConfigurationState([{name:"settings",type:"json",defaultValue:{host:"local",token:"private"},sharing:{includeValue:true},paths:{"/token":{publish:false}}}],()=>"author");
 state.canManagePublication=true;state.publication=createPublicationDraft(state);
 const service=vi.spyOn(apiClient,"projectConfigurations").mockImplementation(async(_id,call)=>call.action==="get"?ok(state):{errCode:409,errMessage:"Publication draft changed"} as any);
 await render(<ProjectConfigurationsTab entryId="main" project={project}/>);await screen.findByLabelText("settings");
 fireEvent.mouseDown(screen.getByRole("tab",{name:"Publication and permissions"}),{button:0,ctrlKey:false});
 const expand=screen.getByRole("button",{name:"settings: JSON path (JSON Pointer)"});
 expect(expand).toHaveAttribute("aria-expanded","false");fireEvent.click(expand);
 fireEvent.change(screen.getByLabelText("JSON path (JSON Pointer)"),{target:{value:"/host"}});
 fireEvent.click(screen.getByRole("button",{name:"Add path rule"}));
 fireEvent.keyDown(screen.getByRole("combobox",{name:"/host: Allow user edits"}),{key:"ArrowDown"});
 fireEvent.click(await screen.findByRole("option",{name:/^No$/}));
 fireEvent.click(expand);fireEvent.click(expand);
 expect(screen.getByRole("combobox",{name:"/host: Allow user edits"})).toHaveTextContent("No");
 fireEvent.pointerDown(screen.getByRole("button",{name:"Configuration actions"}),{button:0,ctrlKey:false});
 fireEvent.click(await screen.findByRole("menuitem",{name:"Refresh fields from the project"}));
 fireEvent.click(screen.getByRole("button",{name:"Recipient preview"}));
 const preview=JSON.parse((screen.getByRole("textbox",{name:"Recipient preview"}) as HTMLTextAreaElement).value);
 expect(preview.configurations[0].values.settings).toEqual({host:"local"});
 fireEvent.click(screen.getByRole("button",{name:"Save publication draft"}));
 await waitFor(()=>expect(service).toHaveBeenLastCalledWith(project.id,expect.objectContaining({action:"publication.save",publication:expect.objectContaining({fields:[expect.objectContaining({paths:{"/token":{publish:false},"/host":{editable:false}}})]})}),"draft","main"));
 expect(await screen.findByText("Publication draft changed")).toBeTruthy();
});

it('starts with profiles and edits a non-current profile without changing the run selection',async()=>{
 let state=applyConfigurationAction(initial(),{action:'create',name:'Secondary',revision:0},()=> 'secondary');
 state.activeConfigurationId='default';state.configurations[1]!.values.label='Second value';
 vi.spyOn(apiClient,'projectConfigurations').mockImplementation(async(_id,call)=>ok(call.action==='get'?state:(state=applyConfigurationAction(state,call,()=>crypto.randomUUID()))));
 renderPage(<ProjectConfigurationsTab entryId="main" project={project}/>);
 await screen.findByRole('table',{name:'Project configurations'});expect(screen.queryByLabelText('label')).toBeNull();expect(screen.queryByRole('button',{name:'Save'})).toBeNull();
 await openConfiguration('Secondary');expect(screen.getByLabelText('label')).toHaveValue('Second value');expect(state.activeConfigurationId).toBe('default');
 fireEvent.change(screen.getByLabelText('label'),{target:{value:'Edited second'}});fireEvent.click(screen.getByRole('button',{name:'Save'}));
 await waitFor(()=>expect(state.configurations[1]!.values.label).toBe('Edited second'));expect(state.configurations[0]!.values.label).toBe('Original');expect(state.activeConfigurationId).toBe('default');
 await waitFor(()=>expect(screen.getByRole('button',{name:'Back to list'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Back to list'}));
 expect(screen.queryByLabelText('label')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Use this configuration: Secondary'}));
 await waitFor(()=>expect(state.activeConfigurationId).toBe('secondary'));expect(screen.getByRole('table',{name:'Project configurations'})).toBeTruthy();
});
it('shows the active configuration distinctly and offers explicit use actions for other profiles',async()=>{
 const state=applyConfigurationAction(initial(),{action:'create',name:'Secondary',revision:0},()=> 'secondary');state.activeConfigurationId='default';
 vi.spyOn(apiClient,'projectConfigurations').mockResolvedValue(ok(state));
 renderPage(<ProjectConfigurationsTab entryId="main" project={project}/>);
 const active=await screen.findByRole('button',{name:'Default'});
 expect(active).toHaveAttribute('aria-current','true');expect(active.closest('tr')).toHaveAttribute('data-state','selected');
 expect(active.closest('tr')).toHaveTextContent('In use');expect(screen.queryByRole('button',{name:'Use this configuration: Default'})).toBeNull();
 expect(screen.getByRole('button',{name:'Secondary'})).not.toHaveAttribute('aria-current');
 expect(screen.getByRole('button',{name:'Use this configuration: Secondary'})).toHaveTextContent('Use this configuration');
 await openConfiguration('Secondary');expect(state.activeConfigurationId).toBe('default');expect(screen.queryByText('In use')).toBeNull();
 expect(screen.getByRole('button',{name:'Use this configuration: Secondary'})).toBeEnabled();
 fireEvent.click(screen.getByRole('button',{name:'Back to list'}));await openConfiguration();
 expect(screen.getByText('In use')).toBeTruthy();expect(screen.queryByRole('button',{name:/Use this configuration/})).toBeNull();
});
it('keeps the committed active profile while switching and recovers a failed use action',async()=>{
 let state=applyConfigurationAction(initial(),{action:'create',name:'Secondary',revision:0},()=> 'secondary');state.activeConfigurationId='default';
 let finish!:(result:any)=>void;
 const service=vi.spyOn(apiClient,'projectConfigurations').mockImplementation(async(_id,call)=>call.action==='get'?ok(state):new Promise(resolve=>{finish=resolve;}));
 renderPage(<ProjectConfigurationsTab entryId="main" project={project}/>);
 const use=await screen.findByRole('button',{name:'Use this configuration: Secondary'});
 fireEvent.click(use);expect(use).toBeDisabled();expect(use).toHaveAttribute('aria-busy','true');expect(use).toHaveTextContent('Switching...');
 expect(screen.getByRole('button',{name:'Default'})).toHaveAttribute('aria-current','true');fireEvent.click(use);
 expect(service.mock.calls.filter(([,call])=>call.action==='select')).toHaveLength(1);
 await act(async()=>finish({errCode:409,errMessage:'Configuration changed'}));
 expect(use).toBeEnabled();expect(use).toHaveAttribute('aria-busy','false');expect(use).toHaveTextContent('Use this configuration');
 expect(screen.getByRole('button',{name:'Default'})).toHaveAttribute('aria-current','true');expect(screen.getByRole('alert')).toHaveTextContent('Configuration changed');
 fireEvent.click(use);state=applyConfigurationAction(state,{action:'select',id:'secondary',revision:state.revision},()=> 'unused');
 await act(async()=>finish(ok(state)));
 expect(screen.getByRole('button',{name:'Secondary'})).toHaveAttribute('aria-current','true');
 expect(screen.getByRole('button',{name:'Default'})).not.toHaveAttribute('aria-current');
 expect(screen.getByRole('button',{name:'Secondary'}).closest('tr')).toHaveTextContent('In use');
 expect(screen.getByRole('button',{name:'Use this configuration: Default'})).toBeEnabled();
});
it('refreshes detail usage after an external switch while preserving an unsaved draft',async()=>{
 let state=applyConfigurationAction(initial(),{action:'create',name:'Secondary',revision:0},()=> 'secondary');state.activeConfigurationId='default';
 let poll!:()=>void;
 vi.spyOn(globalThis,'setInterval').mockImplementationOnce(callback=>{poll=callback as ()=>void;return 0 as unknown as ReturnType<typeof setInterval>;});
 const service=vi.spyOn(apiClient,'projectConfigurations').mockImplementation(async()=>ok(state));
 await render(<ProjectConfigurationsTab entryId="main" project={project}/>);expect(screen.getByText('In use')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('label'),{target:{value:'Keep draft'}});
 state=applyConfigurationAction(state,{action:'select',id:'secondary',revision:state.revision},()=> 'unused');await act(async()=>{poll();});
 expect(screen.getByLabelText('label')).toHaveValue('Keep draft');expect(screen.queryByText('In use')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Use this configuration: Default'}));expect(state.activeConfigurationId).toBe('secondary');
 expect(screen.getByText('Save or discard your draft before changing configurations.')).toBeTruthy();expect(service.mock.calls.every(([,call])=>call.action==='get')).toBe(true);
});
it('preserves unsaved values and publication rules on back navigation until saved or discarded',async()=>{
 const state=initial();state.canManagePublication=true;state.publication=createPublicationDraft(state);
 vi.spyOn(apiClient,'projectConfigurations').mockResolvedValue(ok(state));
 await render(<ProjectConfigurationsTab entryId="main" project={project}/>);
 fireEvent.change(screen.getByLabelText('label'),{target:{value:'Draft'}});fireEvent.click(screen.getByRole('button',{name:'Back to list'}));
 expect(screen.getByLabelText('label')).toHaveValue('Draft');expect(screen.getByText('Save or discard your draft before changing configurations.')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Refresh and discard draft'}));fireEvent.mouseDown(screen.getByRole('tab',{name:'Publication and permissions'}),{button:0,ctrlKey:false});
 const include=screen.getAllByRole('checkbox',{name:'Include value'})[0]!;fireEvent.click(include);fireEvent.click(screen.getByRole('button',{name:'Back to list'}));expect(include).toBeChecked();
 fireEvent.click(screen.getByRole('button',{name:'Refresh and discard draft'}));fireEvent.click(screen.getByRole('button',{name:'Back to list'}));
 expect(screen.getByRole('table',{name:'Project configurations'})).toBeTruthy();expect(screen.queryByRole('tab')).toBeNull();
});
it('creates a configuration from the list and deletes the viewed configuration back to the list',async()=>{
 let state=initial();vi.spyOn(apiClient,'projectConfigurations').mockImplementation(async(_id,call)=>ok(call.action==='get'?state:(state=applyConfigurationAction(state,call,()=> 'created'))));
 renderPage(<ProjectConfigurationsTab entryId="main" project={project}/>);fireEvent.click(await screen.findByRole('button',{name:'New configuration'}));
 fireEvent.change(screen.getByLabelText('Configuration name'),{target:{value:'Created'}});fireEvent.click(screen.getByRole('button',{name:'Confirm'}));
 expect(await screen.findByRole('heading',{name:'Created'})).toBeTruthy();expect(screen.getByLabelText('label')).toHaveValue('Original');
 fireEvent.keyDown(screen.getByRole('button',{name:'Configuration actions'}),{key:'ArrowDown'});fireEvent.click(await screen.findByRole('menuitem',{name:'Delete configuration'}));
 fireEvent.click(screen.getByRole('button',{name:'Confirm'}));
 expect(await screen.findByRole('table',{name:'Project configurations'})).toBeTruthy();expect(screen.queryByLabelText('label')).toBeNull();expect(state.configurations).toHaveLength(1);
});

it('returns to the list if a clean viewed configuration is removed by another editor',async()=>{
 let state=applyConfigurationAction(initial(),{action:'create',name:'Secondary',revision:0},()=> 'secondary');
 let poll!:()=>void;
 vi.spyOn(globalThis,'setInterval').mockImplementationOnce(callback=>{poll=callback as ()=>void;return 0 as unknown as ReturnType<typeof setInterval>;});
 vi.spyOn(apiClient,'projectConfigurations').mockImplementation(async()=>ok(state));
 renderPage(<ProjectConfigurationsTab entryId="main" project={project}/>);await openConfiguration('Secondary');
 state=applyConfigurationAction(state,{action:'delete',id:'secondary',revision:state.revision},()=> 'unused');
 await act(async()=>{poll();});
 expect(screen.getByRole('table',{name:'Project configurations'})).toBeTruthy();expect(screen.queryByLabelText('label')).toBeNull();
});

it("filters guest lists and keeps only allowed profile values editable",async()=>{
 const raw=bindConfigurationProfiles(createConfigurationState([{name:"mode",type:"string"},{name:"model",type:"string"}],()=>"legacy"),{version:1,defaultProfileKey:"ask",manageMinimumRole:"developer",profiles:[{key:"ask",name:"Ask",minimumRole:"guest",fixedValues:{mode:"ask"},tags:["Read only"]},{key:"build",name:"Build",minimumRole:"developer",fixedValues:{mode:"build"}}]});
 vi.spyOn(apiClient,"projectConfigurations").mockResolvedValue(ok(configurationAccessView(raw,{subject:"alice",role:"guest",online:true})));
 renderPage(<ProjectConfigurationsTab entryId="main" project={project}/>);
 fireEvent.click(await screen.findByRole("button",{name:/^Ask/}));
 expect(screen.queryByText("Build")).toBeNull();
 expect(screen.queryByRole("button",{name:"Create"})).toBeNull();
 expect(screen.queryByRole("button",{name:"Add field"})).toBeNull();
 expect(screen.getByLabelText("mode")).toBeDisabled();expect(screen.getByLabelText("model")).toBeEnabled();
});
it("withdraws Build details after a role downgrade while preserving the editing draft",async()=>{
 const raw=bindConfigurationProfiles(createConfigurationState([{name:"mode",type:"string"},{name:"model",type:"string"}],()=>"legacy"),{version:1,defaultProfileKey:"ask",manageMinimumRole:"developer",profiles:[{key:"ask",name:"Ask",minimumRole:"guest",fixedValues:{mode:"ask"}},{key:"build",name:"Build",minimumRole:"developer",fixedValues:{mode:"build"}}]});
 let role:"guest"|"developer"="developer";
 vi.spyOn(apiClient,"projectConfigurations").mockImplementation(async()=>ok(configurationAccessView(raw,{subject:"alice",role,online:true})));
 renderPage(<ProjectConfigurationsTab entryId="main" project={project}/>);
 fireEvent.click(await screen.findByRole("button",{name:/^Build/}));
 fireEvent.change(screen.getByLabelText("model"),{target:{value:"draft model"}});
 role="guest";
 await waitFor(()=>expect(screen.queryByText("Build")).toBeNull(),{timeout:4000});
 expect(screen.queryByLabelText("model")).toBeNull();
 expect(screen.queryByRole("button",{name:"Add field"})).toBeNull();
 role="developer";
 await waitFor(()=>expect(screen.getByLabelText("model")).toHaveValue("draft model"),{timeout:4000});
});
