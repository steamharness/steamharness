import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, realpath } from "node:fs/promises";
import path from "node:path";
import { createServerAgentMemoryProvider } from "steamharness";
import type { Project } from "./workflow-types";
import type { WebConnection } from "./runtime";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const directoryWrites = new Map<string, Promise<void>>();
/** Lives in the trusted CLI host. No management credential is serialized to a worker. */
export class WebAccountMemory {
  private capabilityAccount?: string;
  private capabilityCache = new Map<string, any>();
  constructor(
    private storageDir: string,
    private connection: () => WebConnection | undefined,
    private userId: () => string | undefined,
  ) {}
  private async request(
    connection: WebConnection,
    endpoint: string,
    body?: unknown,
  ) {
    const request = (cookie: boolean) => fetch(`${connection.serverUrl}/api/me${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(cookie
          ? { Cookie: connection.memorySessionCookie! }
          : { Authorization: `Bearer ${connection.memoryToken}` }),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    // A project API key cannot authorize account memory. Only the trusted
    // host's existing session can replace a missing/expired manager token.
    let r = await request(!connection.memoryToken);
    if (r.status === 401 && connection.memoryToken && connection.memorySessionCookie) {
      await r.body?.cancel();
      r = await request(true);
    }
    const b = await r.json();
    if (!r.ok || b.errCode !== 0)
      throw Object.assign(new Error(b.errMessage ?? "Memory request failed."), {
        status: r.status,
      });
    return b.data;
  }
  private current(c: WebConnection, userId: string | undefined = this.userId()) {
    return (
      this.connection()?.memoryToken === c.memoryToken &&
      this.connection()?.memorySessionCookie === c.memorySessionCookie &&
      this.connection()?.serverUrl === c.serverUrl &&
      this.connection()?.accessToken === c.accessToken &&
      !!userId && this.userId() === userId
    );
  }
  async grant(project: Project, readOnly = false) {
    const connection = this.connection();
    const userId = this.userId();
    if (!(connection?.memoryToken || connection?.memorySessionCookie) || !userId)
      throw Object.assign(new Error("Account memory authorization is missing. Verify your account authorization."), { status: 401 });
    const directory = await realpath(
      project.assistant?.workdir ?? project.folderPath,
    );
    if (!this.current(connection, userId)) throw new Error("Account changed.");
    let projectId = project.assistant ? undefined : project.id;
    if (project.assistant)
      try {
        const manifest = JSON.parse(
          await readFile(path.join(directory, "steamharness.json"), "utf8"),
        );
        projectId = manifest.id;
      } catch {}
    let grant: any;
    if (projectId)
      try {
        grant = await this.request(connection, "/memory/grants", {
          scope: `project:${projectId}`,
          readOnly,
        });
      } catch (e) {
        if ((e as any).status !== 404) throw e;
      }
    if (!grant) {
      // Serialize registry creation so concurrent inspect/run requests reuse the same identity.
      const file = path.join(this.storageDir, "memory-directories.json");
      const next = (directoryWrites.get(file) ?? Promise.resolve()).then(
        async () => {
          await mkdir(this.storageDir, { recursive: true, mode: 0o700 });
          let map: Record<string, string> = {};
          try {
            map = JSON.parse(await readFile(file, "utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          const key = hash(
            `${connection.serverUrl}:${userId}:${directory}`,
          );
          const directoryId = map[key] ?? randomUUID();
          if (!map[key]) {
            map[key] = directoryId;
            const temp = file + "." + randomUUID();
            await writeFile(temp, JSON.stringify(map), { mode: 0o600 });
            await rename(temp, file);
          }
          if (!this.current(connection, userId)) throw new Error("Account changed.");
          return this.request(connection, "/memory/grants", {
            directory: true,
            directoryId,
            label: path.basename(directory),
            readOnly,
          });
        },
      );
      directoryWrites.set(
        file,
        next.then(
          () => undefined,
          () => undefined,
        ),
      );
      grant = await next;
    }
    if (!this.current(connection, userId)) throw new Error("Account changed.");
    return {
      ...grant,
      serverUrl: connection.serverUrl,
      outboxDirectory: path.join(
        this.storageDir,
        "memory-outbox",
        hash(`${connection.serverUrl}:${userId}:${grant.scope}`),
      ),
    };
  }
  async call(project: Project, action: string, input: any = {}) {
    const connection = this.connection();
    const userId = this.userId();
    const account = connection && (connection.memoryToken || connection.memorySessionCookie)
      ? hash(JSON.stringify([connection.serverUrl, userId, connection.accessToken, connection.memoryToken, connection.memorySessionCookie]))
      : undefined;
    if (account !== this.capabilityAccount) {
      this.capabilityAccount = account;
      this.capabilityCache.clear();
    }
    if (!(connection?.memoryToken || connection?.memorySessionCookie) || !userId) {
      throw Object.assign(new Error("Account memory authorization is missing. Verify your account authorization."), { status: 401 });
    }
    let cached: any;
    const provider = createServerAgentMemoryProvider({
      serverUrl: connection.serverUrl,
      getGrant: async () => (cached ??= await this.grant(project)),
    });
    const check = () => {
      if (!this.current(connection, userId)) throw new Error("Account changed.");
    };
    let result: unknown;
    switch (action) {
      case "capabilities": {
        const context = hash(JSON.stringify([
          project.id,
          project.folderPath,
          project.assistant?.workdir,
        ]));
        try {
          result = await provider.capabilities();
          check();
          this.capabilityCache.set(context, result);
        } catch (e) {
          check();
          if ([401, 403, 404].includes((e as any).status)) {
            this.capabilityCache.delete(context);
            throw e;
          }
          if (!this.capabilityCache.has(context)) throw e;
          result = { ...this.capabilityCache.get(context), status: "unavailable" };
        }
        break;
      }
      case "list":
        result = await provider.list({
          scope: input.scope === "global" ? "global" : "current",
          query: input.query,
          origin: input.origin,
          cursor: input.cursor,
          pageSize: 20,
        });
        break;
      case "get":
        result = await provider.get(String(input.id));
        break;
      case "remember":
        result = await provider.remember({
          scope: input.scope === "global" ? "global" : "current",
          content: input.content,
          operationId: input.operationId,
        });
        break;
      case "update":
        result = await provider.update({
          id: input.id,
          content: input.content,
          version: input.version,
          operationId: input.operationId,
        });
        break;
      case "forget":
        result = await provider.forget({
          id: input.id,
          operationId: input.operationId,
        });
        break;
      case "clear": {
        const grant = await this.grant(project);
        result = await this.request(
          { serverUrl: connection.serverUrl, accessToken: connection.accessToken, memoryToken: grant.token },
          "/memory/clear",
          {
            scope: input.scope === "global" ? "global" : grant.scope,
            operationId: input.operationId,
          },
        );
        break;
      }
      default:
        throw new Error("Unknown memory operation.");
    }
    check();
    return result;
  }
}
