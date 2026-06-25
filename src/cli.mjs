import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";

const API_INDEX_URL = "https://api.apis.guru/v2/list.json";

const [command, packageIdOrQuery, ...restArgs] = process.argv.slice(2);
const FETCH_TIMEOUT_MS = 10000;

const packageDirectoryUrl = (packageId) => new URL(`../pkgs/${packageId}/`, import.meta.url);

const assertPackageId = (packageId) => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(packageId)) {
    throw new Error("Package id must use lowercase letters, numbers, and hyphens.");
  }
};

const publicHelp = () => ({
  name: "api-code-mode",
  description: "Generate local, agent-callable API interfaces from public API docs.",
  commands: [
    {
      command: "generate <domain-or-url>",
      description: "Turn public API docs into a local package that agents can search and inspect.",
      examples: ["api-code-mode generate cable.tech", "api-code-mode generate https://docs.cable.tech/"],
    },
    {
      command: "<package> ops [query]",
      description: "Search operations for a generated package.",
      examples: ["api-code-mode cable ops transaction", "api-code-mode slack ops chat"],
    },
    {
      command: "<package> describe <operation-id>",
      description: "Inspect one operation without loading the whole API.",
      examples: ["api-code-mode cable describe api-reference:request-token"],
    },
    {
      command: "<package> call <operation-id> [--param name=value]",
      description: "Run a read-only operation and return the response as structured JSON.",
      examples: ["api-code-mode github call github-v3-rest-api:meta/root"],
    },
  ],
  notes: [
    "Advanced diagnostic commands are available for agents and maintainers but hidden from public help.",
    "The spike executes only read-only API calls.",
  ],
});

const readJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
};

const readText = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      text: await response.text(),
      url: response.url,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      contentType: "",
      text: "",
      url,
      error: error.name === "TimeoutError" ? "timeout" : error.message,
    };
  }
};

const probeGraphqlUrl = async (url) => {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    const looksGraphql = /graphql/i.test(text) || /"errors"\s*:/.test(text) || /"data"\s*:/.test(text);
    return {
      url: response.url,
      valid: response.status !== 404 && (looksGraphql || (contentType.includes("json") && [400, 401, 403].includes(response.status))),
      status: response.status,
      contentType,
      kind: "graphql_probe",
    };
  } catch (error) {
    return {
      url,
      valid: false,
      status: 0,
      contentType: "",
      kind: error.name === "TimeoutError" ? "timeout" : "graphql_probe_failed",
      error: error.message,
    };
  }
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
  const sectionScalar = (section, key) => {
    const match = text.match(new RegExp(`^${section}:\\n(?:  .+\\n)*?  ${key}:\\s*(.+)$`, "m"));
    return match?.[1]?.trim();
  };
  const listValues = (key) => {
    const match = text.match(new RegExp(`^  ${key}:\\n((?:    - .+\\n?)+)`, "m"));
    if (!match) {
      return [];
    }
    return match[1].split("\n").map((line) => line.trim().replace(/^- /, "")).filter(Boolean);
  };
  const sectionListValues = (section, key) => {
    const match = text.match(new RegExp(`^${section}:\\n(?:  .+\\n)*?  ${key}:\\n((?:    - .+\\n?)+)`, "m"));
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
    auth: {
      type: sectionScalar("auth", "type") ?? "unknown",
      env: sectionScalar("auth", "env"),
      header: sectionScalar("auth", "header"),
      scheme: sectionScalar("auth", "scheme"),
      queryParam: sectionScalar("auth", "query_param"),
      usernameEnv: sectionScalar("auth", "username_env"),
      passwordEnv: sectionScalar("auth", "password_env"),
      tokenOperation: sectionScalar("auth", "token_operation"),
      refreshTokenEnv: sectionScalar("auth", "refresh_token_env"),
      accessTokenEnv: sectionScalar("auth", "access_token_env"),
      organizationIdEnv: sectionScalar("auth", "organization_id_env"),
      tokenResponseField: sectionScalar("auth", "token_response_field"),
      defaultExpirySeconds: sectionScalar("auth", "default_expiry_seconds"),
      defaultScopes: sectionListValues("auth", "default_scopes"),
    },
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

  await writeFile(profileUrl, draftProfileText({ packageId, name, docsUrl, openapiUrl, graphqlUrl, apisGuru, env }), { flag: "wx" });
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

const graphqlRequest = async (url, body, headers = {}) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Keep the original response status below; callers can decide how to handle non-JSON bodies.
  }
  return { response, json, text };
};

const graphqlIntrospectionQuery = `
query ApiCodeModeIntrospection {
  __schema {
    queryType {
      name
      fields {
        name
        description
        type { kind name ofType { kind name } }
      }
    }
    mutationType {
      name
      fields {
        name
        description
        type { kind name ofType { kind name } }
      }
    }
  }
}
`;

const graphqlTypeQuery = `
query ApiCodeModeType($name: String!) {
  __type(name: $name) {
    fields {
      name
      type { kind name ofType { kind name ofType { kind name } } }
    }
  }
}
`;

const templateEnvNames = (template) =>
  unique([...template.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((match) => match[1]));

const renderValueTemplate = (template) => {
  const missing = templateEnvNames(template).filter((name) => process.env[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  const basic = template.match(/^Basic base64\((.*)\)$/);
  if (basic) {
    const value = basic[1].replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name]);
    return `Basic ${Buffer.from(value).toString("base64")}`;
  }

  return template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name]);
};

const graphqlAuthHeaders = (profile, { requireConfigured = false } = {}) => {
  if (!["bearer", "oauth2"].includes(profile.auth.type)) {
    return {};
  }
  if (!profile.auth.env) {
    return {};
  }
  if (!process.env[profile.auth.env]) {
    if (requireConfigured) {
      throw new Error(`Missing required env vars: ${profile.auth.env}`);
    }
    return {};
  }
  return { Authorization: `${profile.auth.scheme ?? "Bearer"} ${process.env[profile.auth.env]}` };
};

const graphqlSchema = async (profile) => {
  const { response, json, text } = await graphqlRequest(profile.graphqlUrl, { query: graphqlIntrospectionQuery }, graphqlAuthHeaders(profile));
  if (!response.ok || json?.errors) {
    const message = json?.errors?.[0]?.message ?? text.slice(0, 200) ?? response.statusText;
    throw new Error(`GraphQL introspection failed: HTTP ${response.status} ${message}`);
  }
  if (!json?.data?.__schema) {
    throw new Error("GraphQL introspection did not return a schema.");
  }
  return json.data.__schema;
};

