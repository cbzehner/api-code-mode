import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const API_INDEX_URL = "https://api.apis.guru/v2/list.json";

const [command, packageIdOrQuery, ...restArgs] = process.argv.slice(2);

const packageDirectoryUrl = (packageId) => new URL(`../pkgs/${packageId}/`, import.meta.url);

const assertPackageId = (packageId) => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(packageId)) {
    throw new Error("Package id must use lowercase letters, numbers, and hyphens.");
  }
};

const readJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
};

const latestVersion = (api) => api.versions[api.preferred] ?? Object.values(api.versions).at(-1);

const loadIndex = async () => readJson(API_INDEX_URL);

const resolveRef = (spec, value) => {
  if (!value?.$ref?.startsWith("#/")) {
    return value;
  }

  return value.$ref
    .slice(2)
    .split("/")
    .reduce((node, key) => node?.[key], spec);
};

const readProfile = async (packageId) => {
  assertPackageId(packageId);
  const text = await readFile(new URL("profile.yaml", packageDirectoryUrl(packageId)), "utf8");
  const listValues = (key) => {
    const match = text.match(new RegExp(`^  ${key}:\\n((?:    - .+\\n?)+)`, "m"));
    if (!match) {
      return [];
    }
    return match[1].split("\n").map((line) => line.trim().replace(/^- /, "")).filter(Boolean);
  };

  return {
    id: packageId,
    name: text.match(/^name:\s*(.+)$/m)?.[1]?.trim(),
    apisGuru: text.match(/apis_guru:\s*(.+)/)?.[1]?.trim(),
    openapiUrl: text.match(/openapi_url:\s*(.+)/)?.[1]?.trim(),
    openapiUrls: listValues("openapi_urls"),
    graphqlUrl: text.match(/graphql_url:\s*(.+)/)?.[1]?.trim(),
    docsUrl: text.match(/docs_url:\s*(.+)/)?.[1]?.trim(),
    llmsUrl: text.match(/llms_url:\s*(.+)/)?.[1]?.trim(),
    mcpUrl: text.match(/mcp_url:\s*(.+)/)?.[1]?.trim(),
    text,
  };
};

