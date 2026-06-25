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
npm run search -- github
npm run ops -- github
npm run describe -- github apps/delete-installation
```

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
