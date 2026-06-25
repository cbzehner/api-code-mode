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

## Spike Commands

```bash
npm run bootstrap-prompt -- cable
npm run search -- github
npm run ops -- github
npm run ops -- stripe customer
npm run describe -- github apps/delete-installation
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
```

The prompt is meant for an agent runner. It scopes the repair to one package,
asks the agent to find official machine-readable sources, and requires
`npm run validate -- <package>` before reporting back. Direct agent execution is
deliberately deferred until the runner contract is explicit.

See `docs/self-healing.md` for the target `bootstrap-agent` flow.

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
- `cable`: docs-discovered provider with no configured machine-readable spec yet.

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