const createDraftProfile = async (packageId) => {
  assertPackageId(packageId);
  const name = parseFlag("--name", packageId);
  const docsUrl = parseFlag("--docs-url", null);
  const openapiUrl = parseFlag("--openapi-url", null);
  const graphqlUrl = parseFlag("--graphql-url", null);
  const apisGuru = parseFlag("--apis-guru", null);
  const env = parseFlag("--env", null);

  const sourceLines = [
    "sources:",
    apisGuru ? `  apis_guru: ${apisGuru}` : null,
    openapiUrl ? `  openapi_url: ${openapiUrl}` : null,
    graphqlUrl ? `  graphql_url: ${graphqlUrl}` : null,
    docsUrl ? `  docs_url: ${docsUrl}` : null,
    !apisGuru && !openapiUrl && !graphqlUrl && !docsUrl ? "  docs_url: unknown" : null,
  ].filter(Boolean);

  const profile = [
    `id: ${packageId}`,
    `name: ${name}`,
    ...sourceLines,
    "auth:",
    "  type: unknown",
    env ? `  env: ${env}` : null,
    "policy:",
    "  default_write: confirm",
    "output:",
    "  default_format: json",
    "",
  ].filter((line) => line !== null).join("\n");

  await mkdir(packageDirectoryUrl(packageId), { recursive: true });
  const profileUrl = new URL("profile.yaml", packageDirectoryUrl(packageId));
  try {
    await readFile(profileUrl, "utf8");
    throw new Error(`pkgs/${packageId}/profile.yaml already exists`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  await writeFile(profileUrl, profile, { flag: "wx" });
  const validation = await validateProfile(packageId);
  return {
    package: packageId,
    created: `pkgs/${packageId}/profile.yaml`,
    validation,
    next_steps: [
      `npm run bootstrap-prompt -- ${packageId}`,
      `npm run bootstrap-agent -- ${packageId} --runner gemini --timeout-ms 120000`,
      `npm run validate -- ${packageId}`,
    ],
  };
};

const fetchSpec = async (packageId) => {
  const profile = await readProfile(packageId);
  const specs = await fetchSpecs(profile);
  return specs[0]?.spec;
};

const fetchSpecs = async (profile) => {
  const urls = [...profile.openapiUrls, profile.openapiUrl].filter(Boolean);
  if (urls.length > 0) {
    return Promise.all(urls.map(async (url) => ({ source: url, spec: await readJson(url) })));
  }
  if (!profile.apisGuru) {
    throw new Error(`pkgs/${profile.id}/profile.yaml does not define a supported OpenAPI source`);
  }
  const index = await loadIndex();
  const api = index[profile.apisGuru];
  if (!api) {
    throw new Error(`API not found in APIs.guru index: ${profile.apisGuru}`);
  }
  const source = latestVersion(api).swaggerUrl;
  return [{ source, spec: await readJson(source) }];
};

const fetchPackageSpecs = async (packageId) => fetchSpecs(await readProfile(packageId));

const packageIds = async () => {
  const entries = await readdir(new URL("../pkgs", import.meta.url), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
};

const searchApis = async (term) => {
  const index = await loadIndex();
  return Object.entries(index)
    .filter(([name, api]) => {
      const text = [name, api.info?.title, api.info?.description].filter(Boolean).join(" ").toLowerCase();
      return text.includes(term.toLowerCase());
    })
    .slice(0, 10)
    .map(([name, api]) => ({
      name,
      title: api.info?.title,
      preferred: api.preferred,
      spec: latestVersion(api).swaggerUrl,
    }));
};

const operations = (spec) =>
  Object.entries(spec.paths ?? {}).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method))
      .map(([method, operation]) => ({
        id: operation.operationId ?? `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        summary: operation.summary,
        tags: operation.tags ?? [],
      })),
  );

const specSlug = (spec, index) => (spec.info?.title ?? `spec-${index + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const packageOperations = (specs) =>
  specs.flatMap(({ source, spec }, index) =>
    operations(spec).map((operation) => ({
      ...operation,
      spec: specSlug(spec, index),
      spec_title: spec.info?.title,
      source,
      qualified_id: `${specSlug(spec, index)}:${operation.id}`,
    })),
  );

const searchOperations = (listedOperations, query) => {
  if (!query) {
    return listedOperations.slice(0, 25);
  }

  const normalizedQuery = query.toLowerCase();
  return listedOperations
    .filter((operation) =>
      [operation.id, operation.qualified_id, operation.spec_title, operation.method, operation.path, operation.summary, ...(operation.tags ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    )
    .slice(0, 25);
};

const findOperation = (specs, id) => {
  const listedOperations = packageOperations(specs);
  return listedOperations.find((operation) => operation.qualified_id === id) ?? listedOperations.find((operation) => operation.id === id);
};

const describeOperation = (specs, id) => {
  const match = findOperation(specs, id);
  if (!match) {
    throw new Error(`Operation not found: ${id}`);
  }

  const spec = specs.find((entry) => entry.source === match.source).spec;
  const operation = spec.paths[match.path][match.method.toLowerCase()];
  return {
    ...match,
    description: operation.description,
    parameters: (operation.parameters ?? []).map((parameter) => resolveRef(spec, parameter)),
    requestBody: resolveRef(spec, operation.requestBody),
    security: operation.security ?? spec.security ?? [],
  };
};

const serverUrl = (spec) => spec.servers?.[0]?.url ?? "";

const joinUrlTemplate = (baseUrl, path) => `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

const requestPlan = (spec, id) => {
  const specs = Array.isArray(spec) ? spec : [{ source: "inline", spec }];
  const operation = describeOperation(specs, id);
  const selectedSpec = specs.find((entry) => entry.source === operation.source).spec;
  const parameters = operation.parameters ?? [];
  const pathParameters = parameters.filter((parameter) => parameter.in === "path");
  const queryParameters = parameters.filter((parameter) => parameter.in === "query");
  const headerParameters = parameters.filter((parameter) => parameter.in === "header");
  const needsBody = Boolean(operation.requestBody);

  return {
    operation: operation.id,
    qualified_id: operation.qualified_id,
    spec: operation.spec,
    spec_title: operation.spec_title,
    method: operation.method,
    url_template: joinUrlTemplate(serverUrl(selectedSpec), operation.path),
    safety: operation.method === "GET" ? "read" : operation.method === "DELETE" ? "destructive" : "write",
    path_parameters: pathParameters.map((parameter) => ({
      name: parameter.name,
      required: parameter.required === true,
      type: parameter.schema?.type,
      description: parameter.description,
    })),
    query_parameters: queryParameters.map((parameter) => ({
      name: parameter.name,
      required: parameter.required === true,
      type: parameter.schema?.type,
      description: parameter.description,
    })),
    header_parameters: headerParameters.map((parameter) => ({
      name: parameter.name,
      required: parameter.required === true,
      type: parameter.schema?.type,
      description: parameter.description,
    })),
    needs_body: needsBody,
    security: operation.security,
  };
};

const validateProfile = async (packageId) => {
  const profile = await readProfile(packageId);
  if (profile.graphqlUrl) {
    return {
      package: packageId,
      status: "unsupported",
      source: "graphql",
      gap: "GraphQL introspection is not implemented yet.",
    };
  }
  if (!profile.apisGuru && !profile.openapiUrl && profile.openapiUrls.length === 0) {
    return {
      package: packageId,
      status: "missing_source",
      source: profile.llmsUrl ? "llms" : profile.mcpUrl ? "mcp" : profile.docsUrl ? "docs" : "unknown",
      gap: "No machine-readable OpenAPI source is configured.",
    };
  }

  try {
    const specs = await fetchPackageSpecs(packageId);
    const listedOperations = packageOperations(specs);
    const methods = [...new Set(listedOperations.map((operation) => operation.method))].sort();
    return {
      package: packageId,
      status: "ok",
      source: profile.apisGuru ? "apis.guru" : specs.length > 1 ? "openapi_urls" : "openapi_url",
      specs: specs.length,
      operations: listedOperations.length,
      methods,
    };
  } catch (error) {
    return {
      package: packageId,
      status: "failed",
      error: error.message,
    };
  }
};

const bootstrapPrompt = async (packageId) => {
  const profile = await readProfile(packageId);
  const validation = await validateProfile(packageId);
  const packagePath = `pkgs/${packageId}/profile.yaml`;

  const instructions = [
    `You are repairing the api-code-mode package profile for ${profile.name ?? packageId}.`,
    "",
    "Goal:",
    "- Make this package machine-readable and usable by the api-code-mode runtime without adding bespoke runtime code unless the source type requires it.",
    "",
    "Current validation result:",
    JSON.stringify(validation, null, 2),
    "",
    "Current profile:",
    "```yaml",
    profile.text.trim(),
    "```",
    "",
    "Allowed edits:",
    `- Edit ${packagePath}.`,
    `- Add notes under pkgs/${packageId}/ if needed, such as BOOTSTRAP.md.`,
    "- Do not edit unrelated packages.",
    "- Do not add credentials, tokens, or secret item identifiers.",
    "",
    "Bootstrap steps:",
    "- Search the public web for official API docs, machine-readable OpenAPI/Swagger specs, Postman collections, GraphQL schemas, SDK metadata, or well-known spec URLs.",
    "- Prefer official provider sources over third-party mirrors.",
    "- If an OpenAPI spec exists, add `sources.openapi_url` or `sources.apis_guru`.",
    "- If only GraphQL exists, keep `sources.graphql_url` and document that a GraphQL adapter is required.",
    "- If only human docs exist, keep `sources.docs_url`, add notes explaining what was found, and leave validation as a known gap.",
    "- Classify auth minimally using env var names only.",
    "- Preserve `policy.default_write: confirm` unless official docs prove a safer default.",
    "",
    "Verification:",
    `- Run \`npm run validate -- ${packageId}\`.`,
    "- If validation cannot pass because runtime support is missing, explain the missing adapter precisely.",
    "- Summarize the source URLs used and the remaining gap.",
  ].join("\n");

  return {
    package: packageId,
    status: validation.status,
    source: validation.source,
    prompt: instructions,
    suggested_agent_commands: [
      `gemini -p "$(npm run bootstrap-prompt -- ${packageId} | node -e 'let s=\"\"; process.stdin.on(\"data\", d => s += d); process.stdin.on(\"end\", () => console.log(JSON.parse(s).prompt))')" --model gemini-3.1-pro-preview --skip-trust --approval-mode plan`,
    ],
  };
};

const parseFlag = (flagName, defaultValue) => {
  const index = restArgs.indexOf(flagName);
  return index === -1 ? defaultValue : restArgs[index + 1];
};

const runProcess = async (executable, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(executable, args, { detached: true, shell: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }, timeoutMs);

    const killTimeout = setTimeout(() => {
      if (!timedOut) {
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish({ code: 124, stdout, stderr, timedOut });
    }, timeoutMs + 3000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ code: 1, stdout, stderr: error.message, timedOut });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut });
    });
  });

