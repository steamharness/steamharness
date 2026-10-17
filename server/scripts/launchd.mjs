import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadProductionEnv, resolveReleasePaths, resolveServerDataRoot } from "./release-storage.mjs";

loadProductionEnv();

const { serverRoot, repoRoot } = resolveReleasePaths();
const dataRoot = resolveServerDataRoot({ requiredForRelease: true, serverRoot });
const command = process.argv[2] ?? "print";
const label = process.env.STEAMHARNESS_SERVER_LAUNCHD_LABEL?.trim() || "win.hookcode.steamharness.server";
const plistDir = process.env.STEAMHARNESS_SERVER_LAUNCHD_DIR?.trim()
  || path.join(os.homedir(), "Library", "LaunchAgents");
const plistPath = path.join(plistDir, `${label}.plist`);

switch (command) {
  case "print":
    process.stdout.write(renderLaunchdPlist());
    break;
  case "install":
    await mkdir(plistDir, { recursive: true });
    await mkdir(path.join(dataRoot, "logs"), { recursive: true });
    await writeFile(plistPath, renderLaunchdPlist(), "utf8");
    console.log(`wrote ${plistPath}`);
    console.log(`launchctl bootstrap gui/$(id -u) ${plistPath}`);
    break;
  case "uninstall":
    await rm(plistPath, { force: true });
    console.log(`removed ${plistPath}`);
    console.log(`launchctl bootout gui/$(id -u) ${label}`);
    break;
  case "status":
    try {
      const contents = await readFile(plistPath, "utf8");
      console.log(JSON.stringify({ exists: true, path: plistPath, bytes: contents.length }, null, 2));
    } catch {
      console.log(JSON.stringify({ exists: false, path: plistPath }, null, 2));
    }
    break;
  default:
    console.error("Usage: node scripts/launchd.mjs <print|install|uninstall|status>");
    process.exit(1);
}

function renderLaunchdPlist() {
  const stdoutPath = path.join(dataRoot, "logs", "launchd.stdout.log");
  const stderrPath = path.join(dataRoot, "logs", "launchd.stderr.log");

  // launchd should point back at the repo root so production boots
  // resolve .env.production before any checked-in dev defaults.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(path.join(serverRoot, "dist", "index.js"))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(serverRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>STEAMHARNESS_REPO_ROOT</key>
    <string>${escapeXml(repoRoot)}</string>
    <key>STEAMHARNESS_SERVER_DATA_DIR</key>
    <string>${escapeXml(dataRoot)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
