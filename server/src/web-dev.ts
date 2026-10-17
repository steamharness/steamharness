import type { Server as HttpServer } from "node:http";
import path from "node:path";

export function createWebDevServerOptions({
  webRoot,
  server,
  env = process.env,
}: {
  webRoot: string;
  server: HttpServer;
  env?: NodeJS.ProcessEnv;
}) {
  return {
    root: webRoot,
    configFile: path.join(webRoot, "vite.config.ts"),
    appType: "custom" as const,
    server: {
      middlewareMode: true as const,
      hmr: env.WORKFLOW_SERVER_HMR === "0" ? false as const : { server },
    },
  };
}