const parseGeminiOutput = (stdout) => {
  try {
    const parsed = JSON.parse(stdout);
    return parsed.response ?? parsed;
  } catch {
    return stdout.trim();
  }
};

const bootstrapAgent = async (packageId) => {
  const runner = parseFlag("--runner", "gemini");
  const timeoutMs = Number.parseInt(parseFlag("--timeout-ms", "120000"), 10);
  if (runner !== "gemini") {
    return {
      package: packageId,
      runner,
      status: "failed",
      error: "Only the gemini runner is implemented in the spike runtime.",
    };
  }

  const prompt = await bootstrapPrompt(packageId);
  const agentPrompt = [
    prompt.prompt,
    "",
    "Runner mode:",
    "- Do not edit files.",
    "- Return concise findings with one final status: repaired, adapter_needed, source_missing, or failed.",
    "- Include exact official source URLs if found.",
    "- Include the minimal profile.yaml changes you recommend, if any.",
  ].join("\n");

  const result = await runProcess("gemini", [
    "-p",
    agentPrompt,
    "--model",
    "gemini-3.1-pro-preview",
    "--skip-trust",
    "--approval-mode",
    "plan",
    "-o",
    "json",
  ], timeoutMs);

  return {
    package: packageId,
    runner,
    status: result.timedOut ? "timeout" : result.code === 0 ? "agent_completed" : "failed",
    exit_code: result.timedOut ? 124 : result.code,
    timed_out: result.timedOut,
    output: parseGeminiOutput(result.stdout),
    stderr: result.stderr.trim(),
  };
};

