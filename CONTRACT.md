# Runtime Contract

This contract is the behavior to preserve when the spike runtime is rewritten in
Rust.

## Commands

```bash
api-code-mode bootstrap-prompt <package>
api-code-mode bootstrap-new <package> [--name name] [--docs-url url] [--openapi-url url] [--graphql-url url] [--apis-guru id] [--env ENV_VAR]
api-code-mode bootstrap-agent <package> --runner gemini [--timeout-ms 120000]
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
  graphql_url: https://api.example.com/graphql
  docs_url: https://docs.example.com
```

Only `apis_guru` and `openapi_url` are executable today. `graphql_url` and
`docs_url` are validation gaps until adapters exist.

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
