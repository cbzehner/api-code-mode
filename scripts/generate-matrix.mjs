import { readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";

const root = new URL("../", import.meta.url);
const fixtureUrl = new URL("../test-fixtures/generate-matrix.json", import.meta.url);
const targets = JSON.parse(await readFile(fixtureUrl, "utf8")).targets;
const selected = process.argv.slice(2);
const selectedTargets = selected.length > 0 ? targets.filter((target) => selected.includes(target.id)) : targets;

const packageUrl = (packageId) => new URL(`../pkgs/${packageId}/`, import.meta.url);

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text.trim();
  }
};

const runCli = (args, timeoutMs = 60000) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.mjs", ...args], { cwd: root, shell: false });
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

const profileExists = async (packageId) => {
  try {
    await readFile(new URL("profile.yaml", packageUrl(packageId)), "utf8");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const cleanup = async (createdPackages) => {
  await Promise.all([...createdPackages].map((packageId) => rm(packageUrl(packageId), { recursive: true, force: true })));
};

const firstInspectableOperation = (operations) =>
  operations.find((operation) => operation.qualified_id);

const validateGeneratedPackage = async (target) => {
  const generated = await runCli(["generate", target.input]);
  if (generated.code !== 0) {
    return { id: target.id, input: target.input, status: "failed", stage: "generate", error: generated.stderr_json };
  }

  const result = generated.stdout_json;
  const sourceOk = !target.expect_source || result.selected_source?.type === target.expect_source;
  if (!sourceOk) {
    return {
      id: target.id,
      input: target.input,
      package: result.package,
      status: "unexpected_source",
      expected_source: target.expect_source,
      selected_source: result.selected_source,
    };
  }
  if (!["ready", "needs_auth_detail"].includes(result.status)) {
    return { id: target.id, input: target.input, package: result.package, status: result.status, stage: "generate", result };
  }

  const ops = await runCli([result.package, "ops"]);
  if (ops.code !== 0 || !Array.isArray(ops.stdout_json) || ops.stdout_json.length === 0) {
    return { id: target.id, input: target.input, package: result.package, status: "failed", stage: "ops", error: ops.stderr_json };
  }

  const operation = firstInspectableOperation(ops.stdout_json);
  const describe = await runCli([result.package, "describe", operation.qualified_id]);
  if (describe.code !== 0) {
    return { id: target.id, input: target.input, package: result.package, status: "failed", stage: "describe", operation: operation.qualified_id, error: describe.stderr_json };
  }

  return {
    id: target.id,
    input: target.input,
    package: result.package,
    status: "ok",
    generated_status: result.status,
    selected_source: result.selected_source,
    operations_sampled: ops.stdout_json.length,
    sampled_operation: operation.qualified_id,
  };
};

const main = async () => {
  const createdPackages = new Set();
  const results = [];
  try {
    for (const target of selectedTargets) {
      const before = await profileExists(target.id);
      const result = await validateGeneratedPackage(target);
      const after = result.package ? await profileExists(result.package) : false;
      if (after && !before && !target.keep_existing) {
        createdPackages.add(result.package);
      }
      results.push(result);
    }
  } finally {
    await cleanup(createdPackages);
  }

  const summary = {
    total: results.length,
    ok: results.filter((result) => result.status === "ok").length,
    failed: results.filter((result) => result.status === "failed").length,
    gaps: results.filter((result) => result.status !== "ok").length,
    statuses: results.reduce((counts, result) => ({ ...counts, [result.status]: (counts[result.status] ?? 0) + 1 }), {}),
  };

  console.log(JSON.stringify({ summary, results }, null, 2));
  if (summary.failed > 0) {
    process.exit(1);
  }
};

main().catch((error) => {
  console.error(JSON.stringify({ status: "error", code: "generate_matrix_error", message: error.message }, null, 2));
  process.exit(1);
});