const graphqlTypeRef = (type) => {
  if (!type) {
    return { display: "Unknown", named: "Unknown", kind: "UNKNOWN", required: false, list: false };
  }
  if (type.kind === "NON_NULL") {
    const inner = graphqlTypeRef(type.ofType);
    return { ...inner, display: `${inner.display}!`, required: true };
  }
  if (type.kind === "LIST") {
    const inner = graphqlTypeRef(type.ofType);
    return { ...inner, display: `[${inner.display}]`, list: true };
  }
  return { display: type.name ?? type.kind, named: type.name ?? type.kind, kind: type.kind, required: false, list: false };
};

const graphqlSchemaType = (schema, name) => (schema.types ?? []).find((type) => type.name === name);

const graphqlTypeFields = async (profile, name) => {
  const { response, json, text } = await graphqlRequest(profile.graphqlUrl, {
    query: graphqlTypeQuery,
    variables: { name },
  }, graphqlAuthHeaders(profile));
  if (!response.ok || json?.errors) {
    const message = json?.errors?.[0]?.message ?? text.slice(0, 200) ?? response.statusText;
    throw new Error(`GraphQL type introspection failed: HTTP ${response.status} ${message}`);
  }
  return json?.data?.__type?.fields ?? [];
};

const graphqlRootFields = (schema, rootTypeName) => {
  if (!rootTypeName) {
    return [];
  }
  if (schema.queryType?.name === rootTypeName) {
    return schema.queryType.fields ?? [];
  }
  if (schema.mutationType?.name === rootTypeName) {
    return schema.mutationType.fields ?? [];
  }
  return graphqlSchemaType(schema, rootTypeName)?.fields ?? [];
};

const graphqlOperationsFromSchema = (schema) => [
  ...graphqlRootFields(schema, schema.queryType?.name).map((field) => ({
    id: `query:${field.name}`,
    qualified_id: `query:${field.name}`,
    method: "QUERY",
    path: field.name,
    summary: field.description,
    tags: ["graphql", "query"],
    safety: "read",
    field,
  })),
  ...graphqlRootFields(schema, schema.mutationType?.name).map((field) => ({
    id: `mutation:${field.name}`,
    qualified_id: `mutation:${field.name}`,
    method: "MUTATION",
    path: field.name,
    summary: field.description,
    tags: ["graphql", "mutation"],
    safety: "write",
    field,
  })),
];

const graphqlPackageOperations = async (packageId) => {
  const profile = await readProfile(packageId);
  const schema = await graphqlSchema(profile);
  return graphqlOperationsFromSchema(schema).map(({ field, ...operation }) => operation);
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

const maybeUrl = (value) => {
  try {
    return new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    return null;
  }
};

const unique = (values) => [...new Set(values.filter(Boolean))];

const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const shortHash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 8);

const packageIdFromInput = (input) => {
  const parsed = maybeUrl(input);
  if (!parsed) {
    return slug(input);
  }
  const labels = parsed.hostname.replace(/^www\./, "").split(".");
  return slug(labels.length > 1 ? labels.at(-2) : labels[0]);
};

const profileExists = async (packageId) => {
  try {
    await readProfile(packageId);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const draftProfileText = ({ packageId, name, docsUrl, openapiUrl, graphqlUrl, apisGuru, env }) => {
  const sourceLines = [
    "sources:",
    apisGuru ? `  apis_guru: ${apisGuru}` : null,
    openapiUrl ? `  openapi_url: ${openapiUrl}` : null,
    graphqlUrl ? `  graphql_url: ${graphqlUrl}` : null,
    docsUrl ? `  docs_url: ${docsUrl}` : null,
    !apisGuru && !openapiUrl && !graphqlUrl && !docsUrl ? "  docs_url: unknown" : null,
  ].filter(Boolean);

  return [
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
};

const absoluteUrl = (baseUrl, href) => {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
};

const textLinks = (text) => unique([
  ...[...text.matchAll(/\[[^\]]*]\((https?:\/\/[^)\s]+)\)/g)].map((match) => match[1]),
  ...[...text.matchAll(/https?:\/\/[^\s)]+/g)].map((match) => match[0].replace(/[.,;:]$/, "")),
]);

const htmlLinks = (baseUrl, text) =>
  [...text.matchAll(/href=["']([^"']+)["']/g)]
    .map((match) => absoluteUrl(baseUrl, match[1]))
    .filter(Boolean);

