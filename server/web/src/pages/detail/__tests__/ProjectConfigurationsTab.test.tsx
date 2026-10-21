import {act,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {i18n} from "@steamharness/i18n/react";
import {applyConfigurationAction,createConfigurationState} from "@steamharness/project-configuration";
import {apiClient} from "../../../api";
import {ProjectConfigurationsTab} from "../ProjectConfigurationsTab";
import type {Summary} from "../../../types";
const project={id:"project-a",hasDraft:true,projectType:"workflow"} as Summary;
const initial=()=>createConfigurationState([{name:"label",type:"string",defaultValue:"Original"},{name:"active",type:"boolean",defaultValue:false}],()=>"default");
const ok=(data:unknown)=>({errCode:0,errMessage:"",data} as any);
beforeEach(async()=>{await i18n.changeLanguage("en");});
afterEach(()=>vi.restoreAllMocks());
const imageFile={id:"wf_ab12",name:"底图.png",mimeType:"image/png",size:3,storage:"server" as const,projectId:"project-a"};
const fileState=()=>createConfigurationState([{name:"image",type:"file",accept:["image/png"]}],()=>"default");
it("uploads files directly to server storage before applying the reference to the draft",async()=>{
 let state=fileState();const service=vi.spyOn(apiClient,"projectConfigurations").mockImplementation(async(_id,call)=>ok(call.action==="get"?state:(state=applyConfigurationAction(state,call,()=>"new"))));
 let finish!:(value:any)=>void;const upload=vi.spyOn(apiClient,"uploadProjectConfigurationFile").mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 render(<ProjectConfigurationsTab project={project}/>);
 await screen.findByLabelText("Choose file for image");
 const input=screen.getByLabelText("Choose file for image");expect(input).toHaveAttribute("accept","image/png");
 expect(screen.queryByRole("textbox")).toBeNull();
 const selected=new File(['png'],"底图.png",{type:"image/png"});fireEvent.change(input,{target:{files:[selected]}});
 expect(upload).toHaveBeenCalledWith("project-a",selected);expect(screen.getByRole("button",{name:"Save"})).toBeDisabled();
 await act(async()=>finish(ok([imageFile])));
 expect(screen.getByText("底图.png")).toBeTruthy();fireEvent.click(screen.getByRole("button",{name:"Save"}));
 await waitFor(()=>expect(service).toHaveBeenLastCalledWith("project-a",expect.objectContaining({action:"save",revision:0,values:{image:imageFile}}),"draft"));
 await waitFor(()=>expect(screen.getByRole("button",{name:"Clear file selection"})).toBeEnabled());
 fireEvent.click(screen.getByRole("button",{name:"Clear file selection"}));fireEvent.click(screen.getByRole("button",{name:"Save"}));
 await waitFor(()=>expect(service).toHaveBeenLastCalledWith("project-a",expect.objectContaining({action:"save",values:{},unset:["image"]}),"draft"));
});
it("keeps the previous reference on failure and validates file type without network side effects",async()=>{
 const state=fileState();state.configurations[0]!.values.image=imageFile;
 vi.spyOn(apiClient,"projectConfigurations").mockResolvedValue(ok(state));
 const upload=vi.spyOn(apiClient,"uploadProjectConfigurationFile").mockResolvedValue({errCode:403,errMessage:"Permission denied"});
 render(<ProjectConfigurationsTab project={project}/>);await screen.findByText("底图.png");
 const input=screen.getByLabelText("Choose file for image");
 fireEvent.change(input,{target:{files:[new File(['png'],"new.png",{type:"image/png"})]}});
 expect(await screen.findByText("Permission denied")).toBeTruthy();expect(screen.getByText("底图.png")).toBeTruthy();
 upload.mockClear();fireEvent.change(input,{target:{files:[new File(['bad'],"bad.txt",{type:"text/plain"})]}});
 expect(await screen.findByText(/not accepted/)).toBeTruthy();expect(upload).not.toHaveBeenCalled();
});
it("ignores an upload from a project that has been closed",async()=>{
 vi.spyOn(apiClient,"projectConfigurations").mockResolvedValue(ok(fileState()));
 let finish!:(value:any)=>void;vi.spyOn(apiClient,"uploadProjectConfigurationFile").mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const {rerender}=render(<ProjectConfigurationsTab project={project}/>);await screen.findByLabelText("Choose file for image");
 fireEvent.change(screen.getByLabelText("Choose file for image"),{target:{files:[new File(['png'],"底图.png",{type:"image/png"})]}});
 rerender(<ProjectConfigurationsTab project={{...project,id:"project-b"}}/>);await screen.findByLabelText("Choose file for image");
 await act(async()=>finish(ok([imageFile])));
 expect(screen.queryByText("底图.png")).toBeNull();expect(screen.getByRole("button",{name:"Save"})).toBeDisabled();
});
it("creates custom file definitions with accept restrictions through the panel",async()=>{
 let state=initial();vi.spyOn(apiClient,"projectConfigurations").mockImplementation(async(_id,call)=>ok(call.action==="get"?state:(state=applyConfigurationAction(state,call,()=>"new"))));
 render(<ProjectConfigurationsTab project={project}/>);fireEvent.click(await screen.findByRole("button",{name:"Add field"}));
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
 render(<ProjectConfigurationsTab project={{...project,projectType}}/>);
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
 const {container}=render(<ProjectConfigurationsTab project={project}/>);
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
 render(<ProjectConfigurationsTab project={project}/>);await screen.findByText("replacement.png");
 fireEvent.click(screen.getByRole("button",{name:"Clear file selection"}));expect(screen.getByText("底图.png")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Save"}));await waitFor(()=>expect(state.configurations[0]!.values).toEqual({}));
 expect(screen.getByText("底图.png")).toBeTruthy();
});
it("keeps an optional enum unset until selected, including its first option",async()=>{
 let state=createConfigurationState([{name:"label",type:"string"},{name:"mode",type:"string",options:[{value:"auto"},{value:"manual"}]}],()=>"default");
 vi.spyOn(apiClient,"projectConfigurations").mockImplementation(async(_id,call)=>ok(call.action==="get"?state:(state=applyConfigurationAction(state,call,()=>"new"))));
 render(<ProjectConfigurationsTab project={project}/>);await screen.findByLabelText("mode");
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
 render(<ProjectConfigurationsTab project={project}/>);
 const input=await screen.findByLabelText("label");fireEvent.change(input,{target:{value:"Draft"}});
 service.mockResolvedValueOnce({errCode:409,errMessage:"Configuration changed"});
 fireEvent.click(screen.getByRole("button",{name:"Save"}));
 expect(await screen.findByText("Configuration changed")).toBeTruthy();
 expect(input).toHaveProperty("value","Draft");
 expect(service).toHaveBeenLastCalledWith("project-a",expect.objectContaining({action:"save",revision:0,values:{label:"Draft",active:false}}),"draft");
 fireEvent.click(screen.getByRole("button",{name:"Refresh and discard draft"}));
 await waitFor(()=>expect(screen.getByLabelText("label")).toHaveProperty("value","Original"));
});
it("distinguishes a load failure from loading and retries without reloading the page",async()=>{
 const service=vi.spyOn(apiClient,"projectConfigurations").mockResolvedValueOnce({errCode:500,errMessage:"Unavailable"}).mockResolvedValue(ok(initial()));
 render(<ProjectConfigurationsTab project={project}/>);
 expect(await screen.findByText("Unavailable")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Retry"}));
 expect(await screen.findByLabelText("label")).toBeTruthy();expect(service).toHaveBeenCalledTimes(2);
});
it("offers custom fields for an empty declaration",async()=>{
 vi.spyOn(apiClient,"projectConfigurations").mockResolvedValue(ok(createConfigurationState([],()=>"empty")));
 render(<ProjectConfigurationsTab project={project}/>);
 expect(await screen.findByRole("button",{name:"Add field"})).toBeTruthy();
 expect(screen.getByText("No fields. Add a custom configuration field.")).toBeTruthy();
});
it("groups profile and transfer actions in accessible icon menus",async()=>{
 vi.spyOn(apiClient,"projectConfigurations").mockResolvedValue(ok(initial()));
 render(<ProjectConfigurationsTab project={project}/>);
 await screen.findByLabelText("label");
 expect(screen.getByRole("heading",{name:"Configuration fields 2"})).toBeTruthy();
 expect(screen.queryByText(/Exports include every value/)).toBeNull();
 expect(screen.getByRole("button",{name:"New configuration"}).textContent).toBe("");
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
 render(<ProjectConfigurationsTab project={project}/>);await screen.findByLabelText("custom");
 expect(screen.getByRole("button",{name:"Edit field"}).textContent).toBe("");
 fireEvent.keyDown(screen.getByRole("button",{name:"Configuration actions"}),{key:"ArrowDown"});
 fireEvent.click(await screen.findByRole("menuitem",{name:"Copy configuration"}));
 await waitFor(()=>expect(state.configurations).toHaveLength(2));
 expect(service).toHaveBeenLastCalledWith(project.id,expect.objectContaining({action:"duplicate",id:"default",revision:1}),"draft");
 fireEvent.change(screen.getByLabelText("custom"),{target:{value:"Draft"}});
 expect(screen.getByRole("status").textContent).toBe("Unsaved changes");
});

it("ignores a previous visit's save response after returning to the same project",async()=>{
 let finishSave!:(value:ReturnType<typeof ok>)=>void;
 vi.spyOn(apiClient,"projectConfigurations").mockImplementation((_id,call)=>call.action==="get"
   ? Promise.resolve(ok(initial())) : new Promise(resolve=>{finishSave=resolve;}));
 const view=render(<ProjectConfigurationsTab project={project}/>);
 fireEvent.change(await screen.findByLabelText("label"),{target:{value:"Previous visit"}});
 fireEvent.click(screen.getByRole("button",{name:"Save"}));
 view.rerender(<ProjectConfigurationsTab project={{...project,id:"project-b"}}/>);
 await waitFor(()=>expect(screen.getByLabelText("label")).toHaveProperty("value","Original"));
 view.rerender(<ProjectConfigurationsTab project={project}/>);
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
 render(<ProjectConfigurationsTab project={project}/>);
 const east=await screen.findByRole("checkbox",{name:"east"});
 expect(east).not.toBeChecked();
 fireEvent.click(east);
 fireEvent.click(screen.getByRole("button",{name:"Save"}));
 expect(service).toHaveBeenLastCalledWith(project.id,expect.objectContaining({action:"save",values:{tags:["east"]}}),"draft");
});
