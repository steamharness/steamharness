import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listRemoteAlphaVersions } from "./alpha-release.mjs";

const ALPHA_VERSION_PATTERN = /^\d+\.\d+\.\d+-\d{11}$/u;

export function compareAlphaVersions(left, right) {
  const leftParts = String(left).split(/[.-]/u).map(Number);
  const rightParts = String(right).split(/[.-]/u).map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function selectAlphaTagsToPrune(versions, retain = 3) {
  return [...new Set(versions)]
    .filter((version) => ALPHA_VERSION_PATTERN.test(String(version)))
    .sort(compareAlphaVersions)
    .slice(0, -retain);
}

export function selectArtifactJobsToErase(jobs, { jobName, retain = 3 }) {
  return jobs
    .filter((job) => job?.ref === "alpha"
      && job?.name === jobName
      && job?.status === "success"
      && typeof job?.artifacts_file?.filename === "string"
      && job.artifacts_file.filename !== "")
    .sort((left, right) => Number(right.id) - Number(left.id))
    .slice(retain);
}

export async function pruneAlphaReleaseHistory(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const retain = normalizeRetain(options.retain ?? 3);
  const privateToken = String(options.token ?? process.env.WORKFLOW_ALPHA_SYNC_TOKEN ?? "").trim();
  const jobToken = String(process.env.CI_JOB_TOKEN ?? "").trim();
  const token = privateToken || jobToken;
  if (!token) throw new Error("WORKFLOW_ALPHA_SYNC_TOKEN or CI_JOB_TOKEN is required for alpha retention.");
  const headers = privateToken ? { "PRIVATE-TOKEN": token } : { "JOB-TOKEN": token };

  const versions = await listRemoteAlphaVersions({ root, runCommand: options.runCommand ?? run });
  const staleVersions = selectAlphaTagsToPrune(versions, retain);
  for (const version of staleVersions) {
    await deleteTag({ ...options, headers, tag: `alpha/v${version}` });
  }

  const jobs = await listSuccessfulJobs({ ...options, headers });
  const staleJobs = selectArtifactJobsToErase(jobs, { jobName: options.jobName, retain });
  for (const job of staleJobs) await eraseJobArtifacts({ ...options, headers, jobId: job.id });
  return {
    retained: retain,
    prunedTags: staleVersions.map((version) => `alpha/v${version}`),
    erasedArtifactJobIds: staleJobs.map((job) => job.id),
  };
}

async function deleteTag(options) {
  const apiUrl = resolveApiUrl(options.apiUrl);
  const projectId = encodeURIComponent(String(options.projectId ?? process.env.CI_PROJECT_ID ?? "").trim());
  if (!projectId) throw new Error("CI_PROJECT_ID is required for alpha tag retention.");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const tag = encodeURIComponent(options.tag);
  const response = await fetchImpl(`${apiUrl}/projects/${projectId}/repository/tags/${tag}`, {
    method: "DELETE",
    headers: options.headers,
  });
  if (!response.ok) throw new Error(`Unable to delete GitLab tag ${options.tag}: HTTP ${response.status}.`);
}

async function listSuccessfulJobs(options) {
  const apiUrl = resolveApiUrl(options.apiUrl);
  const projectId = encodeURIComponent(String(options.projectId ?? process.env.CI_PROJECT_ID ?? "").trim());
  if (!projectId) throw new Error("CI_PROJECT_ID is required for alpha artifact retention.");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const jobs = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = new URL(`${apiUrl}/projects/${projectId}/jobs`);
    url.searchParams.append("scope[]", "success");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await fetchImpl(url, { headers: options.headers });
    if (!response.ok) throw new Error(`Unable to list GitLab jobs for alpha retention: HTTP ${response.status}.`);
    const pageJobs = await response.json();
    if (!Array.isArray(pageJobs)) throw new Error("GitLab jobs response must be an array.");
    jobs.push(...pageJobs);
    if (pageJobs.length < 100 || !response.headers.get("x-next-page")) break;
  }
  return jobs;
}

async function eraseJobArtifacts(options) {
  const apiUrl = resolveApiUrl(options.apiUrl);
  const projectId = encodeURIComponent(String(options.projectId ?? process.env.CI_PROJECT_ID ?? "").trim());
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(`${apiUrl}/projects/${projectId}/jobs/${Number(options.jobId)}/artifacts`, {
    method: "DELETE",
    headers: options.headers,
  });
  if (!response.ok) throw new Error(`Unable to erase GitLab artifacts for job ${options.jobId}: HTTP ${response.status}.`);
}

function resolveApiUrl(value = process.env.CI_API_V4_URL) {
  const normalized = String(value ?? "").trim().replace(/\/$/u, "");
  const url = new URL(normalized);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("CI_API_V4_URL must be an HTTP(S) URL without credentials.");
  }
  return url.href.replace(/\/$/u, "");
}

function normalizeRetain(value) {
  const retain = Number(value);
  if (!Number.isInteger(retain) || retain < 1) throw new Error(`Alpha retention must be a positive integer: ${value}`);
  return retain;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
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

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (["--job-name", "--retain"].includes(token)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${token} requires a value.`);
      result[token === "--job-name" ? "jobName" : "retain"] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!result.jobName) throw new Error("Usage: alpha-retention.mjs --job-name <release-job> [--retain 3].");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await pruneAlphaReleaseHistory(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
