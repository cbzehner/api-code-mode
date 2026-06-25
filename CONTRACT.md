# Runtime Contract

This contract is the behavior to preserve when the spike runtime is rewritten in
Rust.

## Commands

```bash
api-code-mode bootstrap-prompt <package>
api-code-mode bootstrap-new <package> [--name name] [--docs-url url] [--openapi-url url] [--graphql-url url] [--apis-guru id] [--env ENV_VAR]
api-code-mode bootstrap-agent <package> --runner gemini [--timeout-ms 120000]
api-code-mode discover-sources <package-or-url>
api-code-mode discover-apply <package> --candidate <id>
api-code-mode search <query>
api-code-mode ops <package> [query]
api-code-mode describe <package> <operation-id>
api-code-mode plan-call <package> <operation-id>
api-code-mode validate [package]
api-code-mode gaps
```

## Output

Commands print JSON to stdout. Errors print one plain message to stderr and exit
non-zero. The Rust runtime can add TOON later, but JSON is the compatibility
contract for now.

## Packages

Packages live under `pkgs/<id>/profile.yaml`.

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
```

Only `apis_guru`, `openapi_url`, and `openapi_urls` are executable today.
`graphql_url`, `docs_url`, `llms_url`, and `mcp_url` are discovery/adapter
inputs until adapters exist.

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
`llms.txt`, MCP links, and OpenAPI index pages.

`discover-apply` is the only discovery command that writes profile changes. It
recomputes candidates, applies the selected candidate to `sources`, and returns
post-apply validation.

Discovery candidate IDs are content-derived, not positional, so an agent can
pass a selected candidate from `discover-sources` back to `discover-apply`
without relying on list order.
