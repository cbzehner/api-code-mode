# api-code-mode

Code Mode-inspired API discovery for agents.

The goal is to let agents register APIs dynamically, search for the operation
they need, inspect only that operation's schema, and call it without ingesting a
giant static MCP manifest.

## Shape

```text
pkgs/
  github/
    profile.yaml

runtime:
  search APIs
  register package
  search operations
  describe operation
  call operation
```

This repo intentionally starts small. `pkgs/` stores curated integration
profiles; the runtime resolves upstream specs such as APIs.guru and exposes a
progressive discovery loop.

## Public Flow

Public commands are named for what a human or LLM is trying to do, not for the
runtime phase that implements it. `generate`, `ops`, `describe`, and read-only
`call` are public; source discovery, auth planning, request planning, validation,
and bootstrap repair stay private diagnostics.

```bash
npm run help
npm run generate -- cable.tech
node src/cli.mjs cable ops transaction
node src/cli.mjs cable describe api-reference:request-token
node src/cli.mjs github call github-v3-rest-api:meta/root
```

`call` currently executes only read-only GET operations. Write and destructive
operations fail before making a network request.

`generate` is the user-facing orchestration command. It derives a package id
from the domain, discovers sources, writes or updates `pkgs/<id>/profile.yaml`,
validates the package, and returns the next package-scoped commands.

## Private Diagnostics

The lower-level commands stay available for agents and maintainers, but they do
not appear in public help.

```bash
npm run discover-sources -- cable
npm run discover-apply -- cable --candidate openapi_urls-<hash>
npm run plan-auth -- slack
npm run plan-call -- github apps/delete-installation
npm run validate
npm run gaps
npm run smoke
```

## Self-Healing Profiles

Profiles that fail validation should produce a repair prompt:

```bash
npm run bootstrap-prompt -- cable
npm run bootstrap-prompt -- linear
npm run bootstrap-agent -- cable --runner gemini --timeout-ms 120000
```

The prompt is meant for an agent runner. It scopes the repair to one package,
asks the agent to find official machine-readable sources, and requires
`npm run validate -- <package>` before reporting back. The current
`bootstrap-agent` command invokes Gemini in read-only mode and captures findings;
it does not apply edits.

See `docs/self-healing.md` for the target `bootstrap-agent` flow.

## Source Discovery

`discover-sources` finds machine-readable sources without writing files. It
checks APIs.guru, common OpenAPI/Swagger paths, common GraphQL endpoints,
`llms.txt`, docs MCP links, and OpenAPI index pages. It also follows likely
docs/API/developer links from a homepage and probes common subdomains such as
`docs.*` and `api.*`.
`discover-apply` writes one selected candidate into a profile and reruns
validation.

## Auth Planning

`plan-auth` combines profile auth fields, OpenAPI security schemes, and
auth-looking operation parameters into one JSON runtime plan. Standard cases
produce header/query/basic/OAuth injection templates. Weird cases stay
declarative: Slack exposes required `token` operation parameters, and Cable
uses a token-exchange operation before access-token calls.

## Validation Set

The first `pkgs/` set intentionally mixes API styles:

- `github`: broad, polished OpenAPI via APIs.guru.
- `stripe`: large commercial REST API via APIs.guru.
- `slack`: RPC-shaped HTTP API via APIs.guru.
- `google-gmail`: Google Workspace service via APIs.guru.
- `google-drive`: Google Workspace service via APIs.guru.
- `google-sheets`: Google Workspace service via APIs.guru.
- `notion`: modern SaaS API via APIs.guru.
- `twilio`: broad API family via APIs.guru.
- `linear`: GraphQL API, currently unsupported by the runtime.
- `cable`: Fern-hosted docs with `llms.txt`, MCP metadata, and three OpenAPI specs.
- `weatherbit`, `visualcrossing-weather`, `bulksms`, `sms77`, `interzoid-currency-rate`: smaller provider APIs via APIs.guru.

## Why Not A Mega-MCP?

A mega-MCP forces the agent to load every endpoint as a tool. This keeps the MCP
surface tiny:

```text
search_apis
register_api
search_operations
describe_operation
call_operation
```

The agent pulls detail only when it needs it.

## Rust Rewrite

The Node runtime is a behavior spike. Keep command output compatible with
`CONTRACT.md`; rebuild the real CLI in Rust once the command shape and package
profile fields stop moving.
