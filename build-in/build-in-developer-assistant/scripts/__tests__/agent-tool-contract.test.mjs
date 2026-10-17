import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_CONTRACT,
  assertSdkMatchesCore,
  checkAgentToolContract,
  compareAgentToolContract,
  renderAgentToolContract,
} from "../agent-tool-contract.mjs";

/**
 * The document has to describe the tool shape an assistant writes, and that
 * shape belongs to the SDK. These tests are what keeps the two together: a pi
 * upgrade that renames a member turns into a red build here rather than into
 * code that no longer compiles in a user's project.
 */
describe("the agent tool contract in the generator skill", () => {
  it("still describes what the installed SDK declares", async () => {
    await expect(compareAgentToolContract()).resolves.toEqual([]);
  });

  it("is the document's block, not a second copy of it", async () => {
    const { differences, expected } = await checkAgentToolContract();

    expect(differences).toEqual([]);
    expect(expected).toContain("interface AgentTool");
  });

  it("reports a disagreement by member name, in both directions", async () => {
    // The table is the expectation, so left alone it agrees with itself. A
    // member that moved has to come back as the two names, which is what turns
    // a red build into a one-line fix ("rename label to caption").
    const drifted = structuredClone(AGENT_TOOL_CONTRACT);
    drifted.AgentTool.members = drifted.AgentTool.members
      .filter((member) => member.source !== "label: string");
    drifted.AgentTool.members.push({ source: "caption: string" });

    await expect(compareAgentToolContract(drifted)).resolves.toEqual([
      'AgentTool no longer declares "caption: string"',
      'AgentTool declares "label: string", which the contract table does not list',
    ]);
  });

  it("shows every member a project has to write", async () => {
    const block = await renderAgentToolContract();

    for (const member of [
      "name: string",
      "label: string",
      "description: string",
      "parameters: TParameters",
      "execute: (",
      "content:",
      "details: TDetails",
    ]) {
      expect(block).toContain(member);
    }
  });
});

describe("the SDK the contract describes", () => {
  // On the release channels there is no sibling Core checkout to read the SDK
  // from, so this project's own copy is what gets read — and only its version
  // says whether it is the one Core builds against.
  it("is the version workflow-code declares", async () => {
    for (const packageName of ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core"]) {
      const { declared, installed } = await assertSdkMatchesCore(packageName);

      expect(declared).toBe("1.2.0");
      expect(installed).toBe("1.2.0");
    }
  });

  it("cannot describe an SDK workflow-code does not declare", async () => {
    await expect(assertSdkMatchesCore("@earendil-works/pi-unknown")).rejects
      .toThrow(/no longer declares @earendil-works\/pi-unknown/u);
  });
});
