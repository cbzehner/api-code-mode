#!/usr/bin/env bash
set -euo pipefail

cleanup() {
  rm -rf pkgs/smoke-api-code-mode pkgs/smoke-cable-discovery pkgs/smoke-read-post
}
trap cleanup EXIT

cleanup

mkdir -p pkgs/smoke-read-post
cat >pkgs/smoke-read-post/profile.yaml <<'YAML'
id: smoke-read-post
name: Smoke Read POST
sources:
  apis_guru: plaid.com
auth:
  type: api_key
  header_env:
    PLAID-CLIENT-ID: SMOKE_PLAID_CLIENT_ID
    PLAID-SECRET: SMOKE_PLAID_SECRET
    Plaid-Version: SMOKE_PLAID_VERSION
policy:
  default_write: confirm
  read_operations:
    - accountsBalanceGet
output:
  default_format: json
YAML

npm run help >/tmp/api-code-mode-help.json
npm run generate -- cable.tech >/tmp/api-code-mode-generate-cable.json
npm run validate >/tmp/api-code-mode-validate.json
npm run gaps >/tmp/api-code-mode-gaps.json
npm run discover-sources -- github.com >/tmp/api-code-mode-github-discovery.json
npm run discover-sources -- postmarkapp.com >/tmp/api-code-mode-postmark-discovery.json
npm run discover-sources -- cable.tech >/tmp/api-code-mode-cable-domain-discovery.json
node src/cli.mjs discover-sources developer.atlassian.com >/tmp/api-code-mode-atlassian-discovery.json
npm run bootstrap-prompt -- cable >/tmp/api-code-mode-cable-bootstrap.json
npm run bootstrap-new -- smoke-api-code-mode --name "Smoke API" --docs-url https://example.com/docs >/tmp/api-code-mode-bootstrap-new.json
npm run bootstrap-new -- smoke-cable-discovery --name "Smoke Cable Discovery" --docs-url https://docs.cable.tech/ >/tmp/api-code-mode-cable-discovery-new.json
npm run discover-sources -- smoke-cable-discovery >/tmp/api-code-mode-cable-discovery-sources.json
cable_candidate_id="$(node -e '
const fs = require("fs");
const discovery = JSON.parse(fs.readFileSync("/tmp/api-code-mode-cable-discovery-sources.json", "utf8").split("\n").slice(3).join("\n"));
const candidate = discovery.candidates.find((item) => item.type === "openapi_urls");
if (!candidate) process.exit(1);
console.log(candidate.id);
')"
npm run discover-apply -- smoke-cable-discovery --candidate "$cable_candidate_id" >/tmp/api-code-mode-cable-discovery-apply.json
npm run ops -- stripe customer >/tmp/api-code-mode-stripe-customer.json
npm run plan-call -- github apps/delete-installation >/tmp/api-code-mode-github-delete-plan.json
npm run plan-call -- google-sheets sheets.spreadsheets.values.get >/tmp/api-code-mode-sheets-get-plan.json
npm run plan-auth -- cable >/tmp/api-code-mode-cable-auth-plan.json
npm run plan-auth -- slack >/tmp/api-code-mode-slack-auth-plan.json
npm run plan-auth -- sms77 >/tmp/api-code-mode-sms77-auth-plan.json
npm run plan-auth -- twilio >/tmp/api-code-mode-twilio-auth-plan.json
node src/cli.mjs cable ops transaction >/tmp/api-code-mode-cable-scoped-ops.json
node src/cli.mjs github call github-v3-rest-api:meta/root >/tmp/api-code-mode-github-call-root.json
node src/cli.mjs countries ops >/tmp/api-code-mode-countries-ops.json
node src/cli.mjs countries describe query:countries >/tmp/api-code-mode-countries-describe.json
node src/cli.mjs countries call query:countries --select code --select name >/tmp/api-code-mode-countries-call.json
node src/cli.mjs smoke-read-post ops balance >/tmp/api-code-mode-read-post-ops.json
node src/cli.mjs smoke-read-post describe the-plaid-api:accountsBalanceGet >/tmp/api-code-mode-read-post-describe.json
node src/cli.mjs smoke-read-post describe the-plaid-api:itemRemove >/tmp/api-code-mode-read-post-write-describe.json
SMOKE_PLAID_CLIENT_ID=client SMOKE_PLAID_SECRET=secret SMOKE_PLAID_VERSION=2020-09-14 node src/cli.mjs smoke-read-post call the-plaid-api:accountsBalanceGet --dry-run >/tmp/api-code-mode-read-post-dry-run.json
WEATHERBIT_API_KEY=test-key node src/cli.mjs weatherbit call 'weatherbit-interactive-swagger-ui-documentation:GET /alerts?lat={lat}&lon={lon}' --param lat=1 --param lon=1 --dry-run >/tmp/api-code-mode-weatherbit-call-dry-run.json
node src/cli.mjs weatherbit call 'weatherbit-interactive-swagger-ui-documentation:GET /alerts?lat={lat}&lon={lon}' --param lat=1 --param lon=1 --param key=manual-secret --dry-run >/tmp/api-code-mode-weatherbit-call-explicit-key.json
TWILIO_ACCOUNT_SID=AC123 TWILIO_AUTH_TOKEN=secret node src/cli.mjs twilio call twilio-api:ListAccount --dry-run >/tmp/api-code-mode-twilio-call-dry-run.json
if node src/cli.mjs github call github-v3-rest-api:activity/mark-notifications-as-read >/tmp/api-code-mode-github-call-write.json 2>/tmp/api-code-mode-github-call-write.err; then
  echo "expected write call to fail" >&2
  exit 1
