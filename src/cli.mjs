import { readFile } from "node:fs/promises";

const API_INDEX_URL = "https://api.apis.guru/v2/list.json";

const [command, packageIdOrQuery, operationId] = process.argv.slice(2);

const readJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
};

const latestVersion = (api) => api.versions[api.preferred] ?? Object.values(api.versions).at(-1);

const loadIndex = async () => readJson(API_INDEX_URL);

const readProfile = async (packageId) => {
  const text = await readFile(new URL(`../pkgs/${packageId}/profile.yaml`, import.meta.url), "utf8");
  const apisGuru = text.match(/apis_guru:\s*(.+)/)?.[1]?.trim();
  if (!apisGuru) {
    throw new Error(`pkgs/${packageId}/profile.yaml must define sources.apis_guru`);
  }
  return { id: packageId, apisGuru };
};

const fetchSpec = async (packageId) => {
  const profile = await readProfile(packageId);
  const index = await loadIndex();
  const api = index[profile.apisGuru];
  if (!api) {
    throw new Error(`API not found in APIs.guru index: ${profile.apisGuru}`);
  }
  return readJson(latestVersion(api).swaggerUrl);
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

const describeOperation = (spec, id) => {
  const match = operations(spec).find((operation) => operation.id === id);
  if (!match) {
    throw new Error(`Operation not found: ${id}`);
  }

  const operation = spec.paths[match.path][match.method.toLowerCase()];
  return {
    ...match,
    description: operation.description,
    parameters: operation.parameters ?? [],
    requestBody: operation.requestBody,
    security: operation.security ?? spec.security ?? [],
  };
};

const main = async () => {
  if (!command || !packageIdOrQuery) {
    throw new Error("Usage: npm run search -- <query> | npm run ops -- <package> | npm run describe -- <package> <operationId>");
  }

  if (command === "search") {
    return searchApis(packageIdOrQuery);
  }
  if (command === "ops") {
    return operations(await fetchSpec(packageIdOrQuery)).slice(0, 25);
  }
  if (command === "describe") {
    return describeOperation(await fetchSpec(packageIdOrQuery), operationId);
  }
  throw new Error(`Unknown command: ${command}`);
};

main()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
