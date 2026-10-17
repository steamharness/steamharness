import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLocalWorkflowWithReport } from "../index";
import { serializeWorkflowError, WorkflowError } from "../workflow/errors";

const dashedProviderKey = `sk-${"a".repeat(18)}01`;

test("upstream response bodies are redacted for every credential shape we mint or consume", () => {
  const synthetic = (prefix: string, separator = "_"): string => `${prefix}${separator}${"a".repeat(18)}01`;
  const secrets = [
    dashedProviderKey,
    synthetic("wfllm"),
    synthetic("wfrt"),
    synthetic("wfwh"),
    synthetic("wf_access"),
    synthetic("provider"),
    synthetic("glpat"),
    synthetic("ghp"),
    synthetic("github_pat"),
    synthetic("admin", "-"),
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  ];

  for (const secret of secrets) {
    const summary = summarize(`{"code":"INVALID","message":"rejected ${secret}"}`);
    assert.doesNotMatch(summary, new RegExp(escapeRegExp(secret)), `leaked ${secret}`);
    assert.match(summary, /\[redacted\]/, `did not redact ${secret}`);
  }

  assert.match(summarize(`Authorization: Bearer ${dashedProviderKey}`), /Bearer \[redacted\]/);
  assert.doesNotMatch(summarize("{\"api_key\": \"totally-secret-value\"}"), /totally-secret-value/);
  assert.doesNotMatch(summarize("token=abcdef0123456789"), /abcdef0123456789/);
});

test("redaction leaves ordinary diagnostic prose intact", () => {
  for (const body of [
    "{\"code\":\"admin_key_invalid\",\"message\":\"The admin key is not recognized\"}",
    "sub-resource-not-found",
    "Bearer authentication is required for this endpoint",
    "{\"code\":\"API_KEY_REQUIRED\",\"message\":\"API key is required in Authorization header\"}",
  ]) {
    assert.equal(summarize(body), body.replace(/\s+/g, " ").trim(), `over-redacted: ${body}`);
  }
});

test("run report surfaces the upstream response body instead of only the HTTP status text", async () => {
  const workflowDir = await createUpstreamErrorWorkflow();

  const report = await runLocalWorkflowWithReport({ workflowDir, args: [] });

  assert.equal(report.status, "failed");
  assert.equal(report.result.ok, true);
  if (!report.result.ok) return;
  const data = report.result.data as { errCode?: number; errMessage?: string };
  const errMessage = data.errMessage ?? "";

  // Without the response body an AI SDK failure reads as a bare "Unauthorized", which cannot distinguish a
  // rejected credential from a request that never carried one.
  assert.match(errMessage, /Unauthorized/);
  assert.match(errMessage, /status 401/);
  assert.match(errMessage, /localhost:7127\/api\/ai\/proxy\/provider-4\/responses/);
  assert.match(errMessage, /API_KEY_REQUIRED/);
});

test("run report redacts credential shaped values and truncates long upstream bodies", async () => {
  const workflowDir = await createUpstreamErrorWorkflow({
    responseBody: `{"message":"rejected ${dashedProviderKey}","padding":"${"x".repeat(400)}"}`,
  });

  const report = await runLocalWorkflowWithReport({ workflowDir, args: [] });

  assert.equal(report.result.ok, true);
  if (!report.result.ok) return;
  const data = report.result.data as { errMessage?: string };
  const errMessage = data.errMessage ?? "";

  assert.doesNotMatch(errMessage, new RegExp(escapeRegExp(dashedProviderKey)));
  assert.match(errMessage, /\[redacted\]/);
  assert.match(errMessage, /…/);
  assert.ok(errMessage.length < 400, `expected a truncated excerpt, received ${errMessage.length} characters`);
});

/** Round-trips a body through the sanitizer to observe the exact excerpt a run report would carry. */
function summarize(responseBody: string): string {
  const error = Object.assign(new Error("Unauthorized"), { statusCode: 401, responseBody });
  const serialized = serializeWorkflowError(
    new WorkflowError({ type: "provider_call", message: "call failed", cause: error }),
  );

  return serialized.cause?.responseBody ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

async function createUpstreamErrorWorkflow(
  options: { responseBody?: string } = {},
): Promise<string> {
  const responseBody = options.responseBody
    ?? "{\"code\":\"API_KEY_REQUIRED\",\"message\":\"API key is required in Authorization header\"}";
  const workflowDir = await mkdtemp(path.join(os.tmpdir(), "workflow-code-upstream-error-"));

  await writeFile(
    path.join(workflowDir, "package.json"),
    JSON.stringify({
      id: "22222222-2222-4222-8222-222222222222",
      name: "@workflow-code/upstream-error-test",
      type: "module",
      workflowCode: { projectInfo: { dataStorage: { mode: "local" } } },
    }),
  );
  await writeFile(
    path.join(workflowDir, "interface.ts"),
    [
      "export interface WorkflowPayload { errCode: number; errMessage: string; }",
      "export interface UpstreamErrorPayload extends WorkflowPayload { value: string; }",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(workflowDir, "index.ts"),
    [
      "import type { UpstreamErrorPayload } from \"./interface\";",
      "",
      "class ApiCallError extends Error {",
      "  statusCode = 401;",
      "  url = \"http://localhost:7127/api/ai/proxy/provider-4/responses\";",
      "  isRetryable = false;",
      `  responseBody = ${JSON.stringify(responseBody)};`,
      "  constructor() {",
      "    super(\"Unauthorized\");",
      "    this.name = \"AI_APICallError\";",
      "  }",
      "}",
      "",
      "export const upstreamErrorWorkflow = workflow.defineWorkflow<Record<string, never>, UpstreamErrorPayload>({",
      "  name: \"upstream-error-test\",",
      "  async run() {",
      "    throw new ApiCallError();",
      "  },",
      "});",
      "",
      "export const executor = workflow.defineExecutor<Record<string, never>, UpstreamErrorPayload>({",
      "  projectType: \"workflow\",",
      "  defaultEntrypoint: \"main\",",
      "  entrypoints: [workflow.defineEntrypoint<Record<string, never>, UpstreamErrorPayload>({",
      "    id: \"main\", title: \"Main\", workflow: upstreamErrorWorkflow,",
      "    createInput() {",
      "      return {};",
      "    },",
      "  })],",
      "});",
      "",
      "export { upstreamErrorWorkflow as workflow };",
      "export default upstreamErrorWorkflow;",
      "",
    ].join("\n"),
  );

  return workflowDir;
}