const looksLikeSpecUrl = (url) => /\.(json|ya?ml)(?:[?#].*)?$/i.test(url) && /openapi|swagger|api/i.test(url);

const baseDomain = (hostname) => hostname.replace(/^www\./, "").split(".").slice(-2).join(".");

const likelyDiscoveryUrl = (url, parentHostname) => {
  const parsed = maybeUrl(url);
  if (!parsed) {
    return false;
  }
  const parentBase = baseDomain(parentHostname);
  if (!parsed.hostname.endsWith(parentBase)) {
    return false;
  }
  return /docs?|api|developers?|reference/i.test(`${parsed.hostname} ${parsed.pathname}`);
};

const commonSubdomainOrigins = (origin) => {
  const parsed = maybeUrl(origin);
  if (!parsed) {
    return [];
  }
  const domain = baseDomain(parsed.hostname);
  return ["docs", "api", "developer", "developers"].map((subdomain) => `${parsed.protocol}//${subdomain}.${domain}`);
};

const hostResolves = async (hostname) => {
  try {
    await Promise.race([
      lookup(hostname),
      new Promise((_, reject) => setTimeout(() => reject(new Error("dns timeout")), 3000)),
    ]);
    return true;
  } catch {
    return false;
  }
};

const resolvableOrigins = async (origins) => {
  const checks = await Promise.all(origins.map(async (origin) => {
    const parsed = maybeUrl(origin);
    if (!parsed) {
      return null;
    }
    return await hostResolves(parsed.hostname) ? origin : null;
  }));
  return unique(checks);
};

const discoverLinkedOrigins = async (origins) => {
  const linkedOrigins = [];
  for (const origin of origins) {
    const parsed = maybeUrl(origin);
    const response = await readText(origin);
    if (!parsed || !response.ok || !response.contentType.includes("text/html")) {
      continue;
    }
    const links = htmlLinks(response.url, response.text).filter((link) => likelyDiscoveryUrl(link, parsed.hostname));
    linkedOrigins.push(...links.map((link) => maybeUrl(link)?.origin));
  }
  return unique(linkedOrigins);
};

const validateOpenApiUrl = async (url) => {
  const response = await readText(url);
  if (!response.ok) {
    return { url, valid: false, status: response.status, kind: "http_error" };
  }

  const trimmed = response.text.trim();
  if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) {
    return {
      url,
      valid: false,
      kind: "html",
      links: htmlLinks(response.url, response.text).filter(looksLikeSpecUrl),
    };
  }

  if (trimmed.startsWith("{")) {
    try {
      const spec = JSON.parse(trimmed);
      return {
        url,
        valid: Boolean((spec.openapi || spec.swagger) && spec.info && spec.paths),
        kind: "openapi_json",
        openapi: spec.openapi ?? spec.swagger,
        title: spec.info?.title,
        paths: Object.keys(spec.paths ?? {}).length,
      };
    } catch {
      return { url, valid: false, kind: "invalid_json" };
    }
  }

  if (/^openapi:\s*/m.test(trimmed)) {
    return { url, valid: false, kind: "openapi_yaml_unsupported" };
  }

  return { url, valid: false, kind: "unknown" };
};

const sourceInputs = async (input) => {
  if (/^[a-z0-9][a-z0-9-]*$/.test(input)) {
    try {
      const profile = await readProfile(input);
      return {
        input,
        package: input,
        name: profile.name,
        apisGuru: profile.apisGuru,
        graphqlUrl: profile.graphqlUrl,
        urls: unique([profile.docsUrl, profile.llmsUrl, profile.openapiUrl, profile.graphqlUrl, ...profile.openapiUrls]),
      };
    } catch {
      // Fall through and treat the value as a domain/search term.
    }
  }

  const url = maybeUrl(input);
  return {
    input,
    package: null,
    name: input,
    apisGuru: null,
    graphqlUrl: null,
    urls: url ? [url.toString()] : [],
  };
};

const candidateId = (type, candidate) => {
  if (candidate.apis_guru) {
    return `${type}-${slug(candidate.apis_guru)}`;
  }
  if (candidate.url) {
    return `${type}-${shortHash(candidate.url)}`;
  }
  if (candidate.urls) {
    return `${type}-${shortHash([...candidate.urls].sort().join("\n"))}`;
  }
  return `${type}-${shortHash(JSON.stringify(candidate))}`;
};

const makeCandidate = (type, candidate) => ({
  id: candidateId(type, candidate),
  type,
  ...candidate,
});

const pushCandidate = (candidates, candidate) => {
  if (!candidates.some((existing) => existing.id === candidate.id)) {
    candidates.push(candidate);
  }
};

const discoverSources = async (input) => {
  const context = await sourceInputs(input);
  const candidates = [];
  const evidence = [];

  const addOpenApiCandidate = async (urls, evidenceItems) => {
    const validations = await Promise.all(urls.map(validateOpenApiUrl));
    const validSpecs = validations.filter((result) => result.valid);
    if (validSpecs.length === 0) {
      evidence.push(...validations.map((result) => ({ source: result.url, detail: `not a valid OpenAPI source: ${result.kind}` })));
      return;
    }

    pushCandidate(candidates, makeCandidate(validSpecs.length === 1 ? "openapi_url" : "openapi_urls", {
      confidence: validSpecs.every((spec) => spec.kind === "openapi_json" || spec.kind === "openapi_yaml") ? "high" : "medium",
      urls: validSpecs.map((spec) => spec.url),
      specs: validSpecs.map((spec) => ({
        url: spec.url,
        openapi: spec.openapi,
        title: spec.title,
        paths: spec.paths,
      })),
      evidence: evidenceItems,
    }));
  };

  if (context.apisGuru) {
    pushCandidate(candidates, makeCandidate("apis_guru", {
      confidence: "high",
      apis_guru: context.apisGuru,
      evidence: [{ source: `pkgs/${context.package}/profile.yaml`, detail: `profile already defines APIs.guru entry ${context.apisGuru}` }],
    }));
  }

  if (context.graphqlUrl) {
    pushCandidate(candidates, makeCandidate("graphql_url", {
      confidence: "high",
      url: context.graphqlUrl,
      evidence: [{ source: `pkgs/${context.package}/profile.yaml`, detail: `profile already defines GraphQL endpoint ${context.graphqlUrl}` }],
    }));
  }

  const query = context.urls[0] ? maybeUrl(context.urls[0])?.hostname.replace(/^www\./, "") : context.name;
  if (query) {
    const apiMatches = await searchApis(query);
    const exactMatch = apiMatches.find((match) => match.name === query || match.name.startsWith(`${query}:`));
    if (exactMatch) {
      pushCandidate(candidates, makeCandidate("apis_guru", {
        confidence: "high",
        apis_guru: exactMatch.name,
        url: exactMatch.spec,
        evidence: [{ source: API_INDEX_URL, detail: `matched APIs.guru entry ${exactMatch.name}` }],
      }));
    }
  }

  const directRootUrls = unique(context.urls.map((value) => maybeUrl(value)?.origin).filter(Boolean));
  const linkedRootUrls = await discoverLinkedOrigins(directRootUrls);
  const subdomainRootUrls = await resolvableOrigins(directRootUrls.flatMap(commonSubdomainOrigins));
  const rootUrls = unique([
    ...directRootUrls,
    ...linkedRootUrls,
    ...subdomainRootUrls,
  ]);
  const probeUrls = unique([
    ...context.urls.filter(looksLikeSpecUrl),
    ...rootUrls.flatMap((origin) => [
      `${origin}/openapi.json`,
      `${origin}/swagger.json`,
      `${origin}/openapi.yaml`,
      `${origin}/swagger.yaml`,
    ]),
  ]);

  const graphqlProbeUrls = unique(rootUrls.flatMap((origin) => [
    `${origin}/graphql`,
    `${origin}/api/graphql`,
  ]));

  for (const url of probeUrls) {
    const validation = await validateOpenApiUrl(url);
    if (validation.valid) {
      await addOpenApiCandidate([url], [{ source: url, detail: `validated ${validation.kind}` }]);
    } else if (validation.kind === "html" && validation.links.length > 0) {
      await addOpenApiCandidate(validation.links, [{ source: url, detail: "parsed OpenAPI index links from HTML" }]);
    }
  }

  for (const url of graphqlProbeUrls) {
    const validation = await probeGraphqlUrl(url);
    if (validation.valid) {
      pushCandidate(candidates, makeCandidate("graphql_url", {
        confidence: validation.status === 200 ? "high" : "medium",
        url: validation.url,
        evidence: [{ source: validation.url, detail: `validated GraphQL probe with HTTP ${validation.status}` }],
      }));
    }
  }

  const llmsUrls = unique([
    ...context.urls.filter((url) => url.endsWith("/llms.txt") || url.endsWith("llms.txt")),
    ...rootUrls.map((origin) => `${origin}/llms.txt`),
  ]);

  for (const url of llmsUrls) {
    const response = await readText(url);
    if (!response.ok) {
      continue;
    }

    const links = textLinks(response.text);
    const openApiLinks = links.filter(looksLikeSpecUrl);
    const mcpLinks = links.filter((link) => link.includes("/_mcp/"));
    if (mcpLinks.length > 0) {
      pushCandidate(candidates, makeCandidate("mcp_url", {
        confidence: "high",
        url: mcpLinks[0],
        evidence: [{ source: url, detail: "found MCP URL in llms.txt" }],
      }));
    }

    if (openApiLinks.length > 0) {
      for (const openApiLink of openApiLinks) {
        const validation = await validateOpenApiUrl(openApiLink);
        if (validation.valid) {
          await addOpenApiCandidate([openApiLink], [{ source: url, detail: "found OpenAPI link in llms.txt" }]);
        } else if (validation.kind === "html" && validation.links.length > 0) {
          await addOpenApiCandidate(validation.links, [{ source: openApiLink, detail: "parsed OpenAPI index links linked from llms.txt" }]);
        }
      }
    }
  }

  return {
    input,
    package: context.package,
    status: candidates.length > 0 ? "candidates_found" : "no_candidates",
    candidates,
    evidence,
  };
};

const confidenceRank = (candidate) => ({ high: 3, medium: 2, low: 1 })[candidate.confidence] ?? 0;

const preferredCandidateOfType = (candidates, type) =>
  candidates
    .filter((candidate) => candidate.type === type)
    .sort((left, right) => confidenceRank(right) - confidenceRank(left))[0];

const preferredSourceCandidate = (candidates) =>
  preferredCandidateOfType(candidates, "openapi_urls")
  ?? preferredCandidateOfType(candidates, "openapi_url")
  ?? preferredCandidateOfType(candidates, "apis_guru")
  ?? preferredCandidateOfType(candidates, "graphql_url")
  ?? preferredCandidateOfType(candidates, "mcp_url")
  ?? candidates[0];

const generatePackage = async (input) => {
  const packageId = packageIdFromInput(input);
  assertPackageId(packageId);

  const existed = await profileExists(packageId);
  if (!existed) {
    const parsed = maybeUrl(input);
    const docsUrl = parsed?.toString() ?? maybeUrl(`https://${input}`)?.toString() ?? null;
    await mkdir(packageDirectoryUrl(packageId), { recursive: true });
    await writeFile(new URL("profile.yaml", packageDirectoryUrl(packageId)), draftProfileText({
      packageId,
      name: packageId,
      docsUrl,
      openapiUrl: null,
      graphqlUrl: null,
      apisGuru: null,
      env: null,
    }), { flag: "wx" });
  }

  const discovery = await discoverSources(packageId);
  const candidate = preferredSourceCandidate(discovery.candidates);
  const applied = candidate && ["apis_guru", "openapi_url", "openapi_urls", "graphql_url", "mcp_url"].includes(candidate.type);
  if (applied) {
    await applyCandidateToProfile(packageId, candidate);
  }

  const validation = await validateProfile(packageId);
  let auth = null;
  if (validation.status === "ok" || validation.status === "unsupported") {
    auth = await authPlan(packageId);
  }

  return {
    input,
    package: packageId,
    status: validation.status === "ok" && auth?.status === "ready" ? "ready" : validation.status === "ok" ? "needs_auth_detail" : validation.status,
    created: !existed,
    profile: `pkgs/${packageId}/profile.yaml`,
    selected_source: candidate ? {
      id: candidate.id,
      type: candidate.type,
      confidence: candidate.confidence,
    } : null,
    validation,
    auth: auth ? {
      status: auth.status,
      mode: auth.runtime?.mode,
      required_env: unique([
        auth.profile_auth?.env,
        auth.profile_auth?.usernameEnv,
        auth.profile_auth?.passwordEnv,
        auth.profile_auth?.refreshTokenEnv,
        auth.profile_auth?.accessTokenEnv,
        auth.profile_auth?.organizationIdEnv,
      ]),
      gaps: auth.gaps ?? [],
    } : null,
    commands: validation.status === "ok" ? [
      `api-code-mode ${packageId} ops`,
      `api-code-mode ${packageId} describe <operation-id>`,
      `api-code-mode ${packageId} call <read-operation-id>`,
    ] : [],
    diagnostics: "Private discovery, planning, auth, and validation commands remain available for agents and maintainers.",
  };
};

const replaceSourcesBlock = (profileText, lines) => {
  const block = `${lines.join("\n")}\n`;
  const sourcesBlock = /^sources:\n(?:  .+\n|    - .+\n)+/m;
  if (!sourcesBlock.test(profileText)) {
    throw new Error("Could not replace sources block in profile.yaml");
  }
  return profileText.replace(sourcesBlock, block);
};

const applyCandidateToProfile = async (packageId, candidate) => {
  const profile = await readProfile(packageId);
  const sourceLines = [
    "sources:",
    profile.docsUrl ? `  docs_url: ${profile.docsUrl}` : null,
    profile.llmsUrl ? `  llms_url: ${profile.llmsUrl}` : null,
    profile.mcpUrl ? `  mcp_url: ${profile.mcpUrl}` : null,
    profile.graphqlUrl ? `  graphql_url: ${profile.graphqlUrl}` : null,
    candidate.type === "graphql_url" && candidate.url !== profile.graphqlUrl ? `  graphql_url: ${candidate.url}` : null,
    candidate.type === "apis_guru" ? `  apis_guru: ${candidate.apis_guru}` : null,
    candidate.type === "mcp_url" && candidate.url !== profile.mcpUrl ? `  mcp_url: ${candidate.url}` : null,
    candidate.type === "openapi_url" ? `  openapi_url: ${candidate.urls[0]}` : null,
    candidate.type === "openapi_urls" ? "  openapi_urls:" : null,
    ...(candidate.type === "openapi_urls" ? candidate.urls.map((url) => `    - ${url}`) : []),
  ].filter(Boolean);

  const nextProfile = replaceSourcesBlock(profile.text, sourceLines);
  await writeFile(new URL("profile.yaml", packageDirectoryUrl(packageId)), nextProfile);
};

const applyDiscoveryCandidate = async (packageId) => {
  assertPackageId(packageId);
  const candidateId = parseFlag("--candidate", null);
  if (!candidateId) {
    throw new Error("discover-apply requires --candidate <id>");
  }

  const discovery = await discoverSources(packageId);
  const candidate = discovery.candidates.find((item) => item.id === candidateId);
  if (!candidate) {
    throw new Error(`Discovery candidate not found: ${candidateId}`);
  }

  await applyCandidateToProfile(packageId, candidate);
  return {
    package: packageId,
    applied: candidate.id,
    candidate,
    validation: await validateProfile(packageId),
  };
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

const operationSafety = (method) => method === "GET" ? "read" : method === "DELETE" ? "destructive" : "write";

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
    safety: operationSafety(match.method),
    parameters: (operation.parameters ?? []).map((parameter) => resolveRef(spec, parameter)),
    requestBody: resolveRef(spec, operation.requestBody),
    security: operation.security ?? spec.security ?? [],
  };
};

