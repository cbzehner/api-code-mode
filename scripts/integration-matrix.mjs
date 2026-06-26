import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const root = new URL("../", import.meta.url);
const fixtureUrl = new URL("../test-fixtures/api-matrix.json", import.meta.url);
const targets = JSON.parse(await readFile(fixtureUrl, "utf8")).targets;
const selected = process.argv.slice(2);
const selectedTargets = selected.length > 0 ? targets.filter((target) => selected.includes(target.id)) : targets;

const packageId = (target) => `matrix-${target.id}`;
const packageUrl = (target) => new URL(`../pkgs/${packageId(target)}/`, import.meta.url);

const profileText = (target) => [
  `id: ${packageId(target)}`,
  `name: ${target.name}`,
  "sources:",
  target.apis_guru ? `  apis_guru: ${target.apis_guru}` : null,
  target.openapi_url ? `  openapi_url: ${target.openapi_url}` : null,
  target.graphql_url ? `  graphql_url: ${target.graphql_url}` : null,
  target.server_url ? `  server_url: ${target.server_url}` : null,
  "auth:",
  `  type: ${target.auth?.type ?? "unknown"}`,
  target.auth?.env ? `  env: ${target.auth.env}` : null,
  target.auth?.header ? `  header: ${target.auth.header}` : null,
  target.auth?.header_env ? "  header_env:" : null,
  ...Object.entries(target.auth?.header_env ?? {}).map(([header, env]) => `    ${header}: ${env}`),
  target.auth?.scheme ? `  scheme: ${target.auth.scheme}` : null,
  target.auth?.query_param ? `  query_param: ${target.auth.query_param}` : null,
  target.auth?.username_env ? `  username_env: ${target.auth.username_env}` : null,
  target.auth?.password_env ? `  password_env: ${target.auth.password_env}` : null,
  "policy:",
  "  default_write: confirm",
  ...(target.policy?.read_operations?.length > 0 ? [
    "  read_operations:",
    ...target.policy.read_operations.map((operation) => `    - ${operation}`),
  ] : []),
  "output:",
  "  default_format: json",
  "",
].filter(Boolean).join("\n");

const authEnv = (target) => Object.fromEntries([
  target.auth?.env ? [target.auth.env, "matrix-secret"] : null,
  target.auth?.username_env ? [target.auth.username_env, "matrix-user"] : null,
  target.auth?.password_env ? [target.auth.password_env, "matrix-secret"] : null,
  ...Object.values(target.auth?.header_env ?? {}).map((env) => [env, "matrix-secret"]),
].filter(Boolean));

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text.trim();
  }
};

const runCli = (args, { timeoutMs = 30000, env = {} } = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.mjs", ...args], { cwd: root, env: { ...process.env, ...env }, shell: false });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: 124, stdout, stderr, timed_out: true });
    }, timeoutMs);

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        ...result,
        stdout_json: parseJson(result.stdout),
        stderr_json: parseJson(result.stderr),
      });
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ code: 1, stdout, stderr: error.message, timed_out: false });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timed_out: false });
    });
  });

const setupProfile = async (target) => {
  await rm(packageUrl(target), { recursive: true, force: true });
  await mkdir(packageUrl(target), { recursive: true });
  await writeFile(new URL("profile.yaml", packageUrl(target)), profileText(target));
};

const cleanupProfiles = async () => {
  await Promise.all(selectedTargets.map((target) => rm(packageUrl(target), { recursive: true, force: true })));
};

const firstReadOperation = (operations) =>
  operations.find((operation) => operation.safety === "read" || operation.method === "GET" || operation.method === "QUERY" || operation.method === "query");

const requiredParameters = (description) =>
  [
    ...(description.path_parameters ?? []),
    ...(description.query_parameters ?? []),
    ...(description.header_parameters ?? []),
    ...(description.parameters ?? []),
  ]
    .filter((parameter) => parameter.required)
    .map((parameter) => parameter.name);

const validateTarget = async (target) => {
  await setupProfile(target);
  const id = packageId(target);
  const validation = await runCli(["validate", id]);
  if (validation.code !== 0) {
    return { id: target.id, package: id, status: "failed", stage: "validate", error: validation.stderr_json };
  }

  const validationResult = validation.stdout_json[0];
  if (validationResult.status !== "ok") {
    return { id: target.id, package: id, status: validationResult.status, stage: "validate", validation: validationResult };
  }

  const ops = await runCli([id, "ops"]);
  if (ops.code !== 0 || !Array.isArray(ops.stdout_json) || ops.stdout_json.length === 0) {
    return { id: target.id, package: id, status: "failed", stage: "ops", validation: validationResult, error: ops.stderr_json };
  }

  const readOperation = firstReadOperation(ops.stdout_json);
  if (!readOperation) {
    return { id: target.id, package: id, status: "no_read_operation", stage: "ops", validation: validationResult, sampled_operations: ops.stdout_json.length };
  }

  const describe = await runCli([id, "describe", readOperation.qualified_id]);
  if (describe.code !== 0) {
    return { id: target.id, package: id, status: "failed", stage: "describe", validation: validationResult, operation: readOperation.qualified_id, error: describe.stderr_json };
  }

  const missing = requiredParameters(describe.stdout_json);
  const dryRun = missing.length === 0 ? await runCli([id, "call", readOperation.qualified_id, "--dry-run"], { env: authEnv(target) }) : null;
  return {
    id: target.id,
    package: id,
    status: dryRun && dryRun.code !== 0 ? "call_not_ready" : "ok",
    source: target.apis_guru ? "apis.guru" : target.graphql_url ? "graphql" : "openapi_url",
    validation: validationResult,
    sampled_operation: readOperation.qualified_id,
    required_parameters: missing,
    dry_run_status: dryRun?.stdout_json?.status ?? null,
    dry_run_error: dryRun?.code === 0 ? null : dryRun?.stderr_json,
  };
};

const main = async () => {
  const results = [];
  try {
    for (const target of selectedTargets) {
      results.push(await validateTarget(target));
    }
  } finally {
    await cleanupProfiles();
  }

  const summary = {
    total: results.length,
    ok: results.filter((result) => result.status === "ok").length,
    failed: results.filter((result) => result.status === "failed").length,
    gaps: results.filter((result) => !["ok"].includes(result.status)).length,
    statuses: results.reduce((counts, result) => ({ ...counts, [result.status]: (counts[result.status] ?? 0) + 1 }), {}),
  };

  console.log(JSON.stringify({ summary, results }, null, 2));
  if (summary.failed > 0) {
    process.exit(1);
  }
};

main().catch((error) => {
  console.error(JSON.stringify({ status: "error", code: "matrix_error", message: error.message }, null, 2));
  process.exit(1);
});
