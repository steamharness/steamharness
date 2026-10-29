import { createMemoryHttpServer } from "./server.js";
const server = createMemoryHttpServer({
  token: process.env.STEAMHARNESS_MEMORY_SERVICE_TOKEN ?? "",
  root: process.env.STEAMHARNESS_MEMORY_DATA_DIR ?? "./.data",
});
server.listen(
  Number(process.env.STEAMHARNESS_MEMORY_PORT ?? 7141),
  process.env.STEAMHARNESS_MEMORY_HOST ?? "127.0.0.1",
);
process.on("SIGTERM", () => server.close());