const describePackageOperation = async (packageId, id) => {
  const detail = describeOperation(await fetchPackageSpecs(packageId), id);
  const auth = await authPlan(packageId);
  return {
    ...detail,
    auth: {
      status: auth.status,
      mode: auth.runtime?.mode,
      required_env: unique([
        auth.profile_auth?.env,
        auth.profile_auth?.usernameEnv,
        auth.profile_auth?.passwordEnv,
        auth.profile_auth?.refreshTokenEnv,
        auth.profile_auth?.accessTokenEnv,
        auth.profile_auth?.organizationIdEnv,
      ]),
      gaps: auth.gaps ?? [],
    },
  };
};

const findGraphqlOperation = (schema, id) => {
  const operations = graphqlOperationsFromSchema(schema);
  return operations.find((operation) => operation.qualified_id === id)
    ?? operations.find((operation) => operation.id === id)
    ?? operations.find((operation) => operation.path === id);
};

const describeGraphqlOperation = async (packageId, id) => {
  const profile = await readProfile(packageId);
  const schema = await graphqlSchema(profile);
  const operation = findGraphqlOperation(schema, id);
  if (!operation) {
    throw new Error(`GraphQL operation not found: ${id}`);
  }
  const returnType = graphqlTypeRef(operation.field.type);
  const auth = await authPlan(packageId);
  return {
    id: operation.id,
    qualified_id: operation.qualified_id,
    method: operation.method,
    path: operation.path,
    summary: operation.summary,
    description: operation.summary,
    safety: operation.safety,
    parameters: (operation.field.args ?? []).map((arg) => ({
      name: arg.name,
      required: graphqlTypeRef(arg.type).required,
      type: graphqlTypeRef(arg.type).display,
      description: arg.description,
      default: arg.defaultValue,
    })),
    return_type: returnType.display,
    auth: {
      status: auth.status,
      mode: auth.runtime?.mode,
      required_env: unique([
        auth.profile_auth?.env,
        auth.profile_auth?.usernameEnv,
        auth.profile_auth?.passwordEnv,
        auth.profile_auth?.refreshTokenEnv,
        auth.profile_auth?.accessTokenEnv,
        auth.profile_auth?.organizationIdEnv,
      ]),
      gaps: auth.gaps ?? [],
    },
  };
};

