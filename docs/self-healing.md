# Self-Healing Profiles

Self-healing means the runtime can turn a validation gap into a bounded repair
task for an agent.

## Current Slice

```bash
npm run gaps
npm run bootstrap-prompt -- cable
npm run bootstrap-prompt -- linear
```

`bootstrap-prompt` emits a scoped agent task. The task tells the agent which
profile failed, what source metadata exists, which files it may edit, and how to
verify the repair.

## Target Flow

```bash
api-code-mode bootstrap-new cable --name Cable --docs-url https://docs.cable.tech/
api-code-mode validate cable
api-code-mode bootstrap-agent cable --runner gemini
api-code-mode validate cable
```

The current spike runner invokes Gemini in read-only mode and returns findings.
Timeouts return `status: "timeout"` and `exit_code: 124` so callers can retry
or switch runners without parsing stderr.
The later mutating runner should:

1. Generate the same prompt as `bootstrap-prompt`.
2. Invoke an explicit configured runner, such as Gemini, Codex, or Claude.
3. Restrict edits to `pkgs/<id>/`.
4. Reject edits containing credentials or hard-coded secret identifiers.
5. Run `validate <id>`.
6. Report one of:
   - `repaired`: validation passes.
   - `adapter_needed`: source exists but runtime lacks the adapter.
   - `source_missing`: no machine-readable source was found.
   - `failed`: the agent could not produce a usable profile.

## Why Prompt First

The repair prompt is the stable contract. Agent execution should be a thin layer
over it, not a separate reasoning path. That keeps the future Rust runtime
simple: profile validation, prompt generation, runner invocation, patch review,
and validation are separate steps.

## Expected Gap Classes

- OpenAPI missing from profile, but discoverable from docs or APIs.guru.
- GraphQL API, requiring an introspection adapter.
- Postman collection, requiring a collection-to-profile importer.
- Docs-only provider, requiring human or LLM-assisted extraction.
- Auth unknown, requiring docs inspection and env-var-only configuration.
