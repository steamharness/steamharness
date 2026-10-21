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
it.each(["workflow","conversation","kanban"] as const)("shows the same configuration editor for %s",async projectType=>{
 vi.spyOn(apiClient,"projectConfigurations").mockResolvedValue(ok(initial()));
 render(<ProjectConfigurationsTab project={{...project,projectType}}/>);
 expect(await screen.findByLabelText("label")).toHaveProperty("value","Original");
 expect(screen.getByRole("button",{name:"Add field"})).toBeTruthy();
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