const main = async () => {
  const packageOptionalCommands = new Set(["gaps", "validate"]);
  if (!command || (!packageOptionalCommands.has(command) && !packageIdOrQuery)) {
    throw new Error("Usage: npm run search -- <query> | npm run ops -- <package> | npm run describe -- <package> <operationId>");
  }

  if (command === "bootstrap-prompt") {
    return bootstrapPrompt(packageIdOrQuery);
  }
  if (command === "bootstrap-new") {
    return createDraftProfile(packageIdOrQuery);
  }
  if (command === "bootstrap-agent") {
    return bootstrapAgent(packageIdOrQuery);
  }
  if (command === "search") {
    return searchApis(packageIdOrQuery);
  }
  if (command === "ops") {
    return searchOperations(packageOperations(await fetchPackageSpecs(packageIdOrQuery)), restArgs.join(" "));
  }
  if (command === "describe") {
    return describeOperation(await fetchPackageSpecs(packageIdOrQuery), restArgs.join(" "));
  }
  if (command === "plan-call") {
    return requestPlan(await fetchPackageSpecs(packageIdOrQuery), restArgs.join(" "));
  }
  if (command === "gaps") {
    const results = await Promise.all((await packageIds()).map(validateProfile));
    return results.filter((result) => result.status !== "ok");
  }
  if (command === "validate") {
    const ids = packageIdOrQuery ? [packageIdOrQuery] : await packageIds();
    return Promise.all(ids.map(validateProfile));
  }
  throw new Error(`Unknown command: ${command}`);
};

main()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
