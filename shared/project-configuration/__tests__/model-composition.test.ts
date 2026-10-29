import { expect, it } from "vitest";
import { AGENT_MODELS_CONFIGURATION_FIELD as field, AGENT_MODELS_CONFIGURATION_KEY as key, applyConfigurationAction, configurationSnapshot, createConfigurationState, exportConfigurations, parseAgentModels, parseProjectAgentModels, resolveProjectAgentModels } from "../index";

const user = { id: "shared", name: "User model", model: "actual-user", source: "third-party" as const, apiKind: "openai-completions" as const, baseUrl: "https://user.example/v1", apiKey: "user-test-key" };
const local = { ...user, name: "Project model", model: "actual-project", apiKey: "project-test-key" };
const reference = { id: "reference", name: "Project alias", source: "user-settings" as const, modelId: user.id };

it("round-trips project references without retaining host connections and keeps user settings concrete", () => {
  let state = createConfigurationState([field], () => "profile");
  state = applyConfigurationAction(state, { action: "save", revision: state.revision, id: "profile", values: { [key]: [reference] } }, () => "unused");
  const backup = exportConfigurations(state);
  const restored = applyConfigurationAction(createConfigurationState([field], () => "other"), { action: "import", revision: 0, document: backup }, () => "imported");
  expect(configurationSnapshot(restored, "imported").values[key]).toEqual([reference]);
  expect(JSON.stringify(backup)).not.toMatch(/apiKey|baseUrl|user-test-key/);
  expect(() => parseAgentModels([reference])).toThrow();
  for (const invalid of [{ ...reference, apiKey: "must-not-copy" }, { ...reference, modelId: "" }, { ...reference, modelId: "bad:id" }, reference, null]) {
    expect(() => parseProjectAgentModels([reference, invalid])).toThrow();
  }
});

it("composes project defaults and inherited models with distinct IDs and deduplicated references", () => {
  const composed = resolveProjectAgentModels([local], [user], true);
  expect(composed.map(model => [model.id, model.model, model.origin])).toEqual([
    ["project:shared", "actual-project", "project"], ["shared", "actual-user", "settings"],
  ]);
  expect(resolveProjectAgentModels([local], [user], false).map(model => model.id)).toEqual(["shared"]);
  expect(resolveProjectAgentModels([reference], [user], true)).toEqual([{ ...user, id: reference.id, name: reference.name, origin: "settings" }]);
  expect(resolveProjectAgentModels([reference], [], true)).toEqual([{ id: reference.id, name: reference.name, model: user.id, source: "unavailable", origin: "settings" }]);
  expect(resolveProjectAgentModels([], [user], true)).toEqual([{ ...user, origin: "settings" }]);
  expect(parseProjectAgentModels([reference], { allowThirdParty: false })).toEqual([reference]);
  expect(() => parseProjectAgentModels([local], { allowThirdParty: false })).toThrow(/only allows system AI/);
});
