import {act,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {i18n} from "@steamharness/i18n/react";
import {createConfigurationState} from "@steamharness/project-configuration";
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
