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

## Verification runner

Verification executes only explicitly configured checks whose executable identifiers resolve through a trusted absolute-path allowlist. Before each spawn, an authorization callback must approve the exact executable, arguments, resolved repository-contained working directory, timeout, output limit, and allowed environment key names. Processes use `shell: false`; repository scripts and instruction text are never parsed into commands by the runner.

Each result records command identity, exit status, timestamps, duration, bounded stdout/stderr, SHA-256 digests of the complete observed streams, observed byte counts, and truncation. Passed, failed, skipped, timed-out, cancelled, and blocked checks are distinct; skipped or blocked checks never count as passed. The runner inherits only an explicit environment-key allowlist and never copies environment values into evidence. A complete verification report is passing only when every configured check passed.

The runner does not itself establish human identity or create approvals. Its authorization callback must be wired to the trusted approval policy and a previously recorded approval scoped to that exact check. Configured command arguments remain trusted configuration and should be reviewed as code.

## Independent review and bounded repair

Standards review and Spec review are separate structured reports over the same pinned base/head commit pair and SHA-256 diff digest. Review input requires an originating issue/spec identifier, a non-empty diff, valid full commit IDs, and repository standards. A missing spec is reported explicitly and blocks a passing aggregate; the factory does not invent acceptance requirements. Malformed review output, mismatched axes, unsafe finding paths, and inconsistent passing reports fail closed.

Repair is a bounded coordinator, not an autonomous permission source. Each repair attempt requires a separate authorization callback; after applying a repair, verification must pass for the exact returned diff and fixed point before either review axis runs again. A failed, incomplete, or mismatched verification blocks the loop. Repair limits are explicitly configured and capped; exhausting the limit returns a blocked result for human intervention. The coordinator does not authenticate the human approver or execute verification itself—callers must wire those callbacks to the trusted approval policy and verification runner.

## Skill/component manifests

A manifest is portable declarative metadata with a schema version, stable lowercase ID, semantic version, description, repository-relative entrypoint, required capability identifiers, typed input/output declarations, and an explicit trust level. The core validates unknown JSON without coercing values and rejects unsupported schema versions, malformed fields, duplicate IDs, and unsafe entrypoint paths. Entrypoints are identifiers only: discovery never imports, installs, or executes them.

Capability discovery compares required capabilities against the adapter's reported capabilities before a manifest can be considered compatible. Missing capabilities are returned explicitly so orchestration can block or ask for a different adapter rather than silently degrading.

Registry changes are explicit `add`, `modify`, or `remove` operations. Each successful operation returns a secret-free audit event containing actor, timestamp, manifest ID, operation, and relevant versions. The caller must durably persist both the updated registry and audit event before reporting success; this module does not claim to provide storage transactions or authenticate the actor. Third-party content remains untrusted regardless of its declared trust label, and trust labels do not grant execution or approval rights.
