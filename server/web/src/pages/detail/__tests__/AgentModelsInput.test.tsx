import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@steamharness/i18n/react";
import { AgentModelsInput } from "../AgentModelsInput";
import { apiClient } from "../../../api";
import { ProjectConfigurationsTab } from "../ProjectConfigurationsTab";
import { AGENT_MODELS_CONFIGURATION_FIELD, AGENT_MODELS_CONFIGURATION_KEY, applyConfigurationAction, createConfigurationState } from "@steamharness/project-configuration";
import type { Summary } from "../../../types";
const third = { id: "third", name: "Custom", source: "third-party", model: "custom-model", apiKind: "openai-completions", baseUrl: "https://models.example/v1", apiKey: "private-test-key" };
const system = { id: "system", name: "Subscribed", source: "system", model: "system-model", credentialId: "subscription" };
const changed = vi.fn<(models: unknown[]) => void>(), draftChanged = vi.fn<(dirty: boolean) => void>();
beforeEach(async () => { await i18n.changeLanguage("en"); changed.mockReset(); draftChanged.mockReset(); });
afterEach(() => vi.restoreAllMocks());
function Editor({ initial = [], disabled = false }: { initial?: unknown[]; disabled?: boolean }) {
  const [value, setValue] = useState(JSON.stringify(initial));
  return <AgentModelsInput value={value} disabled={disabled} onChange={next => { changed(JSON.parse(next)); setValue(next); }} onDraftChange={draftChanged}/>;
}
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
it("uses mutually exclusive source forms, loads subscriptions on demand and manages a mixed list", async () => {
  const catalog = vi.spyOn(apiClient, "systemAiModelCatalog").mockResolvedValue({ errCode: 0, errMessage: "", data: { credentials: [{ id: "subscription", name: "Plan", providerType: "anthropic", models: ["system-model"] }] } });
  const { container } = render(<Editor initial={[system]}/>); expect(catalog).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("radio", { name: "Third-party AI" })); expect(screen.getByLabelText("API Key")).toHaveAttribute("type", "password"); expect(screen.queryByLabelText("Subscribed AI")).toBeNull();
  fireEvent.change(screen.getByLabelText("Model name"), { target: { value: third.name } });
  fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: third.baseUrl } });
  fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: third.model } });
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: third.apiKey } });
  click("Apply model"); expect(changed).toHaveBeenLastCalledWith([system, expect.objectContaining({ source: "third-party", apiKey: third.apiKey })]);
  expect(container.textContent).not.toContain(third.apiKey); expect(draftChanged).toHaveBeenLastCalledWith(false);
  click("Set as default model: Custom"); expect(changed.mock.lastCall![0][0]).toMatchObject({ name: "Custom" });
  click("Edit model: Custom"); fireEvent.change(screen.getByLabelText("Model name"), { target: { value: "Updated" } }); click("Apply model");
  click("Delete model: Subscribed"); expect(changed.mock.lastCall![0]).toMatchObject([{ name: "Updated" }]);
  fireEvent.click(screen.getByRole("radio", { name: "System AI" })); await waitFor(() => expect(catalog).toHaveBeenCalledOnce());
  expect(screen.queryByLabelText("API Key")).toBeNull(); expect(screen.getByLabelText("Subscribed AI")).toBeTruthy();
});
it("preserves unfinished model drafts and saved values when validation fails", () => {
  render(<Editor initial={[third]}/>); click("Edit model: Custom");
  fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "file:///invalid" } }); click("Apply model"); expect(changed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("radio", { name: "System AI" })); expect(screen.getByText("Add or cancel the model being edited first.")).toBeTruthy(); expect(screen.getByLabelText("API Key")).toBeTruthy();
  click("Cancel"); expect(draftChanged).toHaveBeenLastCalledWith(false); expect(screen.getByText("Custom")).toBeTruthy();
});
it("shows subscription guidance and retries catalogue failures", async () => {
  const catalog = vi.spyOn(apiClient, "systemAiModelCatalog").mockResolvedValueOnce({ errCode: 503, errMessage: "Offline" }).mockResolvedValueOnce({ errCode: 0, errMessage: "", data: { credentials: [] } });
  render(<Editor/>); fireEvent.click(screen.getByRole("radio", { name: "System AI" })); expect(await screen.findByText("Offline")).toBeTruthy();
  click("Refresh system AI models"); expect(await screen.findByText(/No subscribed AI models/)).toBeTruthy(); expect(screen.getByRole("link", { name: "Manage subscriptions" })).toHaveAttribute("href", "/settings/ai"); expect(catalog).toHaveBeenCalledTimes(2);
});
it.each(["en", "zh-CN"])("locks published models and renders source labels in %s", async language => {
  await i18n.changeLanguage(language); render(<Editor initial={[third]} disabled/>);
  expect(screen.getByText(language === "en" ? "Default model" : "默认模型")).toBeTruthy();
  expect(screen.getAllByRole("button").every(button => (button as HTMLButtonElement).disabled)).toBe(true);
  expect(screen.queryByLabelText("API Key")).toBeNull();
});
it("persists the model list through the configuration service only after applying the model draft", async () => {
  let state = createConfigurationState([AGENT_MODELS_CONFIGURATION_FIELD], () => "default");
  const service = vi.spyOn(apiClient, "projectConfigurations").mockImplementation(async (_id, call) => ({ errCode: 0, errMessage: "", data: call.action === "get" ? state : (state = applyConfigurationAction(state, call, () => "new")) }));
  render(<ProjectConfigurationsTab project={{ id: "project-a", hasDraft: true, projectType: "conversation" } as Summary}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Default" }));
  fireEvent.click(screen.getByRole("radio", { name: "Third-party AI" }));
  for (const [label, value] of [["Model name", third.name], ["Base URL", third.baseUrl], ["Model ID", third.model], ["API Key", third.apiKey]]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
  click("Save"); expect(screen.getByText("Add or cancel the model being edited first.")).toBeTruthy(); expect(service).toHaveBeenCalledTimes(1);
  click("Apply model"); click("Save"); await waitFor(() => expect(state.configurations[0]!.values[AGENT_MODELS_CONFIGURATION_KEY]).toMatchObject([{ name: third.name, model: third.model, apiKey: third.apiKey }]));
  expect(state.activeConfigurationId).toBe("default"); expect(screen.queryByLabelText("API Key")).toBeNull();
});
