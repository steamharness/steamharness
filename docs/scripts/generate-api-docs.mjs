import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * The Docusaurus OpenAPI plugin logs one green line per file it touches —
 * `Successfully created "<path>"` for `gen-api-docs`, `Cleanup succeeded for
 * "<path>"` for `clean-api-docs`. The spec here has ~3060 generated artifacts,
 * so the create lines alone were over 90% of the Docs build job log, and they
 * say nothing a reader cannot read off the OpenAPI document itself. The plugin
 * has no quiet flag, so run both commands and drop those lines from their
 * stdout. Every other line, and the whole of stderr, still reaches the log —
 * `clean-api-docs` reports its per-file failures there, so a failure is never
 * hidden.
 */
const ARTIFACT_LINE = /^(?:Successfully created|Cleanup succeeded for) "/u;

export function isArtifactLine(line) {
  return ARTIFACT_LINE.test(line);
}

export function createArtifactFilter(onSummary) {
  let suppressed = 0;
  let buffered = "";
  return {
    push(chunk) {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      const kept = [];
      for (const line of lines) {
        if (isArtifactLine(line)) suppressed += 1;
        else kept.push(line);
      }
      return kept.length > 0 ? `${kept.join("\n")}\n` : "";
    },
    flush() {
      const remainder = buffered;
      buffered = "";
      return remainder;
    },
    report() {
      return onSummary(suppressed);
    },
  };
}

async function runDocusaurusArtifactStep(root, args, describe) {
  const executable = path.join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "docusaurus.cmd" : "docusaurus",
  );
  const child = spawn(executable, args, { cwd: root, stdio: ["inherit", "pipe", "inherit"] });
  child.stdout.setEncoding("utf8");

  const filter = createArtifactFilter((suppressed) => {
    if (suppressed > 0) process.stdout.write(`${describe(suppressed)}\n`);
  });
  child.stdout.on("data", (chunk) => {
    const kept = filter.push(chunk);
    if (kept) process.stdout.write(kept);
  });

  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const remainder = filter.flush();
  if (remainder) process.stdout.write(remainder);
  filter.report();
  if (code !== 0) throw new Error(`docusaurus ${args.join(" ")} exited with code ${code}`);
}

export async function generateApiDocs(options = {}) {
  const root = path.resolve(options.root ?? path.resolve(import.meta.dirname, ".."));
  await runDocusaurusArtifactStep(root, ["clean-api-docs", "all"], (n) => `Cleaned ${n} generated OpenAPI files.`);
  await runDocusaurusArtifactStep(root, ["gen-api-docs", "all"], (n) => `Generated ${n} OpenAPI docs artifacts.`);
  return { root };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await generateApiDocs();
}
