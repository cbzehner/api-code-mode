#!/usr/bin/env bash
set -euo pipefail

rm -rf pkgs/smoke-api-code-mode pkgs/smoke-cable-discovery

npm run help >/tmp/api-code-mode-help.json
npm run generate -- cable.tech >/tmp/api-code-mode-generate-cable.json
npm run validate >/tmp/api-code-mode-validate.json
npm run gaps >/tmp/api-code-mode-gaps.json
npm run discover-sources -- github.com >/tmp/api-code-mode-github-discovery.json
npm run discover-sources -- cable.tech >/tmp/api-code-mode-cable-domain-discovery.json
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

node -e '
const fs = require("fs");
const help = JSON.parse(fs.readFileSync("/tmp/api-code-mode-help.json", "utf8").split("\n").slice(3).join("\n"));
const generateCable = JSON.parse(fs.readFileSync("/tmp/api-code-mode-generate-cable.json", "utf8").split("\n").slice(3).join("\n"));
const validate = JSON.parse(fs.readFileSync("/tmp/api-code-mode-validate.json", "utf8").split("\n").slice(3).join("\n"));
const gaps = JSON.parse(fs.readFileSync("/tmp/api-code-mode-gaps.json", "utf8").split("\n").slice(3).join("\n"));
const githubDiscovery = JSON.parse(fs.readFileSync("/tmp/api-code-mode-github-discovery.json", "utf8").split("\n").slice(3).join("\n"));
const cableDomainDiscovery = JSON.parse(fs.readFileSync("/tmp/api-code-mode-cable-domain-discovery.json", "utf8").split("\n").slice(3).join("\n"));
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

if (!help.commands.some((command) => command.command === "generate <domain-or-url>")) {
  throw new Error("expected public help to include generate");
}
if (JSON.stringify(help).includes("discover-sources") || JSON.stringify(help).includes("plan-auth") || JSON.stringify(help).includes("plan-call")) {
  throw new Error("expected public help to hide private diagnostic commands");
}
if (generateCable.package !== "cable" || generateCable.status !== "ready") {
  throw new Error("expected generate cable.tech to produce ready cable package");
}
if (!cableScopedOps.some((operation) => operation.qualified_id?.includes("transaction"))) {
  throw new Error("expected generated cable package-scoped ops to work");
}
if (validate.filter((result) => result.status === "ok").length !== 14) {
  throw new Error("expected 14 package profiles to validate");
}
if (gaps.length !== 1) {
  throw new Error("expected 1 known gap");
}
if (!githubDiscovery.candidates.some((candidate) => candidate.type === "apis_guru")) {
  throw new Error("expected GitHub discovery to find an APIs.guru candidate");
}
if (!cableDomainDiscovery.candidates.some((candidate) => candidate.type === "openapi_urls" || candidate.type === "openapi_url")) {
  throw new Error("expected Cable domain discovery to find OpenAPI candidates");
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

rm -rf pkgs/smoke-api-code-mode pkgs/smoke-cable-discovery

echo "smoke ok"