fi
if SMOKE_PLAID_CLIENT_ID=client SMOKE_PLAID_SECRET=secret SMOKE_PLAID_VERSION=2020-09-14 node src/cli.mjs smoke-read-post call the-plaid-api:accountsBalanceGet >/tmp/api-code-mode-read-post-call.json 2>/tmp/api-code-mode-read-post-call.err; then
  echo "expected read POST call without dry-run to fail" >&2
  exit 1
fi
if SMOKE_PLAID_CLIENT_ID=client SMOKE_PLAID_VERSION=2020-09-14 node src/cli.mjs smoke-read-post call the-plaid-api:accountsBalanceGet --dry-run >/tmp/api-code-mode-read-post-missing-env.json 2>/tmp/api-code-mode-read-post-missing-env.err; then
  echo "expected read POST dry-run without secret env to fail" >&2
  exit 1
fi
if node src/cli.mjs weatherbit call 'weatherbit-interactive-swagger-ui-documentation:GET /alerts?lat={lat}&lon={lon}' --param lat=1 --param lon=1 --dry-run >/tmp/api-code-mode-weatherbit-call-missing-key.json 2>/tmp/api-code-mode-weatherbit-call-missing-key.err; then
  echo "expected weatherbit call without key to fail" >&2
  exit 1
fi
if node src/cli.mjs linear call query:applicationInfo >/tmp/api-code-mode-linear-call-missing-key.json 2>/tmp/api-code-mode-linear-call-missing-key.err; then
  echo "expected linear call without key to fail" >&2
  exit 1
fi