const securitySchemes = (spec) =>
  Object.entries({ ...(spec.components?.securitySchemes ?? {}), ...(spec.securityDefinitions ?? {}) })
    .map(([name, scheme]) => ({
      name,
      type: scheme.type,
      in: scheme.in,
      name_in_request: scheme.name,
      scheme: scheme.scheme,
      flows: scheme.flows ? Object.keys(scheme.flows) : undefined,
      scopes: scheme.flows
        ? Object.values(scheme.flows).flatMap((flow) => Object.keys(flow.scopes ?? {})).slice(0, 12)
        : scheme.scopes ? Object.keys(scheme.scopes).slice(0, 12) : undefined,
    }));

const authLikeParameters = (specs, auth) =>
  specs.flatMap(({ spec, source }, specIndex) =>
    Object.entries(spec.paths ?? {}).flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method))
        .flatMap(([method, operation]) =>
          (operation.parameters ?? [])
            .map((parameter) => resolveRef(spec, parameter))
            .filter((parameter) => {
              const name = parameter.name?.toLowerCase?.() ?? "";
              const authNames = ["authorization", "api_key", "apikey", "x-api-key"];
              const required = parameter.required === true;
              const tokenIsAuth = name === "token" && required;
              const keyIsAuth = name === "key" && (auth.type === "api_key" || auth.queryParam === "key" || (auth.type === "unknown" && required));
              return ["header", "query"].includes(parameter.in) && (authNames.includes(name) || tokenIsAuth || keyIsAuth);
            })
            .map((parameter) => ({
              operation: operation.operationId ?? `${method.toUpperCase()} ${path}`,
              qualified_id: `${specSlug(spec, specIndex)}:${operation.operationId ?? `${method.toUpperCase()} ${path}`}`,
              source,
              in: parameter.in,
              name: parameter.name,
              required: parameter.required === true,
              description: parameter.description,
              confidence: ["authorization", "api_key", "apikey", "x-api-key"].includes(parameter.name?.toLowerCase?.() ?? "") ? "high" : "medium",
              reason: parameter.name?.toLowerCase?.() === "token" ? "required token parameter" : parameter.name?.toLowerCase?.() === "key" ? "api_key profile uses key parameter" : "standard auth parameter name",
            })),
        ),
    ),
  );

const authInjectionFromScheme = (scheme, auth) => {
  if (scheme.type === "http" && scheme.scheme === "bearer") {
    return { in: "header", name: "Authorization", value_template: `Bearer \${${auth.env ?? "TOKEN"}}` };
  }
  if (scheme.type === "http" && scheme.scheme === "basic") {
    return { in: "header", name: "Authorization", value_template: `Basic base64(\${${auth.usernameEnv ?? "USERNAME"}}:\${${auth.passwordEnv ?? "PASSWORD"}})` };
  }
  if (scheme.type === "apiKey") {
    return { in: scheme.in, name: scheme.name_in_request, value_template: `\${${auth.env ?? "API_KEY"}}` };
  }
  if (scheme.type === "oauth2") {
    return { in: "header", name: "Authorization", value_template: `Bearer \${${auth.env ?? "OAUTH_ACCESS_TOKEN"}}` };
  }
  return null;
};

