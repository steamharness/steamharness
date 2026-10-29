import { createMemoryHttpServer } from "./server.js";
const server = createMemoryHttpServer({
  token: process.env.STEAMHARNESS_MEMORY_SERVICE_TOKEN ?? "",
  root: process.env.STEAMHARNESS_MEMORY_DATA_DIR ?? "./.data",
});
server.listen(
  Number(process.env.STEAMHARNESS_MEMORY_PORT ?? 7141),
  process.env.STEAMHARNESS_MEMORY_HOST ?? "127.0.0.1",
  () => {
    const address = server.address();
    if (address && typeof address !== "string" && process.connected && process.send) {
      process.send({ type: "steamharness:memory-ready", port: address.port }, (error) => {
        if (error) shutdown();
      });
    }
  },
);
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  // Extraction requests may still be waiting on a model after the parent dies.
  const timeout = setTimeout(() => process.exit(0), 5000);
  timeout.unref();
  server.close(() => { clearTimeout(timeout); process.exit(0); });
  server.closeIdleConnections();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
// A killed supervisor must not leave a detached local service behind.
if (process.connected) process.once("disconnect", shutdown);
