# Threat model and residual risk

This document describes the controls present in the current library modules. It is not a certification, penetration-test report, or claim that every deployment integration is secure by default.

## Scope and security objectives

The factory is a TypeScript library for coordinating repository discovery, harness invocation, approval, verification, review, manifests, and persisted workflow state. The current repository does **not** provide a complete end-user CLI or a production multi-host service. Verification outcomes are persisted one check at a time by the MCP bridge; a persistence failure stops the sequence before later checks can start, but local JSON storage is not transactional or remotely durable. Integrators own authentication, authorization identity, durable deployment storage, and wiring the modules together.

Security objectives:

- Repository and model-authored content cannot silently become privileged instructions or executable commands.
- Consequential operations fail closed unless an exact action payload is approved.
- Verification evidence reflects observed outcomes and distinguishes failure, cancellation, timeout, skip, and block.
- Recovery does not blindly replay ambiguous external side effects.
- Secrets are not intentionally copied into approval audit payloads or verification environment evidence.
- The factory does not merge pull requests or deploy autonomously.

## Assets

| Asset | Security property |
| --- | --- |
| Repository source and workspace | Integrity; path containment |
| Secrets and environment values | Confidentiality; least exposure |
| Approval decisions | Authentic decision boundary, exact scope, one-time consumption |
| Workflow state and audit events | Consistency, ordered updates, useful recovery history |
| Verification reports | Integrity of observed status and bounded output |
| Review input and reports | Pinned diff identity; schema validation; no invented spec |
| Git branches, PRs, deployments | Human-controlled consequential changes |

## Trust boundaries

1. **Request/spec versus repository content:** issue descriptions, AGENTS/README files, skills, manifests, generated patches, and model output are untrusted data.
2. **Discovery versus execution:** discovery reports declared scripts and reads bounded instruction files; it does not execute discovered scripts.
3. **Portable core versus harness:** adapter invocation is an explicit boundary. Prompts must be passed as arguments or stdin, never shell-interpolated.
4. **Proposal versus consequential action:** approval binds a known action type to a canonical payload digest. The trusted human decision endpoint is outside this package.
5. **Check configuration versus process execution:** verification uses an explicit absolute executable allowlist, exact-command authorization, `shell: false`, workspace-contained working directories, bounded output, timeouts, environment-key allowlists, and fail-closed handling for stdout/stderr stream errors. If termination signals fail, the runner reports an unconfirmed termination as failed rather than passing; it cannot guarantee that an operating-system process is gone when the host denies or fails termination.
6. **Review output versus acceptance:** standards and spec reviewers return untrusted structured output; schemas and pinned diff context are validated before aggregation.
7. **Local persistence versus distributed service:** JSON stores and cooperative file locks are local persistence primitives, not distributed consensus or database transactions.

## Threats, mitigations, and residual risk

| Threat | Implemented mitigation | Residual risk / required integration control |
| --- | --- | --- |
| Prompt injection in repository instructions | Discovery marks instruction files untrusted and does not execute them; trust boundaries are explicit in architecture docs | Any downstream model prompt builder must preserve the untrusted boundary; this library cannot force a harness to follow it |
| Path traversal or symlink escape | Root-confined discovery path resolution; manifest entrypoint normalization; verification working-directory containment | Filesystem races and platform-specific semantics require defense-in-depth in integrations; revalidate before writes |
| Arbitrary command execution | Verification requires an absolute executable allowlist, exact payload authorization, and `shell: false`; discovery never runs scripts | Allowlisted executables and their arguments remain powerful; human review of trusted check configuration is required |
| Approval replay or payload substitution | Canonical JSON digest, action allowlist, one-time consumption, same-host file lock, default deny | Human identity/authentication is external; file locking is not cross-host; production multi-writer systems need transactional uniqueness/CAS |
| Secret leakage through evidence | Verification inherits only named environment keys and records no environment values; approval events store payload digests rather than raw payloads; workflow audit details are digested | Captured stdout/stderr and operational step summaries can still contain secrets; integrations must redact and callers must not put secrets in summaries |
| Stale or competing workflow updates | Expected revision checks and cooperative same-host transaction lock | Does not protect multi-host writers or unreliable network filesystems |
| Crash during external side effect | Running steps become interrupted; retry requires explicit reconciliation assertion | The assertion is caller-supplied, not proof; stop the old worker and query/reconcile the external system before retry |
| False passing review | Distinct standards/spec axes, pinned commits and diff digest, validated reports, missing spec blocks pass, bounded authorized repair and exact-fixed-point verification | Review quality remains probabilistic; tests and human review remain necessary |
| Malicious manifest / skill entrypoint | Schema validation, duplicate/path checks, capability preflight; entrypoints are declarative and never imported or executed | A compatible manifest is not trusted code and grants no permissions; callers must separately review and authorize execution |
| Audit tampering or deletion | Events are retained with persisted workflow/approval snapshots | Events are not cryptographically chained or remotely immutable; use an external append-only audit sink for regulated or hostile environments |
| Denial of service | Bounded process timeout/output, bounded repair attempts, bounded instruction reads and lock waits; bridge awaits per-check evidence persistence before advancing | Overall request quotas, concurrency caps, storage quotas, and rate limits are integration responsibilities; a local storage failure may leave the current step interrupted and requires reconciliation |

## Operational rules

- Authenticate the human decision-maker before calling `recordDecision`; never expose approval creation directly to repository/model output.
- Route each consequential action through `authorizeAndConsume` immediately before the side effect. Do not reuse a prior approval for a changed payload.
- Bind the verification authorization callback to the exact payload and the approval policy. Never use an unconditional `authorize: async () => true` in production.
- Review configured executable paths and arguments as code. `shell: false` prevents shell parsing; it does not make an executable or its arguments harmless.
- Call `recoverInterruptedSteps` only after confirming the prior worker is no longer active. Reconcile external state before retry.
- Keep credentials out of step summaries, prompts, command output, and review reports. Redact outputs before persistence or display.
- Use a transactional store with compare-and-swap/uniqueness for multi-host deployments; do not put the JSON stores on shared network filesystems without validated locking guarantees.
- Keep merge and deployment actions human-controlled.

## Validation evidence

The repository test suite includes focused checks for path traversal and symlink escapes, discovery non-execution, exact verification authorization, `shell: false`, bounded output, approval payload mismatch/replay, interrupted-step reconciliation, manifest validation, malformed review output, and readiness happy/blocked paths. CI is the authoritative source for the current branch's typecheck and full test results; do not infer a passing CI result from a local or mocked test alone.

## Out of scope

This project does not currently claim a complete CLI product, remote worker orchestration, distributed locking, tamper-evident audit retention, automatic credential redaction, autonomous merge/deploy, or proof that a third-party harness obeys trust-boundary instructions.
