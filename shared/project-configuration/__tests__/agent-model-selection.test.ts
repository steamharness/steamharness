import { expect, it } from "vitest";
import { applyConfigurationAction, configurationSnapshot, createConfigurationState, parseConfigurationField } from "../index";

const field = { name: "RESEARCH_MODEL", type: "string", control: "agent-model", defaultValue: "" } as const;
it("lets developers declare a single model selector with an inherited default and a stable configured ID", () => {
  expect(parseConfigurationField(field)).toEqual(field);
  let state = createConfigurationState([field], () => "profile");
  expect(configurationSnapshot(state).values.RESEARCH_MODEL).toBe("");
  state = applyConfigurationAction(state, { action: "save", revision: state.revision, id: "profile", values: { RESEARCH_MODEL: "subscription_1" } }, () => "new");
  expect(configurationSnapshot(state).values.RESEARCH_MODEL).toBe("subscription_1");
  state = applyConfigurationAction(state, { action: "save", revision: state.revision, id: "profile", values: { RESEARCH_MODEL: "" } }, () => "new");
  expect(configurationSnapshot(state).values.RESEARCH_MODEL).toBe("");
});
it("rejects multiple choices, secrets, static options and values that are not model IDs", () => {
  for (const patch of [{ multiple: true }, { type: "json" }, { secret: true }, { options: [] }, { defaultValue: ["one", "two"] }, { defaultValue: "provider/model" }]) {
    expect(() => parseConfigurationField({ ...field, ...patch })).toThrow();
  }
});
