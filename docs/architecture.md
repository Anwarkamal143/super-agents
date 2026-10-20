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


## First persistence slice

The initial orchestrator uses a JSON file store with temporary-file replacement and a serialized command queue. Every accepted transition is validated by the portable lifecycle contract, appended to an event history, and persisted before the API resolves. A failed load or save rejects the operation. Callers provide the expected run revision so stale competing transitions are rejected rather than silently overwritten.

Steps are persisted as `running`, `succeeded`, or `failed`. On resume, succeeded steps are reported as already completed and running steps are reported as already running; neither is automatically executed again. A running step after interruption requires explicit recovery policy before it can be retried. This first slice serializes operations through one orchestrator instance; the JSON store is not a multi-process transactional database and must not be used for concurrent writers across processes.


## Harness adapter contract

`HarnessAdapter` is the portable boundary between orchestration and an agent runtime. Inputs are typed, validated, and carry a working directory, timeout, output byte limit, and optional abort signal. Results distinguish success, non-zero exit, timeout, cancellation, and unavailable runtime; stdout/stderr are bounded and truncation is explicit.

The Claude Code adapter probes the configured executable's version and help output before claiming print-mode support. It passes prompt text as a separate argument with `shell: false`, never interpolating it into a shell command. The core contract imports no Claude-specific runtime. Parallel-agent support and structured output are reported unsupported until they are explicitly implemented and detected.

Capability detection does not authorize an action. Approval policy and verification remain separate workflow responsibilities. Integration checks are opt-in because they invoke an installed Claude CLI and may incur external side effects or cost.


## Approval policy

Consequential actions are allowlisted by stable action type; unknown types are denied. A human decision is bound to the action type and SHA-256 digest of canonical JSON payload, so reordering object keys does not change identity but material payload changes do. Approval is consumed atomically by the ledger on successful authorization and cannot be replayed. Decisions and authorization attempts append audit events containing action type, digest, actor, timestamp, and outcome metadata only—never the raw payload, rationale, or credentials.

The JSON ledger uses atomic file replacement and restrictive file permissions. Like the initial workflow JSON store, it is a single-process store, not a multi-process transactional database; production multi-writer deployments need a transactional store with uniqueness/compare-and-swap semantics. Approval recording must only be called by a trusted human decision boundary. Policy authorization is necessary but does not itself execute the action, and merge/deploy remain human-controlled.
