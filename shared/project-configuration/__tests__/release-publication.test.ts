import { expect, it } from "vitest";
import { restrictReleasePublication, freezeConfigurationTemplate, type ConfigurationPublicationDraft, type ProjectConfigurationDefinition } from "../index";

it("bounds stored publication fields, profiles and fixed values to the release definition", () => {
  const definition: ProjectConfigurationDefinition = { version: 2, fields: [{ name: "mode", type: "string", defaultValue: "ask", sharing: { publish: true, includeValue: true, editable: false } }],
    profilePolicy: { version: 1, defaultProfileKey: "ask", manageMinimumRole: "developer", profiles: [{ key: "ask", name: "Ask", minimumRole: "guest", fixedValues: { mode: "ask" } }] } };
  const publication: ConfigurationPublicationDraft = { revision: 1, configurationRevision: 1, fields: [...definition.fields, { name: "privateBuild", type: "string" }],
    configurations: [{ id: "ask", name: "Ask", profileKey: "ask", values: { mode: "build", privateBuild: "secret" } }, { id: "build", name: "Build", profileKey: "build", values: { mode: "build" } }], defaultConfigurationId: "build" };
  const restricted = restrictReleasePublication(publication, definition);
  expect(restricted.configurations).toEqual([{ id: "ask", name: "Ask", profileKey: "ask", values: { mode: "ask" } }]);
  expect(restricted.defaultConfigurationId).toBe("ask");
  const template = freezeConfigurationTemplate(restricted, { projectId: "72e34bc3-7bbd-4d45-b38b-f941ff856424", entryId: "agent", projectVersion: "1.0.0", sourceHash: "0".repeat(64) });
  expect(JSON.stringify(template)).not.toContain("privateBuild");
  expect(template.profilePolicy?.profiles.map(profile => profile.key)).toEqual(["ask"]);
  expect(publication.configurations).toHaveLength(2);
});
