import type { AgentToolSet, McpServerDefinition } from "steamharness";
import type { DeveloperAssistantPermissionPolicy } from "./interface";
import { workflow } from "./workflow-runtime";

const environmentKeys = ["STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL", "STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN"];
const rawDefinition = workflow.getEnv("STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER");
const environment: NodeJS.ProcessEnv = Object.fromEntries(environmentKeys.map(key => [key, workflow.getEnv(key)]));

// Capability credentials belong only to the control child, never to coding-tool shells.
for (const key of ["STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER", ...environmentKeys]) delete process.env[key];

const toolNames = new Set(["studio_state", "get_related_projects", "open_file", "get_diagnostics", "set_theme", "open_terminal", "show_view"]);

export async function createStudioControlTools(approve: (toolId: string, args: unknown) => Promise<void>, permissionPolicy: DeveloperAssistantPermissionPolicy,
  enabled: (toolId: string) => boolean): Promise<AgentToolSet> {
  if (!rawDefinition) return { tools: [] };
  const [definition] = workflow.normalizeMcpServers([JSON.parse(rawDefinition) as McpServerDefinition], {
    allowedInheritedEnvKeys: environmentKeys,
  });
  if (!definition || definition.id !== "workflow-studio"
    || environmentKeys.some(key => !definition.inheritEnvironment?.includes(key))) {
    throw new Error("Invalid Studio Control MCP configuration.");
  }
  const allowed = new Set([...toolNames].filter(name => enabled(`workflow-studio_${name}`)));
  if (!allowed.size) return { tools: [] };
  return { tools: [], catalogs: [{ id: "workflow-studio", allowedTools: [...allowed].map(name => `workflow-studio_${name}`), open: async () => {
    const connection = await workflow.connectMcpServer({ ...definition,
      environment: { ...definition.environment, STEAMHARNESS_STUDIO_CONTROL_PERMISSION_POLICY: permissionPolicy },
    }, { allowedInheritedEnvKeys: environmentKeys, env: environment });
    try {
      const tools = await workflow.createMcpTools({ connection: { ...connection, tools: connection.tools.filter(tool => allowed.has(tool.name)) }, approve });
      return { tools, close: () => connection.close() };
    } catch (error) { await connection.close(); throw error; }
  } }] };
}
