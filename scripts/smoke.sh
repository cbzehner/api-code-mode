#!/usr/bin/env bash
set -euo pipefail

npm run validate >/tmp/api-code-mode-validate.json
npm run gaps >/tmp/api-code-mode-gaps.json
npm run bootstrap-prompt -- cable >/tmp/api-code-mode-cable-bootstrap.json
npm run ops -- stripe customer >/tmp/api-code-mode-stripe-customer.json
npm run plan-call -- github apps/delete-installation >/tmp/api-code-mode-github-delete-plan.json
npm run plan-call -- google-sheets sheets.spreadsheets.values.get >/tmp/api-code-mode-sheets-get-plan.json

node -e '
const fs = require("fs");
const validate = JSON.parse(fs.readFileSync("/tmp/api-code-mode-validate.json", "utf8").split("\n").slice(3).join("\n"));
const gaps = JSON.parse(fs.readFileSync("/tmp/api-code-mode-gaps.json", "utf8").split("\n").slice(3).join("\n"));
const cableBootstrap = JSON.parse(fs.readFileSync("/tmp/api-code-mode-cable-bootstrap.json", "utf8").split("\n").slice(3).join("\n"));
const sheetsPlan = JSON.parse(fs.readFileSync("/tmp/api-code-mode-sheets-get-plan.json", "utf8").split("\n").slice(3).join("\n"));

if (validate.filter((result) => result.status === "ok").length !== 8) {
  throw new Error("expected 8 package profiles to validate");
}
if (gaps.length !== 2) {
  throw new Error("expected 2 known gaps");
}
if (!cableBootstrap.prompt.includes("pkgs/cable/profile.yaml")) {
  throw new Error("expected bootstrap prompt to scope edits to the cable profile");
}
if (sheetsPlan.url_template.includes("//v4")) {
  throw new Error("expected normalized Google Sheets URL template");
}
'

echo "smoke ok"
