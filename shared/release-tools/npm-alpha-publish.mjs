import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const ALPHA_VERSION_PATTERN = /^\d+\.\d+\.\d+-\d{11}$/u;

export function compareNpmAlphaVersions(left, right) {
  if (!ALPHA_VERSION_PATTERN.test(String(left)) || !ALPHA_VERSION_PATTERN.test(String(right))) {
    throw new Error(`Cannot compare invalid npm alpha versions: ${left}, ${right}`);
  }
  const leftParts = String(left).split(/[.-]/u).map(Number);
  const rightParts = String(right).split(/[.-]/u).map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export async function calculateTarballIntegrity(filePath) {
  const digest = createHash("sha512").update(await readFile(filePath)).digest("base64");
  return `sha512-${digest}`;
}

export async function publishNpmAlpha(options) {
  const root = path.resolve(options.root ?? process.cwd());
  const packageName = String(options.packageName ?? "").trim();
  const version = String(options.version ?? "").trim();
  const distTag = normalizeDistTag(options.distTag ?? "alpha");
  if (!packageName) throw new Error("npm alpha package name is required.");
  if (!ALPHA_VERSION_PATTERN.test(version)) throw new Error(`npm alpha version is invalid: ${version}`);
  const tarballPath = await resolveTarballPath(root, options.tarballPath ?? ".release");
  const expectedIntegrity = await calculateTarballIntegrity(tarballPath);
  const runCommand = options.runCommand ?? run;

  const currentChannelVersion = await readPublishedChannelVersion({ packageName, distTag, runCommand });
  if (currentChannelVersion && compareNpmAlphaVersions(currentChannelVersion, version) > 0) {
    throw new Error(
      `${packageName}@${version} is superseded by the npm ${distTag} dist-tag ${currentChannelVersion}.`,
    );
  }

  const optionsWithDefaults = {
    attempts: options.attempts ?? 80,
    retryDelayMs: options.retryDelayMs ?? 15_000,
    delayImpl: options.delayImpl ?? delay,
    log: options.log ?? ((message) => process.stderr.write(`${message}\n`)),
  };

  let publishedIntegrity = await readPublishedIntegrity({ packageName, version, runCommand });
  let uploaded = false;
  if (publishedIntegrity === undefined) {
    try {
      await runCommand("npm", ["publish", tarballPath, "--access", "public", "--tag", distTag]);
      uploaded = true;
    } catch (error) {
      // 上传报错未必等于没发出去：先读回一次，读得到就按"已经在 registry 上"处理。
      publishedIntegrity = await readPublishedIntegrity({ packageName, version, runCommand });
      if (publishedIntegrity === undefined) throw error;
    }
  }

  if (!uploaded) {
    // 版本已经发布过。tag 账本按提交分配版本，所以这只可能来自同一提交的早先一次
    // 运行——它已经把制品传上去了。重新构建的 tarball 不是逐字节可复现的，内容不同
    // 属于正常现象，registry 上那一份才是这个版本的正本；这里只提示，不阻断后续的
    // 下游同步。真正需要逐字比对的是我们自己刚上传的那一份，见下。
    if (publishedIntegrity !== expectedIntegrity) {
      optionsWithDefaults.log(
        `[npm-alpha-publish] ${packageName}@${version} is already published with a different tarball; keeping the registry copy.`,
      );
    }
    await runCommand("npm", ["dist-tag", "add", `${packageName}@${version}`, distTag]);
    return { packageName, version, distTag, integrity: publishedIntegrity, tarballPath, reused: true };
  }

  // npm 的发布是异步处理的：`npm publish` 成功只代表上传完成，registry 在读回前会
  // 先返回 "being processed"，实测可达十几分钟。等待窗口必须覆盖这段延迟，否则作业
  // 会在 tarball 已经落库之后失败，把一个已发布的版本留在没有下游同步的状态里。
  const { attempts, retryDelayMs, delayImpl, log } = optionsWithDefaults;
  for (let attempt = 1; publishedIntegrity === undefined && attempt <= attempts; attempt += 1) {
    if (attempt > 1) await delayImpl(retryDelayMs);
    if (attempt % 4 === 1) log(`[npm-alpha-publish] waiting for ${packageName}@${version} to become visible (attempt ${attempt}/${attempts}).`);
    publishedIntegrity = await readPublishedIntegrity({ packageName, version, runCommand });
  }
  if (publishedIntegrity === undefined) {
    throw new Error(
      `${packageName}@${version} is not visible from npm after ${attempts} readbacks `
      + `(${Math.round((attempts - 1) * retryDelayMs / 60_000)} minutes); it may still be processing. `
      + "Re-run this pipeline: an already published dated version is reused, not republished.",
    );
  }
  if (publishedIntegrity !== expectedIntegrity) {
    throw new Error(`${packageName}@${version} was uploaded but read back with different tarball integrity.`);
  }

  await runCommand("npm", ["dist-tag", "add", `${packageName}@${version}`, distTag]);
  return { packageName, version, distTag, integrity: expectedIntegrity, tarballPath, reused: false };
}

function normalizeDistTag(value) {
  const distTag = String(value).trim();
  if (!/^[a-z][a-z0-9._-]*$/u.test(distTag)) {
    throw new Error(`npm dist-tag is invalid: ${value}`);
  }
  return distTag;
}

async function readPublishedChannelVersion({ packageName, distTag, runCommand }) {
  try {
    const output = await runCommand("npm", ["view", `${packageName}@${distTag}`, "version", "--json"], {
      capture: true,
    });
    const value = JSON.parse(output);
    if (typeof value !== "string" || !ALPHA_VERSION_PATTERN.test(value)) {
      throw new Error(`npm returned invalid ${distTag} dist-tag for ${packageName}.`);
    }
    return value;
  } catch (error) {
    if (/E404|404 Not Found|No match found|is not in this registry/iu.test(String(error))) return undefined;
    throw error;
  }
}

async function resolveTarballPath(root, value) {
  const candidate = path.resolve(root, value);
  if (candidate.endsWith(".tgz")) return candidate;
  const entries = (await readdir(candidate, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"));
  if (entries.length !== 1) {
    throw new Error(`Expected exactly one npm tarball in ${candidate}, found ${entries.length}.`);
  }
  return path.join(candidate, entries[0].name);
}

async function readPublishedIntegrity({ packageName, version, runCommand }) {
  try {
    const output = await runCommand("npm", ["view", `${packageName}@${version}`, "dist.integrity", "--json"], {
      capture: true,
    });
    const value = JSON.parse(output);
    if (typeof value !== "string" || !value.startsWith("sha512-")) {
      throw new Error(`npm returned invalid integrity for ${packageName}@${version}.`);
    }
    return value;
  } catch (error) {
    if (/E404|404 Not Found|is not in this registry/iu.test(String(error))) return undefined;
    throw error;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    }
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(stdout)
      : reject(new Error(`${command} ${args.join(" ")} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const packageName = process.argv[2];
  const version = process.argv[3];
  const tarballPath = process.argv[4] ?? ".release";
  const distTag = process.argv[5] ?? "alpha";
  const result = await publishNpmAlpha({ packageName, version, tarballPath, distTag });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