const profileAuthInjection = (auth) => {
  if (auth.type === "bearer") {
    return { in: "header", name: auth.header ?? "Authorization", value_template: `${auth.scheme ?? "Bearer"} \${${auth.env ?? "TOKEN"}}` };
  }
  if (auth.type === "api_key") {
    if (!auth.queryParam && !auth.header) {
      return null;
    }
    return { in: auth.queryParam ? "query" : "header", name: auth.queryParam ?? auth.header, value_template: `\${${auth.env ?? "API_KEY"}}` };
  }
  if (auth.type === "basic") {
    return { in: "header", name: "Authorization", value_template: `Basic base64(\${${auth.usernameEnv ?? "USERNAME"}}:\${${auth.passwordEnv ?? "PASSWORD"}})` };
  }
  if (auth.type === "oauth2") {
    return { in: "header", name: "Authorization", value_template: `Bearer \${${auth.env ?? "OAUTH_ACCESS_TOKEN"}}` };
  }
  return null;
};

const authParameterValueTemplate = (auth, parameter) => {
  const name = parameter.name.toLowerCase();
  if (name === "authorization" && auth.type === "basic") {
    return `Basic base64(\${${auth.usernameEnv ?? "USERNAME"}}:\${${auth.passwordEnv ?? "PASSWORD"}})`;
  }
  if (name === "authorization" && ["bearer", "oauth2", "token_exchange"].includes(auth.type)) {
    return `${auth.scheme ?? "Bearer"} \${${auth.env ?? auth.accessTokenEnv ?? "TOKEN"}}`;
  }
  return `\${${auth.env ?? auth.accessTokenEnv ?? "TOKEN"}}`;
};

const tokenParameterInjections = (auth, parameters) =>
  [...new Map(parameters
    .filter((parameter) => ["header", "query"].includes(parameter.in))
    .map((parameter) => [`${parameter.in}:${parameter.name}`, parameter]))
    .values()]
    .map((parameter) => ({
      in: parameter.in,
      name: parameter.name,
      value_template: authParameterValueTemplate(auth, parameter),
      applies_when_operation_has_parameter: true,
    }));

const authPlan = async (packageId) => {
  const profile = await readProfile(packageId);
  if (profile.graphqlUrl) {
    if (profile.auth.type === "unknown") {
      return {
        package: packageId,
        status: "ready",
        source: "graphql",
        profile_auth: profile.auth,
        runtime: { mode: "none", default_injection: null },
        gaps: [],
      };
    }
    return {
      package: packageId,
      status: "adapter_needed",
      source: "graphql",
      profile_auth: profile.auth,
      runtime: profileAuthInjection(profile.auth) ? {
        mode: profile.auth.type,
        default_injection: profileAuthInjection(profile.auth),
      } : null,
      gaps: ["GraphQL introspection and operation planning are not implemented yet."],
    };
  }

  const specs = await fetchPackageSpecs(packageId);
  const schemes = specs.flatMap(({ spec, source }) => securitySchemes(spec).map((scheme) => ({ ...scheme, source })));
  const parameters = authLikeParameters(specs, profile.auth);
  const schemeInjection = schemes.map((scheme) => authInjectionFromScheme(scheme, profile.auth)).find(Boolean);
  const defaultInjection = profileAuthInjection(profile.auth) ?? schemeInjection;
  const tokenOperation = profile.auth.tokenOperation ? requestPlan(specs, profile.auth.tokenOperation) : null;
  const gaps = [
    profile.auth.type === "unknown" && schemes.length > 0 ? "Profile auth type is unknown; detected machine-readable auth schemes." : null,
    profile.auth.type === "unknown" && parameters.length > 0 ? "Auth-like operation parameters were detected; profile needs auth details." : null,
    profile.auth.type !== "unknown" && !defaultInjection && profile.auth.type !== "token_exchange" ? "Profile auth type is set but runtime injection is incomplete." : null,
    profile.auth.type === "basic" && (!profile.auth.usernameEnv || !profile.auth.passwordEnv) ? "Basic auth needs username_env and password_env in the profile." : null,
    profile.auth.type === "api_key" && !profile.auth.env ? "API key auth needs env in the profile." : null,
    profile.auth.type === "bearer" && !profile.auth.env ? "Bearer auth needs env in the profile." : null,
    profile.auth.type === "oauth2" && !profile.auth.env ? "OAuth2 auth needs env in the profile for an already-issued access token." : null,
    profile.auth.type === "token_exchange" && !profile.auth.tokenOperation ? "Token exchange auth needs token_operation in the profile." : null,
  ].filter(Boolean);

  return {
    package: packageId,
    status: gaps.length === 0 ? "ready" : "needs_profile_detail",
    source: profile.apisGuru ? "apis.guru" : specs.length > 1 ? "openapi_urls" : "openapi_url",
    profile_auth: profile.auth,
    detected: {
      security_schemes: schemes,
      auth_parameters: parameters.slice(0, 25),
    },
    runtime: {
      mode: profile.auth.type === "unknown" && schemeInjection ? "detected_from_spec" : profile.auth.type,
      default_injection: profile.auth.type === "token_exchange" ? null : defaultInjection,
      parameter_injections: tokenParameterInjections(profile.auth, parameters),
      token_exchange: profile.auth.type === "token_exchange" ? {
        operation: profile.auth.tokenOperation,
        request: tokenOperation,
        refresh_token_env: profile.auth.refreshTokenEnv,
        access_token_env: profile.auth.accessTokenEnv,
        organization_id_env: profile.auth.organizationIdEnv,
        default_expiry_seconds: profile.auth.defaultExpirySeconds ? Number.parseInt(profile.auth.defaultExpirySeconds, 10) : undefined,
        default_scopes: profile.auth.defaultScopes,
        token_response_field: profile.auth.tokenResponseField ?? "token",
        request_injection: profile.auth.refreshTokenEnv ? {
          in: "header",
          name: "Authorization",
          value_template: `${profile.auth.scheme ?? "Bearer"} \${${profile.auth.refreshTokenEnv}}`,
        } : undefined,
      } : undefined,
    },
    exceptions: [
      parameters.length > 0 ? "Some operations model auth as explicit parameters; inject these per operation before falling back to securitySchemes." : null,
      schemes.some((scheme) => scheme.type === "oauth2") && profile.auth.type === "bearer" ? "OAuth scope metadata is present, but the local runtime can use an already-issued bearer token from env." : null,
    ].filter(Boolean),
    gaps,
  };
};

