import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { MemoryStore, MemoryError } from "./store.js";
import { extract } from "./extract.js";
export function createMemoryHttpServer(options: {
  token: string;
  root: string;
  automatic?: boolean;
  extractTurn?: typeof extract;
}) {
  const { token, root } = options;
  const automatic =
    options.automatic ??
    !!(
      process.env.STEAMHARNESS_MEMORY_MODEL &&
      process.env.STEAMHARNESS_MEMORY_MODEL_BASE_URL &&
      process.env.STEAMHARNESS_MEMORY_MODEL_API_KEY
    );
  const extractTurn = options.extractTurn ?? extract;
  if (token.length < 32)
    throw new Error(
      "Memory service token must contain at least 32 characters.",
    );
  return createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    let store: MemoryStore | undefined;
    try {
      const supplied = Buffer.from(
          (req.headers.authorization ?? "").replace(/^Bearer /, ""),
        ),
        expected = Buffer.from(token);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        throw new MemoryError(401, "Unauthorized.");
      if (req.url === "/health" && req.method === "GET") {
        store = new MemoryStore(root, "health");
        res.end(
          JSON.stringify({ ok: true, fts: true, embedding: false, automatic }),
        );
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/call")
        throw new MemoryError(404, "Not found.");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 300000)
          throw new MemoryError(413, "Request too large.");
        chunks.push(chunk);
      }
      let b: any;
      try {
        b = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new MemoryError(400, "Invalid JSON.");
      }
      if (
        !b ||
        typeof b.account !== "string" ||
        !b.account ||
        b.account.length > 300
      )
        throw new MemoryError(400, "Account namespace is required.");
      if (
        b.scopes &&
        (!Array.isArray(b.scopes) ||
          b.scopes.length > 2000 ||
          b.scopes.some((s: unknown) => typeof s !== "string"))
      )
        throw new MemoryError(400, "Invalid scopes.");
      store = new MemoryStore(root, b.account);
      let data: unknown;
      switch (b.method) {
        case "list":
          data = store.list(b.scopes, b.options);
          break;
        case "get":
          data = store.get(b.id, b.scopes);
          break;
        case "locate":
          data = store.locate(b.id, b.scopes);
          break;
        case "recall":
          data = store.recall(b.scopes, String(b.query ?? ""));
          break;
        case "counts":
          data = store.counts(b.scopes);
          break;
        case "state":
          data = Object.fromEntries(
            b.scopes.map((s: string) => [s, store!.state(s)]),
          );
          break;
        case "apply":
          data = store.apply(b.operation);
          break;
        case "stageTurn":
          data = store.stageTurn(b.turn);
          break;
        case "completeTurn":
          store.completeTurn(b.turnId);
          data = {};
          break;
        case "extract":
          if (!automatic)
            throw new MemoryError(
              503,
              "Memory extraction model is not configured.",
            );
          data = await extractTurn(store, store.getTurn(b.turnId));
          break;
        default:
          throw new MemoryError(400, "Unknown operation.");
      }
      res.end(JSON.stringify({ data }));
    } catch (e) {
      res.statusCode = e instanceof MemoryError ? e.status : 503;
      res.end(
        JSON.stringify({
          error:
            e instanceof MemoryError
              ? e.message
              : "Memory service unavailable.",
        }),
      );
    } finally {
      store?.close();
    }
  });
}