node -e '
const fs = require("fs");
const help = JSON.parse(fs.readFileSync("/tmp/api-code-mode-help.json", "utf8").split("\n").slice(3).join("\n"));
const generateCable = JSON.parse(fs.readFileSync("/tmp/api-code-mode-generate-cable.json", "utf8").split("\n").slice(3).join("\n"));
const validate = JSON.parse(fs.readFileSync("/tmp/api-code-mode-validate.json", "utf8").split("\n").slice(3).join("\n"));
const gaps = JSON.parse(fs.readFileSync("/tmp/api-code-mode-gaps.json", "utf8").split("\n").slice(3).join("\n"));
const githubDiscovery = JSON.parse(fs.readFileSync("/tmp/api-code-mode-github-discovery.json", "utf8").split("\n").slice(3).join("\n"));
const postmarkDiscovery = JSON.parse(fs.readFileSync("/tmp/api-code-mode-postmark-discovery.json", "utf8").split("\n").slice(3).join("\n"));
const cableDomainDiscovery = JSON.parse(fs.readFileSync("/tmp/api-code-mode-cable-domain-discovery.json", "utf8").split("\n").slice(3).join("\n"));
const atlassianDiscovery = JSON.parse(fs.readFileSync("/tmp/api-code-mode-atlassian-discovery.json", "utf8"));
const cableBootstrap = JSON.parse(fs.readFileSync("/tmp/api-code-mode-cable-bootstrap.json", "utf8").split("\n").slice(3).join("\n"));
const bootstrapNew = JSON.parse(fs.readFileSync("/tmp/api-code-mode-bootstrap-new.json", "utf8").split("\n").slice(3).join("\n"));
const cableDiscovery = JSON.parse(fs.readFileSync("/tmp/api-code-mode-cable-discovery-sources.json", "utf8").split("\n").slice(3).join("\n"));
const cableApply = JSON.parse(fs.readFileSync("/tmp/api-code-mode-cable-discovery-apply.json", "utf8").split("\n").slice(3).join("\n"));
const sheetsPlan = JSON.parse(fs.readFileSync("/tmp/api-code-mode-sheets-get-plan.json", "utf8").split("\n").slice(3).join("\n"));
const cableAuthPlan = JSON.parse(fs.readFileSync("/tmp/api-code-mode-cable-auth-plan.json", "utf8").split("\n").slice(3).join("\n"));
const slackAuthPlan = JSON.parse(fs.readFileSync("/tmp/api-code-mode-slack-auth-plan.json", "utf8").split("\n").slice(3).join("\n"));
const sms77AuthPlan = JSON.parse(fs.readFileSync("/tmp/api-code-mode-sms77-auth-plan.json", "utf8").split("\n").slice(3).join("\n"));
const twilioAuthPlan = JSON.parse(fs.readFileSync("/tmp/api-code-mode-twilio-auth-plan.json", "utf8").split("\n").slice(3).join("\n"));
const cableScopedOps = JSON.parse(fs.readFileSync("/tmp/api-code-mode-cable-scoped-ops.json", "utf8"));
const githubCallRoot = JSON.parse(fs.readFileSync("/tmp/api-code-mode-github-call-root.json", "utf8"));
const countriesOps = JSON.parse(fs.readFileSync("/tmp/api-code-mode-countries-ops.json", "utf8"));
const countriesDescribe = JSON.parse(fs.readFileSync("/tmp/api-code-mode-countries-describe.json", "utf8"));
const countriesCall = JSON.parse(fs.readFileSync("/tmp/api-code-mode-countries-call.json", "utf8"));
const readPostOps = JSON.parse(fs.readFileSync("/tmp/api-code-mode-read-post-ops.json", "utf8"));
const readPostDescribe = JSON.parse(fs.readFileSync("/tmp/api-code-mode-read-post-describe.json", "utf8"));
const readPostWriteDescribe = JSON.parse(fs.readFileSync("/tmp/api-code-mode-read-post-write-describe.json", "utf8"));
const readPostDryRun = JSON.parse(fs.readFileSync("/tmp/api-code-mode-read-post-dry-run.json", "utf8"));
const weatherbitCallDryRun = JSON.parse(fs.readFileSync("/tmp/api-code-mode-weatherbit-call-dry-run.json", "utf8"));
const weatherbitCallExplicitKey = JSON.parse(fs.readFileSync("/tmp/api-code-mode-weatherbit-call-explicit-key.json", "utf8"));
const twilioCallDryRun = JSON.parse(fs.readFileSync("/tmp/api-code-mode-twilio-call-dry-run.json", "utf8"));
const githubCallWriteError = JSON.parse(fs.readFileSync("/tmp/api-code-mode-github-call-write.err", "utf8"));
const readPostCallError = JSON.parse(fs.readFileSync("/tmp/api-code-mode-read-post-call.err", "utf8"));
const readPostMissingEnvError = JSON.parse(fs.readFileSync("/tmp/api-code-mode-read-post-missing-env.err", "utf8"));
const weatherbitMissingKeyError = JSON.parse(fs.readFileSync("/tmp/api-code-mode-weatherbit-call-missing-key.err", "utf8"));
const linearMissingKeyError = JSON.parse(fs.readFileSync("/tmp/api-code-mode-linear-call-missing-key.err", "utf8"));