const serverUrl = (spec) => {
  if (spec.servers?.[0]?.url) {
    return spec.servers[0].url;
  }
  if (spec.host) {
    return `${spec.schemes?.includes("https") ? "https" : spec.schemes?.[0] ?? "https"}://${spec.host}${spec.basePath ?? ""}`;
  }
  return "";
};

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
    safety: operationSafety(operation.method),
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

const applyTemplateValues = (urlTemplate, parameters) =>
  Object.entries(parameters).reduce(
    (url, [name, value]) => url.replaceAll(`{${name}}`, encodeURIComponent(value)),
    urlTemplate,
  );

const responsePreview = async (response) => {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (contentType.includes("application/json")) {
    try {
      return { json: JSON.parse(text) };
    } catch {
      return { text: text.slice(0, 2000), truncated: text.length > 2000 };
    }
  }
  return { text: text.slice(0, 2000), truncated: text.length > 2000 };
};

const authInjectionKey = (injection) => `${injection.in}:${injection.name}`.toLowerCase();

const operationSecurityRequired = (security) =>
  Array.isArray(security) && security.some((entry) => entry && Object.keys(entry).length > 0);

const operationAuthInjections = async (packageId, plan) => {
  const auth = await authPlan(packageId);
  if (auth.status !== "ready") {
    throw new Error(`Auth is not ready for ${packageId}: ${(auth.gaps ?? []).join("; ")}`);
  }

  const operationParameterKeys = new Set([
    ...plan.query_parameters.map((parameter) => `query:${parameter.name}`.toLowerCase()),
    ...plan.header_parameters.map((parameter) => `header:${parameter.name}`.toLowerCase()),
  ]);
  const parameterInjections = (auth.runtime?.parameter_injections ?? [])
    .filter((injection) => operationParameterKeys.has(authInjectionKey(injection)));
  const defaultInjection = auth.runtime?.default_injection;
  const needsDefaultInjection = defaultInjection && operationSecurityRequired(plan.security);
  const tokenExchangeInjection = auth.runtime?.token_exchange?.access_token_env ? {
    in: "header",
    name: "Authorization",
    value_template: `${auth.profile_auth.scheme ?? "Bearer"} \${${auth.runtime.token_exchange.access_token_env}}`,
  } : null;

  return unique([
    ...parameterInjections,
    needsDefaultInjection ? defaultInjection : null,
    operationSecurityRequired(plan.security) && !defaultInjection ? tokenExchangeInjection : null,
  ]);
};

const applyAuthInjections = (url, headers, injections, explicitParameters) => {
  for (const injection of injections) {
    if (explicitParameters[injection.name] !== undefined) {
      continue;
    }
    const value = renderValueTemplate(injection.value_template);
    if (injection.in === "query" && !url.searchParams.has(injection.name)) {
      url.searchParams.set(injection.name, value);
    }
    if (injection.in === "header" && headers[injection.name] === undefined) {
      headers[injection.name] = value;
    }
  }
};

const redactedUrl = (url, secretQueryNames) => {
  const copy = new URL(url.toString());
  for (const name of secretQueryNames) {
    if (copy.searchParams.has(name)) {
      copy.searchParams.set(name, "[redacted]");
    }
  }
  return copy.toString();
};

