import { readdir, readFile } from "node:fs/promises";

const API_INDEX_URL = "https://api.apis.guru/v2/list.json";

const [command, packageIdOrQuery, ...restArgs] = process.argv.slice(2);

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
  const text = await readFile(new URL(`../pkgs/${packageId}/profile.yaml`, import.meta.url), "utf8");
  return {
    id: packageId,
    name: text.match(/^name:\s*(.+)$/m)?.[1]?.trim(),
    apisGuru: text.match(/apis_guru:\s*(.+)/)?.[1]?.trim(),
    openapiUrl: text.match(/openapi_url:\s*(.+)/)?.[1]?.trim(),
    graphqlUrl: text.match(/graphql_url:\s*(.+)/)?.[1]?.trim(),
    docsUrl: text.match(/docs_url:\s*(.+)/)?.[1]?.trim(),
    text,
  };
};

const fetchSpec = async (packageId) => {
  const profile = await readProfile(packageId);
  if (profile.openapiUrl) {
    return readJson(profile.openapiUrl);
  }
  if (!profile.apisGuru) {
    throw new Error(`pkgs/${packageId}/profile.yaml does not define a supported OpenAPI source`);
  }
  const index = await loadIndex();
  const api = index[profile.apisGuru];
  if (!api) {
    throw new Error(`API not found in APIs.guru index: ${profile.apisGuru}`);
  }
  return readJson(latestVersion(api).swaggerUrl);
};

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

const searchOperations = (spec, query) => {
  if (!query) {
    return operations(spec).slice(0, 25);
  }

  const normalizedQuery = query.toLowerCase();
  return operations(spec)
    .filter((operation) =>
      [operation.id, operation.method, operation.path, operation.summary, ...(operation.tags ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    )
    .slice(0, 25);
};

const describeOperation = (spec, id) => {
  const match = operations(spec).find((operation) => operation.id === id);
  if (!match) {
    throw new Error(`Operation not found: ${id}`);
  }

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
  const operation = describeOperation(spec, id);
  const parameters = operation.parameters ?? [];
  const pathParameters = parameters.filter((parameter) => parameter.in === "path");
  const queryParameters = parameters.filter((parameter) => parameter.in === "query");
  const headerParameters = parameters.filter((parameter) => parameter.in === "header");
  const needsBody = Boolean(operation.requestBody);

  return {
    operation: operation.id,
    method: operation.method,
    url_template: joinUrlTemplate(serverUrl(spec), operation.path),
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
  if (!profile.apisGuru && !profile.openapiUrl) {
    return {
      package: packageId,
      status: "missing_source",
      source: profile.docsUrl ? "docs" : "unknown",
      gap: "No machine-readable OpenAPI source is configured.",
    };
  }

  try {
    const spec = await fetchSpec(packageId);
    const listedOperations = operations(spec);
    const methods = [...new Set(listedOperations.map((operation) => operation.method))].sort();
    return {
      package: packageId,
      status: "ok",
      source: profile.apisGuru ? "apis.guru" : "openapi_url",
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

const main = async () => {
  const packageOptionalCommands = new Set(["gaps", "validate"]);
  if (!command || (!packageOptionalCommands.has(command) && !packageIdOrQuery)) {
    throw new Error("Usage: npm run search -- <query> | npm run ops -- <package> | npm run describe -- <package> <operationId>");
  }

  if (command === "bootstrap-prompt") {
    return bootstrapPrompt(packageIdOrQuery);
  }
  if (command === "search") {
    return searchApis(packageIdOrQuery);
  }
  if (command === "ops") {
    return searchOperations(await fetchSpec(packageIdOrQuery), restArgs.join(" "));
  }
  if (command === "describe") {
    return describeOperation(await fetchSpec(packageIdOrQuery), restArgs.join(" "));
  }
  if (command === "plan-call") {
    return requestPlan(await fetchSpec(packageIdOrQuery), restArgs.join(" "));
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