if (!help.commands.some((command) => command.command === "generate <domain-or-url>")) {
  throw new Error("expected public help to include generate");
}
for (const internalName of ["discover-sources", "plan-auth", "plan-call", "validate", "bootstrap"]) {
  if (JSON.stringify(help).includes(internalName)) {
    throw new Error(`expected public help to hide internal surface: ${internalName}`);
  }
}
if (generateCable.package !== "cable" || generateCable.status !== "ready") {
  throw new Error("expected generate cable.tech to produce ready cable package");
}
if (!cableScopedOps.some((operation) => operation.qualified_id?.includes("transaction"))) {
  throw new Error("expected generated cable package-scoped ops to work");
}
if (!["ok", "http_error"].includes(githubCallRoot.status) || typeof githubCallRoot.response.status !== "number") {
  throw new Error("expected read-only GitHub root call to capture an HTTP response");
}
if (!countriesOps.some((operation) => operation.qualified_id === "query:countries")) {
  throw new Error("expected Countries GraphQL ops to include query:countries");
}
if (countriesDescribe.safety !== "read" || !countriesDescribe.return_type) {
  throw new Error("expected Countries GraphQL describe to expose read safety and return type");
}
if (countriesCall.status !== "ok" || !Array.isArray(countriesCall.response.json?.data?.countries)) {
  throw new Error("expected Countries GraphQL call to return countries data");
}
if (!readPostOps.some((operation) => operation.qualified_id === "the-plaid-api:accountsBalanceGet" && operation.method === "POST" && operation.safety === "read")) {
  throw new Error("expected configured POST operation to appear as read-safe");
}
if (readPostDescribe.method !== "POST" || readPostDescribe.safety !== "read" || !readPostDescribe.requestBody) {
  throw new Error("expected read POST describe to include read safety and request body metadata");
}
if (readPostWriteDescribe.method !== "POST" || readPostWriteDescribe.safety === "read") {
  throw new Error("expected unlisted POST operation to remain non-read");
}
if (readPostDryRun.status !== "dry_run" || readPostDryRun.request.method !== "POST" || readPostDryRun.request.needs_body !== true) {
  throw new Error("expected read POST dry-run to produce a POST request plan with body metadata");
}
for (const header of ["PLAID-CLIENT-ID", "PLAID-SECRET", "Plaid-Version"]) {
  if (!readPostDryRun.request.headers.includes(header)) {
    throw new Error(`expected read POST dry-run to inject ${header}`);
  }
}
if (!weatherbitCallDryRun.request.url.includes("key=%5Bredacted%5D") || weatherbitCallDryRun.request.url.includes("test-key")) {
  throw new Error("expected Weatherbit API key to be injected and redacted");
}
if (!weatherbitCallExplicitKey.request.url.includes("key=%5Bredacted%5D") || JSON.stringify(weatherbitCallExplicitKey).includes("manual-secret")) {
  throw new Error("expected explicit Weatherbit API key to be redacted");
}
if (!twilioCallDryRun.request.headers.includes("Authorization")) {
  throw new Error("expected Twilio basic auth to inject Authorization header");
}
if (JSON.stringify(twilioCallDryRun).includes("secret")) {
  throw new Error("expected Twilio dry-run output to omit secret values");
}
if (githubCallWriteError.code !== "write_call_blocked") {
  throw new Error("expected write call to fail before network request");
}
if (readPostCallError.code !== "write_call_blocked") {
  throw new Error("expected read POST execution to fail before network request");
}
if (readPostMissingEnvError.code !== "missing_env" || !readPostMissingEnvError.missing_env.includes("SMOKE_PLAID_SECRET")) {
  throw new Error("expected read POST dry-run to fail before request without header_env secret");
}
if (weatherbitMissingKeyError.code !== "missing_env" || !weatherbitMissingKeyError.missing_env.includes("WEATHERBIT_API_KEY")) {
  throw new Error("expected Weatherbit call to fail before request without API key");
}
if (linearMissingKeyError.code !== "missing_env" || !linearMissingKeyError.missing_env.includes("LINEAR_API_KEY")) {
  throw new Error("expected Linear GraphQL call to fail before request without API key");
}
if (validate.filter((result) => result.status === "ok").length !== 17) {
  throw new Error("expected 17 package profiles to validate");
}
if (gaps.length !== 0) {
  throw new Error("expected no known validation gaps");
}
if (!githubDiscovery.candidates.some((candidate) => candidate.type === "apis_guru")) {
  throw new Error("expected GitHub discovery to find an APIs.guru candidate");
}
if (!postmarkDiscovery.candidates.some((candidate) => candidate.type === "apis_guru" && candidate.apis_guru.startsWith("postmarkapp.com"))) {
  throw new Error("expected Postmark discovery to use exact APIs.guru candidate without deep probing");
}
if (!cableDomainDiscovery.candidates.some((candidate) => candidate.type === "openapi_urls" || candidate.type === "openapi_url")) {
  throw new Error("expected Cable domain discovery to find OpenAPI candidates");
}
if (!atlassianDiscovery.candidates.some((candidate) => candidate.type === "graphql_url")) {
  throw new Error("expected Atlassian discovery to find a GraphQL candidate");
}
if (!cableBootstrap.prompt.includes("pkgs/cable/profile.yaml")) {
  throw new Error("expected bootstrap prompt to scope edits to the cable profile");
}
if (bootstrapNew.package !== "smoke-api-code-mode") {
  throw new Error("expected bootstrap-new to create the smoke package");
}
if (!cableDiscovery.candidates.some((candidate) => candidate.type === "openapi_urls")) {
  throw new Error("expected Cable docs discovery to find multiple OpenAPI specs");
}
if (cableApply.validation.status !== "ok") {
  throw new Error("expected discover-apply to create a valid Cable-derived profile");
}
if (sheetsPlan.url_template.includes("//v4")) {
  throw new Error("expected normalized Google Sheets URL template");
}
if (cableAuthPlan.runtime.token_exchange?.operation !== "api-reference:request-token") {
  throw new Error("expected Cable auth plan to include token exchange operation");
}
if (!slackAuthPlan.runtime.parameter_injections.some((injection) => injection.name === "token")) {
  throw new Error("expected Slack auth plan to include token parameter injection");
}
if (sms77AuthPlan.runtime.default_injection?.name !== "X-API-Key") {
  throw new Error("expected sms77 auth plan to use OpenAPI X-API-Key header");
}
if (!twilioAuthPlan.runtime.default_injection?.value_template.includes("TWILIO_ACCOUNT_SID")) {
  throw new Error("expected Twilio auth plan to use configured basic auth envs");
}
'

echo "smoke ok"