const callOperation = async (packageId, id, args) => {
  const parameters = parseParamValues(args);
  const dryRun = args.includes("--dry-run");
  const plan = requestPlan(await fetchPackageSpecs(packageId), id);
  if (plan.safety !== "read") {
    throw new Error("Only read-only GET operations can be called by the spike runtime.");
  }

  const authInjections = await operationAuthInjections(packageId, plan);
  const injectedParameters = new Set(authInjections.map((injection) => authInjectionKey(injection)));
  const missingPath = plan.path_parameters.filter((parameter) => parameter.required && parameters[parameter.name] === undefined);
  const missingQuery = plan.query_parameters
    .filter((parameter) => parameter.required && parameters[parameter.name] === undefined && !injectedParameters.has(`query:${parameter.name}`.toLowerCase()));
  const missingHeaders = plan.header_parameters
    .filter((parameter) => parameter.required && parameters[parameter.name] === undefined && !injectedParameters.has(`header:${parameter.name}`.toLowerCase()));
  const missing = [...missingPath, ...missingQuery, ...missingHeaders].map((parameter) => parameter.name);
  if (missing.length > 0) {
    throw new Error(`Missing required parameters: ${missing.join(", ")}`);
  }

  const url = new URL(applyTemplateValues(plan.url_template, parameters));
  for (const parameter of plan.query_parameters) {
    if (parameters[parameter.name] !== undefined && !url.searchParams.has(parameter.name)) {
      url.searchParams.set(parameter.name, parameters[parameter.name]);
    }
  }

  const headers = {};
  for (const parameter of plan.header_parameters) {
    if (parameters[parameter.name] !== undefined) {
      headers[parameter.name] = parameters[parameter.name];
    }
  }
  applyAuthInjections(url, headers, authInjections, parameters);
  const secretQueryNames = authInjections
    .filter((injection) => injection.in === "query" && parameters[injection.name] === undefined)
    .map((injection) => injection.name);

  const request = {
    method: plan.method,
    url: redactedUrl(url, secretQueryNames),
    headers: Object.keys(headers).sort(),
    safety: plan.safety,
  };
  if (dryRun) {
    return { package: packageId, operation: plan.qualified_id, status: "dry_run", request };
  }

  const response = await fetch(url, { method: plan.method, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return {
    package: packageId,
    operation: plan.qualified_id,
    status: response.ok ? "ok" : "http_error",
    request,
    response: {
      status: response.status,
      status_text: response.statusText,
      content_type: response.headers.get("content-type") ?? "",
      ...(await responsePreview(response)),
    },
  };
};

const graphqlVariableType = (type) => graphqlTypeRef(type).display;

const graphqlScalarSelection = async (profile, schema, typeRef) => {
  const ref = graphqlTypeRef(typeRef);
  if (["SCALAR", "ENUM"].includes(ref.kind)) {
    return "";
  }
  const fieldsForType = graphqlSchemaType(schema, ref.named)?.fields ?? await graphqlTypeFields(profile, ref.named);
  const fields = fieldsForType
    .filter((field) => ["SCALAR", "ENUM", "NON_NULL"].includes(field.type.kind) || ["SCALAR", "ENUM"].includes(field.type.ofType?.kind))
    .slice(0, 8)
    .map((field) => field.name);
  return fields.length > 0 ? `{ ${fields.join(" ")} }` : "{ __typename }";
};

const callGraphqlOperation = async (packageId, id, args) => {
  const profile = await readProfile(packageId);
  const schema = await graphqlSchema(profile);
  const operation = findGraphqlOperation(schema, id);
  if (!operation) {
    throw new Error(`GraphQL operation not found: ${id}`);
  }
  if (operation.safety !== "read") {
    throw new Error("Only read-only GraphQL query operations can be called by the spike runtime.");
  }

  const parameters = parseParamValues(args);
  const missing = (operation.field.args ?? [])
    .filter((arg) => graphqlTypeRef(arg.type).required && parameters[arg.name] === undefined)
    .map((arg) => arg.name);
  if (missing.length > 0) {
    throw new Error(`Missing required parameters: ${missing.join(", ")}`);
  }

  const selected = parseRepeatedFlag(args, "--select");
  const selection = selected.length > 0 ? `{ ${selected.join(" ")} }` : await graphqlScalarSelection(profile, schema, operation.field.type);
  const variableDefinitions = (operation.field.args ?? [])
    .map((arg) => `$${arg.name}: ${graphqlVariableType(arg.type)}`)
    .join(", ");
  const argumentList = (operation.field.args ?? [])
    .filter((arg) => parameters[arg.name] !== undefined)
    .map((arg) => `${arg.name}: $${arg.name}`)
    .join(", ");
  const query = [
    "query ApiCodeModeCall",
    variableDefinitions ? `(${variableDefinitions})` : "",
    `{ ${operation.field.name}${argumentList ? `(${argumentList})` : ""} ${selection} }`,
  ].join("");

  if (args.includes("--dry-run")) {
    return {
      package: packageId,
      operation: operation.qualified_id,
      status: "dry_run",
      request: {
        method: "POST",
        url: profile.graphqlUrl,
        query,
        variables: Object.keys(parameters).sort(),
        safety: operation.safety,
      },
    };
  }

  const { response, json, text } = await graphqlRequest(profile.graphqlUrl, { query, variables: parameters }, graphqlAuthHeaders(profile, { requireConfigured: true }));
  return {
    package: packageId,
    operation: operation.qualified_id,
    status: response.ok && !json?.errors ? "ok" : "graphql_error",
    request: {
      method: "POST",
      url: profile.graphqlUrl,
      variables: Object.keys(parameters).sort(),
      safety: operation.safety,
    },
    response: {
      status: response.status,
      status_text: response.statusText,
      content_type: response.headers.get("content-type") ?? "",
      json: json ?? undefined,
      text: json ? undefined : text.slice(0, 2000),
    },
  };
};

const validateProfile = async (packageId) => {
  const profile = await readProfile(packageId);
  if (profile.graphqlUrl) {
    try {
      const operations = await graphqlPackageOperations(packageId);
      return {
        package: packageId,
        status: "ok",
        source: "graphql",
        operations: operations.length,
        methods: unique(operations.map((operation) => operation.method)).sort(),
      };
    } catch (error) {
      return {
        package: packageId,
        status: "unsupported",
        source: "graphql",
        gap: error.message,
      };
    }
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

const parseRepeatedFlag = (args, flagName) =>
  args.flatMap((value, index) => value === flagName ? [args[index + 1]] : [])
    .filter(Boolean);

const parseParamValues = (args) =>
  Object.fromEntries(parseRepeatedFlag(args, "--param").map((entry) => {
    const separator = entry.indexOf("=");
    if (separator === -1) {
      throw new Error("--param values must use name=value");
    }
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));

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

const packageCommand = async (packageId, subcommand, args) => {
  let profile;
  try {
    profile = await readProfile(packageId);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return null;
  }
  if (profile.graphqlUrl && !profile.apisGuru && !profile.openapiUrl && profile.openapiUrls.length === 0) {
    if (!subcommand || subcommand === "ops") {
      try {
        return searchOperations(await graphqlPackageOperations(packageId), args.join(" "));
      } catch {
        return validateProfile(packageId);
      }
    }
    if (subcommand === "describe") {
      return describeGraphqlOperation(packageId, args.join(" "));
    }
    if (subcommand === "call") {
      return callGraphqlOperation(packageId, args[0], args.slice(1));
    }
    return validateProfile(packageId);
  }
  if (!subcommand || subcommand === "ops") {
    return searchOperations(packageOperations(await fetchPackageSpecs(packageId)), args.join(" "));
  }
  if (subcommand === "describe") {
    return describePackageOperation(packageId, args.join(" "));
  }
  if (subcommand === "plan-call") {
    return requestPlan(await fetchPackageSpecs(packageId), args.join(" "));
  }
  if (subcommand === "call") {
    return callOperation(packageId, args[0], args.slice(1));
  }
  throw new Error(`Unknown package command: ${packageId} ${subcommand}`);
};

const main = async () => {
  const packageOptionalCommands = new Set(["gaps", "validate"]);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return publicHelp();
  }
  if (!packageOptionalCommands.has(command) && !packageIdOrQuery) {
    const scoped = await packageCommand(command, "ops", []);
    if (scoped) {
      return scoped;
    }
    throw new Error("Usage: api-code-mode generate <domain-or-url> | api-code-mode <package> ops [query]");
  }

  if (command === "generate") {
    return generatePackage(packageIdOrQuery);
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
  if (command === "discover-sources") {
    return discoverSources(packageIdOrQuery);
  }
  if (command === "discover-apply") {
    return applyDiscoveryCandidate(packageIdOrQuery);
  }
  if (command === "search") {
    return searchApis(packageIdOrQuery);
  }
  if (command === "ops") {
    return searchOperations(packageOperations(await fetchPackageSpecs(packageIdOrQuery)), restArgs.join(" "));
  }
  if (command === "describe") {
    return describePackageOperation(packageIdOrQuery, restArgs.join(" "));
  }
  if (command === "plan-call") {
    return requestPlan(await fetchPackageSpecs(packageIdOrQuery), restArgs.join(" "));
  }
  if (command === "plan-auth") {
    return authPlan(packageIdOrQuery);
  }
  if (command === "gaps") {
    const results = await Promise.all((await packageIds()).map(validateProfile));
    return results.filter((result) => result.status !== "ok");
  }
  if (command === "validate") {
    const ids = packageIdOrQuery ? [packageIdOrQuery] : await packageIds();
    return Promise.all(ids.map(validateProfile));
  }
  const scoped = await packageCommand(command, packageIdOrQuery, restArgs);
  if (scoped) {
    return scoped;
  }
  throw new Error(`Unknown command: ${command}`);
};

main()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
