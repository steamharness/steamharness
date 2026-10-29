import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  // SQLite exists only as node:sqlite; the bare sqlite name is a different package.
  removeNodeProtocol: false,
});
