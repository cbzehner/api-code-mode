# Runtime Contract

This contract is the behavior to preserve when the spike runtime is rewritten in
Rust.

## Commands

Public commands must be named for the user or agent's goal, not for internal
implementation phases. A command belongs in public help only when a human or LLM
would naturally ask to do that thing. Discovery, auth planning, request planning,
validation, and bootstrap repair are private diagnostics unless they become
directly useful workflows.

```bash
api-code-mode help
api-code-mode generate <domain-or-url>
api-code-mode <package> ops [query]
api-code-mode <package> describe <operation-id>
api-code-mode <package> call <operation-id> [--param name=value]
```

`call` is limited to read-only GET operations in the spike runtime. Write and
destructive operations must fail before any network request is made.

Private diagnostic commands remain stable for agents and maintainers, but they
must not appear in public help:

```bash
api-code-mode bootstrap-prompt <package>
api-code-mode bootstrap-new <package> [--name name] [--docs-url url] [--openapi-url url] [--graphql-url url] [--apis-guru id] [--env ENV_VAR]
api-code-mode bootstrap-agent <package> --runner gemini [--timeout-ms 120000]
api-code-mode discover-sources <package-or-url>
api-code-mode discover-apply <package> --candidate <id>
api-code-mode search <query>
api-code-mode ops <package> [query]
api-code-mode describe <package> <operation-id>
api-code-mode plan-auth <package>
api-code-mode plan-call <package> <operation-id>
api-code-mode validate [package]
api-code-mode gaps
```

## Output

Commands print JSON to stdout. Errors print JSON to stderr and exit non-zero.
The Rust runtime can add TOON later, but JSON is the compatibility contract for
now.

Error objects use this shape:

```json
{
  "status": "error",
  "code": "missing_env",
  "message": "Missing required env vars: PROVIDER_TOKEN",
  "missing_env": ["PROVIDER_TOKEN"],
  "next_actions": ["Set PROVIDER_TOKEN in the environment and retry the command."]
}
```

Known error codes:

- `missing_env`: a configured auth env var is required before the request can run.
- `missing_parameters`: the operation needs additional `--param name=value` inputs.
- `write_call_blocked`: the spike runtime refused to execute a write or destructive call.
- `usage`: the command shape is invalid or unknown.
- `runtime_error`: fallback for unexpected failures.

## Packages

Packages live under `pkgs/<id>/profile.yaml`.

`generate <domain-or-url>` derives a package id from the registrable domain
label, so `cable.tech` and `https://docs.cable.tech/` generate or update
`pkgs/cable/profile.yaml`.

Supported source fields:

```yaml
sources:
  apis_guru: github.com
  openapi_url: https://example.com/openapi.json
  openapi_urls:
    - https://example.com/openapi-a.json
    - https://example.com/openapi-b.json
  graphql_url: https://api.example.com/graphql
  docs_url: https://docs.example.com
  llms_url: https://docs.example.com/llms.txt
  mcp_url: https://docs.example.com/_mcp/server
  server_url: https://api.example.com
```

Only `apis_guru`, `openapi_url`, and `openapi_urls` are executable today.
`graphql_url`, `docs_url`, `llms_url`, and `mcp_url` are discovery/adapter
inputs until adapters exist.
`server_url` overrides missing or unsuitable server metadata in the upstream
spec and is used when planning calls.

Supported auth fields:

```yaml
auth:
  type: bearer | api_key | basic | oauth2 | token_exchange | unknown
  env: PROVIDER_TOKEN
  header: Authorization
  scheme: Bearer
  query_param: key
  username_env: PROVIDER_USERNAME
  password_env: PROVIDER_PASSWORD
  token_operation: api-reference:request-token
  refresh_token_env: PROVIDER_REFRESH_TOKEN
  access_token_env: PROVIDER_ACCESS_TOKEN
  organization_id_env: PROVIDER_ORGANIZATION_ID
  token_response_field: token
  default_expiry_seconds: 86400
  default_scopes:
    - resource:read
```

`plan-auth <package>` returns a structured auth plan. It combines profile auth
facts, OpenAPI security schemes, and auth-looking operation parameters. Operation
parameters named like `token`, `key`, or `Authorization` are reported as
parameter injections because APIs such as Slack model auth there even when OAuth
scope metadata is also present. Inferred auth parameters include confidence and
reason fields because name-based detection is a heuristic.

## Validation Statuses

- `ok`: source resolves and operations can be enumerated.
- `unsupported`: source type is known but not implemented.
- `missing_source`: profile has no supported machine-readable source.
- `failed`: source exists but resolution failed.

## Self-Healing Bootstrap

`bootstrap-prompt <package>` emits a constrained agent task for repairing a
profile. The task must keep edits scoped to `pkgs/<id>/`, avoid secrets, prefer
official machine-readable sources, and rerun validation.

`bootstrap-new <package>` creates `pkgs/<id>/profile.yaml` with a conservative
draft profile. Package ids must use lowercase letters, numbers, and hyphens.
Existing profiles are never overwritten.

`bootstrap-agent <package> --runner gemini` invokes the generated prompt in
read-only runner mode. It must not edit files directly in the spike runtime.
Future implementations may add patch application, but only after patch review
and validation are explicit.

The runner must report `repaired`, `adapter_needed`, `source_missing`, or
`failed`.

Multi-spec packages should expose `qualified_id` values in the form
`<spec>:<operation-id>` so duplicated operation IDs can be called unambiguously.

## Source Discovery

`discover-sources` returns structured JSON candidates. It must not write files.
The deterministic pipeline checks APIs.guru, common OpenAPI/Swagger paths,
common GraphQL endpoints, `llms.txt`, MCP links, likely docs/developer/API links
from homepages, common `docs.*`/`api.*`/`developer.*` subdomains, and OpenAPI
index pages. Guessed subdomains are DNS-checked before HTTP probing.

`discover-apply` is the only discovery command that writes profile changes. It
recomputes candidates, applies the selected candidate to `sources`, and returns
post-apply validation.

Discovery candidate IDs are content-derived, not positional, so an agent can
pass a selected candidate from `discover-sources` back to `discover-apply`
without relying on list order.
