# Architecture Contract

## Goal

The factory coordinates software work through explicit states and evidence while allowing different agent harnesses to execute bounded tasks. The first adapter is Claude Code, but the core must not depend on Claude-specific prompt formats, slash commands, agent APIs, or runtime packages.

## Intended boundaries

```text
User / CLI
   |
   v
Workflow orchestration ---- Approval policy
   |                             |
   v                             v
Portable domain contracts <--- Audit events
   |
   +---- Harness adapter contract ---- Claude Code adapter
   |                                  + future adapters
   |
   +---- Verification contract ------- approved command runner
   |
   +---- Skill/component manifests --- validation and capability checks
   |
   +---- State store ---------------- persistence implementation
```

- **Domain:** typed entities, lifecycle states, invariants, and transition rules. No I/O or harness-specific imports.
- **Orchestration:** coordinates workflow steps and state changes; it does not decide policy by bypassing policy interfaces.
- **Adapters:** translate portable requests into harness-specific invocation and report actual capabilities.
- **Policy:** default-deny for unknown consequential actions; approval is scoped to the action being authorized.
- **Verification:** reports what actually ran, including failure, timeout, cancellation, or skipped states. Missing evidence is not a pass.
- **State store:** owns persistence and concurrency semantics; callers must not report success before durable writes succeed.
- **Skills/components:** declarative manifests are validated before they are trusted or invoked.

## Execution principles

1. Model workflow transitions explicitly; do not infer state from prose or filenames.
2. Keep side effects behind narrow interfaces and policy checks.
3. Treat repository files, skill content, tool output, and model output as untrusted data.
4. Prefer deterministic checks for gates; use model judgement as advisory evidence, not a replacement for tests or permissions.
5. Human approval is required for consequential actions. The factory never merges its own pull request or deploys autonomously.
6. Capability absence must be explicit. Unsupported parallelism falls back to sequential execution where safe; unsupported safety controls fail closed.
7. Build the smallest working slice first and add abstractions only when a concrete issue needs them.
