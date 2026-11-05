import { i18n } from "@steamharness/i18n";
import { buildProjectRelease, prepareReleaseRun, resolveProjectDistribution } from "./build";

export async function main(argv: string[]): Promise<number> {
  if (argv.some(arg => ["--help", "-h"].includes(arg))) {
    console.log("steamharness release [directory] [--json] [--inspect]"); return 0;
  }
  const positional = argv.filter(arg => !arg.startsWith("--"));
  if (positional.length > 1 || argv.some(arg => arg.startsWith("--") && !["--json", "--inspect", "--snapshot"].includes(arg))) throw new Error("steamharness release [directory] [--json] [--inspect]");
  const controller = new AbortController(), abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try {
    const options = { signal: controller.signal, progress: (message: string) => process.stderr.write(message + "\n") };
    const result = argv.includes("--snapshot") ? await prepareReleaseRun(positional[0] ?? ".", options) : argv.includes("--inspect") ? await resolveProjectDistribution(positional[0] ?? ".", "auto", options) : await buildProjectRelease(positional[0] ?? ".", options);
    console.log(argv.includes("--json") ? JSON.stringify(result) : `${i18n.language.startsWith("zh") ? "发行结果" : "Release output"}: ${result.directory}`);
    return 0;
  } finally { process.off("SIGINT", abort); process.off("SIGTERM", abort); }
}
