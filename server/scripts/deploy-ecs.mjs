import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REMOTE_HOST = "60.205.8.151";
const REMOTE_PORT = "22";
const EXPECTED_FINGERPRINT = "SHA256:ErClJwyZdPzwEU05QWHex4Od9ytRxbn5iAw4Mt+GVcU";
const REMOTE_ROOT = "/srv/workflow-release";
const IMAGES = ["postgres:15-alpine", "postgres:18-alpine", "nginx:1.27-alpine", "certbot/certbot:v2.11.0"];

export async function withRemote(options, action) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-ecs-ssh-"));
  const key = path.join(tempRoot, "id_ed25519");
  const knownHosts = path.join(tempRoot, "known_hosts");
  try {
    await writeSecretFile(key, options.sshKey ?? process.env.WORKFLOW_REMOTE_SSH_KEY);
    await verifyFingerprint(knownHosts);
    return await action(createRemoteClient({ ...options, key, knownHosts }));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export function createRemoteClient({ key, knownHosts, host = REMOTE_HOST, port = REMOTE_PORT, user = "root", root = "/srv/workflow-release" }) {
  if (host !== REMOTE_HOST || String(port) !== REMOTE_PORT) throw new Error("ECS deployment is restricted to 60.205.8.151:22.");
  if (path.resolve(root) !== REMOTE_ROOT) throw new Error(`ECS deployment root is fixed at ${REMOTE_ROOT}.`);
  const ssh = ["-i", key, "-p", String(port), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`, `${user}@${host}`];
  const execute = (command) => run("ssh", [...ssh, command]);
  const output = (command) => run("ssh", [...ssh, command], { capture: true });
  const remote = (command, args = []) => execute(`${shellQuote(path.join(root, "bin", "ecs-runtime-agent.sh"))} ${shellQuote(command)} ${args.map(shellQuote).join(" ")}`);
  const upload = (source, destination) => run("rsync", ["-a", "--chmod=F600,D755", "-e", `ssh -i ${shellQuote(key)} -p ${port} -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${shellQuote(knownHosts)}`, source, `${user}@${host}:${destination}`]);
  return { root, remote, execute, output, upload, ssh, host, user };
}

export function getEcsComposeSource(repoRoot) {
  return `${path.join(repoRoot, "docker", "ecs")}${path.sep}`;
}

export async function deployEcs(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? path.resolve(import.meta.dirname, ".."));
  const root = options.remoteRoot ?? process.env.WORKFLOW_REMOTE_ROOT ?? REMOTE_ROOT;
  return withRemote({ ...options, root }, async (client) => {
    const command = options.command ?? "";
    if (command === "bootstrap") {
      await client.execute(`mkdir -p ${shellQuote(root)}/compose ${shellQuote(root)}/bin ${shellQuote(root)}/incoming ${shellQuote(root)}/runtime`);
      await client.upload(getEcsComposeSource(repoRoot), `${root}/compose/`);
      await client.upload(path.join(repoRoot, "docker", "ecs", "ecs-runtime-agent.sh"), `${root}/bin/ecs-runtime-agent.sh`);
      await client.execute(`chmod 700 ${shellQuote(root)}/bin/ecs-runtime-agent.sh`);
      await uploadOptionalEnv(client, root, "WORKFLOW_ECS_ENV_FILE", ".env");
      await client.remote("bootstrap");
      return { command };
    }
    if (command === "prepare-images") return prepareImages(client);
    if (command === "ensure") return client.remote("ensure", [options.target ?? "release"]);
    if (command === "status" || command === "migrate") return client.remote(command);
    if (command === "certificate") return client.remote("certificate", [options.email ?? process.env.WORKFLOW_ACME_EMAIL ?? ""]);
    if (command === "deploy-server") {
      const archive = path.resolve(options.archive);
      const remoteArchive = `${root}/incoming/${path.basename(archive)}`;
      await client.upload(archive, remoteArchive);
      await uploadRuntimeEnv(client, root, options.channel);
      await client.remote("deploy-server", [options.channel, remoteArchive, options.releaseId]);
      return { command, channel: options.channel, releaseId: options.releaseId };
    }
    throw new Error(`Unknown ECS deployment command: ${command}`);
  });
}

async function uploadRuntimeEnv(client, root, channel) {
  const variable = channel === "alpha" ? "WORKFLOW_ALPHA_RUNTIME_ENV_FILE" : "WORKFLOW_STABLE_RUNTIME_ENV_FILE";
  await uploadOptionalEnv(client, root, variable, `runtime/${channel}.env`);
}

async function uploadOptionalEnv(client, root, variable, target) {
  const source = process.env[variable];
  if (!source) return;
  if (!existsSync(source)) throw new Error(`${variable} must point to a CI file variable.`);
  await client.upload(source, `${root}/${target}`);
}

async function prepareImages(client) {
  for (const image of IMAGES) {
    const exists = await client.remote("image-check", [image]).then(() => true, () => false);
    if (exists) continue;
    const pulled = await client.remote("image-pull", [image]).then(() => true, () => false);
    if (pulled) {
      await client.output(`${shellQuote(path.join(client.root, "bin", "ecs-runtime-agent.sh"))} image-id ${shellQuote(image)}`);
      continue;
    }
    await transferImageFromFallback(client, image);
  }
  const manifestScript = 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => { const images=JSON.parse(data).map(i => ({tags:i.RepoTags,id:i.Id,digests:i.RepoDigests,platform:i.Os+"/"+i.Architecture})); if(images.some(i=>i.platform!=="linux/amd64")) process.exit(1); require("node:fs").writeFileSync(process.argv[1], JSON.stringify(images,null,2)+"\\n"); });';
  await client.execute(`docker image inspect ${IMAGES.map(shellQuote).join(" ")} | node -e ${shellQuote(manifestScript)} ${shellQuote(path.join(client.root, "image-manifest.json"))}`);
  return { images: IMAGES };
}

async function transferImageFromFallback(client, image) {
  const fallbackConfig = getImageFallbackConfig();
  const fallback = fallbackConfig.host;
  const fallbackTempRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-ecs-fallback-"));
  try {
    const fallbackKey = fallbackConfig.key;
    const fallbackKeyPath = fallbackKey ? path.join(fallbackTempRoot, "id_ed25519") : "";
    if (fallbackKeyPath) await writeSecretFile(fallbackKeyPath, fallbackKey);
    const fallbackArgs = buildFallbackSshArgs({
      host: fallback,
      port: fallbackConfig.port,
      user: fallbackConfig.user,
      keyPath: fallbackKeyPath,
    });
    const local = await run("docker", ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image], { allowFailure: true });
    if (local.stdout.trim() !== "linux/amd64") local.code = 1;
    let fallbackImage = { code: 0 };
    if (local.code !== 0) {
      const inspect = `docker image inspect --format ${shellQuote("{{.Os}}/{{.Architecture}} ")} ${shellQuote(image)}`;
      fallbackImage = await run("ssh", [...fallbackArgs, inspect], { allowFailure: true });
      if (fallbackImage.code !== 0 || fallbackImage.stdout.trim() !== "linux/amd64") {
        await run("ssh", [...fallbackArgs, `docker pull --platform linux/amd64 ${shellQuote(image)}`]);
        fallbackImage = await run("ssh", [...fallbackArgs, inspect], { allowFailure: true });
        if (fallbackImage.code !== 0 || fallbackImage.stdout.trim() !== "linux/amd64") throw new Error(`Fallback source does not contain linux/amd64 image ${image} after pull.`);
      }
    }
    const sourceId = local.code === 0
      ? String((await execFileAsync("docker", ["image", "inspect", "--format", "{{.Id}}", image])).stdout).trim()
      : String((await execFileAsync("ssh", [...fallbackArgs, `docker image inspect --format ${shellQuote("{{.Id}}")} ${shellQuote(image)}`])).stdout).trim();
    const imageFormat = "{{json .RootFS.Layers}}\\n{{json .Config}}";
    const sourceFingerprint = local.code === 0
      ? String((await execFileAsync("docker", ["image", "inspect", "--format", imageFormat, image])).stdout)
      : String((await execFileAsync("ssh", [...fallbackArgs, `docker image inspect --format ${shellQuote(imageFormat)} ${shellQuote(image)}`])).stdout);
    const saveCommand = getImageSaveCommand(local.code === 0, fallbackArgs, image);
    const save = spawn(saveCommand.command, saveCommand.args, { stdio: ["ignore", "pipe", "inherit"] });
    const load = spawn("ssh", client.ssh.concat(["docker", "load"]), { stdio: [save.stdout, "inherit", "inherit"] });
    const [saveCode, loadCode] = await Promise.all([exitCode(save), exitCode(load)]);
    if (saveCode !== 0 || loadCode !== 0) throw new Error(`Failed to transfer image ${image} from ${fallback}.`);
    const targetId = String((await client.output(`${shellQuote(path.join(client.root, "bin", "ecs-runtime-agent.sh"))} image-id ${shellQuote(image)}`)).stdout).trim();
    const targetFingerprint = String((await client.output(`docker image inspect --format ${shellQuote(imageFormat)} ${shellQuote(image)}`)).stdout);
    if (!sourceFingerprint || normalizeImageFingerprint(sourceFingerprint) !== normalizeImageFingerprint(targetFingerprint)) {
      throw new Error(`Image content mismatch for ${image}: source ${sourceId || "unknown"}, target ${targetId || "unknown"}.`);
    }
    if (sourceId !== targetId) {
      process.stdout.write(`[ecs] Image ID changed during save/load for ${image}; config and layers fingerprint verified.\n`);
    }
  } finally {
    await rm(fallbackTempRoot, { recursive: true, force: true });
  }
}

export function getImageSaveCommand(local, sshArgs, image) {
  return local
    ? { command: "docker", args: ["save", image] }
    : { command: "ssh", args: [...sshArgs, `docker save ${shellQuote(image)}`] };
}

export function getImageFallbackConfig(env = process.env) {
  return {
    host: env.WORKFLOW_IMAGE_FALLBACK_HOST ?? "win-linux",
    port: env.WORKFLOW_IMAGE_FALLBACK_PORT,
    user: env.WORKFLOW_IMAGE_FALLBACK_USER,
    key: env.WORKFLOW_IMAGE_FALLBACK_SSH_KEY,
  };
}

export function buildFallbackSshArgs({ host, port, user, keyPath }) {
  if (!port && !user && !keyPath) return [host];
  const args = [];
  if (keyPath) args.push("-i", keyPath, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new");
  if (port) args.push("-p", String(port));
  args.push(`${user || "root"}@${host}`);
  return args;
}

export function normalizeImageFingerprint(value) {
  const [layers, config] = String(value).trim().split(/\n/u);
  if (!layers || !config) return "";
  return `${JSON.stringify(JSON.parse(layers))}\n${stableJson(JSON.parse(config))}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function verifyFingerprint(knownHosts) {
  const { stdout } = await execFileAsync("ssh-keyscan", ["-p", REMOTE_PORT, "-t", "ed25519", REMOTE_HOST], { maxBuffer: 1024 * 1024 });
  await writeFile(knownHosts, stdout, "utf8");
  const { stdout: fingerprint } = await execFileAsync("sh", ["-c", `ssh-keygen -lf ${shellQuote(knownHosts)} -E sha256`]);
  if (!fingerprint.includes(EXPECTED_FINGERPRINT)) throw new Error("ECS SSH host fingerprint does not match the pinned value.");
}

export function decodePrivateKey(value) {
  let contents = String(value ?? "").trim();
  if (!contents) throw new Error("WORKFLOW_REMOTE_SSH_KEY is required.");
  if (!contents.includes("-----BEGIN")) {
    const compact = contents.replace(/\s+/gu, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(compact)) throw new Error("WORKFLOW_REMOTE_SSH_KEY must be a PEM key or Base64-encoded PEM key.");
    try {
      contents = Buffer.from(compact, "base64").toString("utf8");
    } catch {
      throw new Error("WORKFLOW_REMOTE_SSH_KEY Base64 value is invalid.");
    }
  }
  if (!contents.includes("-----BEGIN")) throw new Error("WORKFLOW_REMOTE_SSH_KEY does not contain a private key.");
  return `${contents}\n`;
}

async function writeSecretFile(filePath, value) {
  const raw = String(value ?? "").trim();
  const contents = decodePrivateKey(existsSync(raw) ? await readFile(raw, "utf8") : raw);
  await writeFile(filePath, contents, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const capture = options.capture || options.allowFailure;
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: capture ? ["ignore", "pipe", options.capture ? "pipe" : "inherit"] : "inherit" });
    let stdout = "";
    if (capture) child.stdout.on("data", (chunk) => { stdout += chunk; });
    if (options.capture) child.stderr.on("data", () => {});
    child.once("error", reject);
    child.once("exit", (code) => options.allowFailure ? resolve({ code, stdout }) : code === 0 ? resolve({ code, stdout }) : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)));
  });
}

function exitCode(child) { return new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); }

function parseArgs(argv) {
  const [command, target, archive, releaseId] = argv.filter((value) => value !== "--");
  if (command === "deploy-server") return { command, channel: target, archive, releaseId };
  if (command === "ensure") return { command, target };
  if (command === "certificate") return { command, email: target };
  return { command };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "deploy-server" && (!options.channel || !options.archive || !options.releaseId)) throw new Error("Usage: deploy-ecs.mjs deploy-server <stable|alpha> <archive> <release-id>");
  const result = await deployEcs({ repoRoot: path.resolve(import.meta.dirname, ".."), ...options });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
