# Using the factory

## Requirements and verification

- Node.js 22 or newer for the TypeScript library.
- Claude Code for the native `/factory` skill template.
- npm and the committed lockfile for this repository's checks.

From a clean checkout:

```sh
npm ci
npm run check
```

`npm test` builds into `dist/` and runs the Node.js test suite. The deterministic tests do not require a Claude Code installation.

## Install the /factory skill in a target repository

Copy the skill and board template into the target repository. From the root of this repository, run the following in the target repo, adjusting the source path if you installed or cloned this project elsewhere:

```sh
mkdir -p .claude/skills/factory factory
cp /path/to/super-agents/.claude/skills/factory/SKILL.md .claude/skills/factory/SKILL.md
cp /path/to/super-agents/factory/board.schema.json factory/board.schema.json
cp /path/to/super-agents/factory/board.example.json factory/board.example.json
```

Review the copied skill before using it. Keep it under version control so changes are reviewable. If the target repository already has a `factory/board.json`, do not overwrite it; validate and preserve its history first.

Then open Claude Code at the target repository root and invoke:

```text
/factory Add the feature described in issue #123. First inspect the repository, propose acceptance criteria and a dependency-aware plan, and wait for my approval before editing files.
```

Claude Code discovers the skill from `.claude/skills/factory/SKILL.md`. The skill guides the current session to act as orchestrator. The first run should inspect the repository and present a plan; it must not treat invoking `/factory` as blanket approval to implement.

For a complete example with expected artifacts, approval gates, verification, and a blocked-path exercise, follow the [sample target repository walkthrough](example-walkthrough.md).

## Board contract and single-writer rule

- `factory/board.schema.json` is the JSON Schema interchange contract.
- `factory/board.example.json` is illustrative only; it explicitly records no work as completed.
- `validateFactoryBoard(value)` validates runtime essentials, including supported statuses, duplicate IDs, dependency references, cycles, attempt limits, and decision timestamps.
- Only the orchestrator session may write `factory/board.json`. Subagents may return findings or patches, but must not mutate the board or record approvals.
- The example board is not a live run. Copy it to `factory/board.json` only after replacing the example request and IDs with the real request and plan.

The JSON Schema and runtime validator are intentionally separate: the schema defines the interchange shape, while the runtime validator adds dependency graph invariants without adding a schema-validation dependency to the core library. For full standards-compliant JSON Schema validation in an integration, use a trusted Draft 2020-12 validator and fail closed on errors.

## What the library provides today

The package exposes building blocks, not a complete interactive CLI or production orchestration service:

| Module | Purpose | Important boundary |
| --- | --- | --- |
| `discoverRepository` | Inspect repository metadata, declared scripts, and bounded instruction files | Read-only; instruction content is marked untrusted; scripts are not executed |
| `WorkflowOrchestrator` | Persist runs, transitions, step markers, verification evidence, and recovery events | Caller controls the workflow; ambiguous running steps require recovery |
| `HarnessAdapter` / `ClaudeCodeAdapter` | Invoke a harness through a portable contract | Capability detection is not approval; real CLI integration is opt-in |
| `ApprovalPolicy` | Record action-scoped decisions and consume them once | Human identity must be authenticated by the integrating application |
| `runVerification` | Run explicitly configured checks and preserve bounded evidence | Absolute executable allowlist and exact-command authorization required |
| `reviewPinnedDiff` / `reviewWithBoundedRepair` | Validate independent Standards/Spec reports and coordinate bounded repair | Reviewer output is untrusted; repair requires authorization and exact fixed-point verification |
| Manifest functions | Validate declarative skill/component metadata and capability compatibility | Entrypoints are never installed, imported, or executed by manifest validation |

## Recommended integration sequence

```text
Request + repository (untrusted)
            |
            v
Inspect repository -> scope/spec -> dependency plan
            |                  |
            |            human approval
            v                  v
Orchestrator-owned board -> bounded tasks / delegated workers
                                  |
                                  v
                        verification evidence
                                  |
                                  v
                   independent Standards + Spec review
                                  |
                                  v
                       human delivery decision
```

Do not accept an agent's prose as proof that a check ran or an approval was granted. Use structured outcomes and persisted evidence.

## Safe implementation patterns

### Approval

Record decisions only from a trusted human approval interface. Bind approval to an exact action payload and consume it immediately before the side effect. Changed commands or targets require a new approval. The package does not authenticate human identities.

### Verification

Configure executable identifiers to resolve to trusted absolute paths, and wire the authorization callback to the approval policy using the exact `VerificationAuthorizationPayload`. Keep command arguments under code review. Never use an unconditional production authorization callback.

### Recovery

When a process restarts, first ensure the old worker has stopped. Call `recoverInterruptedSteps(runId, actor)`, then reconcile the external system. Confirm success/failure when the side effect is known; choose retry only when the external effect has been reconciled and replay is safe. A required boolean is a caller assertion, not a substitute for checking the external system.

## Failure handling

- Unsafe path or conflicting repository changes: stop and ask.
- Missing required harness capability: select a compatible adapter or block.
- Approval denied, missing, mismatched, or replayed: do not perform the action.
- Verification blocked, skipped, timed out, cancelled, or failed: do not report the run as verified.
- Missing spec, malformed review report, mismatched diff, or failed repair verification: review cannot pass.
- Persisted step still running after a crash: do not automatically rerun it.
- Invalid board schema, unknown dependency, or dependency cycle: preserve the current board and fail closed.
- Storage failure: propagate the error; do not report success before persistence completes.

## Security limitations

The skill is an orchestration instruction contract, not a security sandbox or an autonomous daemon. A model may fail to follow instructions; integrations must enforce privileged operations outside the prompt where needed. Local JSON stores and cooperative file locks are same-host only. Human identity, secret redaction, external audit retention, and production multi-host transactions remain integration responsibilities.

## Claude Code harness smoke test

The default `npm run check` includes deterministic smoke coverage for the actual exported `ClaudeCodeAdapter`, the installed `/factory` skill contract, and the example board. It uses an injected fake process and requires no Claude installation, credentials, or network access. It verifies the adapter's success path and confirms that missing executables, timeouts, non-zero exits, and truncated output are not represented as successful execution.

### Optional live CLI smoke test

This is deliberately opt-in. It invokes your locally installed Claude CLI and may use your configured account/session. Run it only when you intend to test the real adapter.

Prerequisites:
- Node.js 22+ and dependencies installed with `npm ci`.
- Claude Code installed and authenticated according to its official setup instructions.
- Review the smoke prompt and confirm that the CLI invocation is acceptable for your account/environment.

From the repository root:

```sh
npm run build
CLAUDE_CODE_INTEGRATION=1 node --test tests/harness.test.mjs
```

The test creates a unique temporary directory, asks Claude to return the literal `adapter-integration-ok`, verifies the adapter result, and removes the temporary directory in a `finally` block. It does not ask Claude to edit a project, run project scripts, push, create a PR, merge, or deploy. Expected result: the integration test passes and its output contains `adapter-integration-ok`. If Claude CLI is missing, unauthenticated, or lacks print-mode support, the test fails rather than reporting a pass.

Troubleshooting:
- **CLI missing/spawn error:** install or correct the CLI path; default deterministic tests still run.
- **Print mode unsupported:** update Claude Code or inspect `claude --help`; the adapter fails closed when `-p/--print` is not advertised.
- **Non-zero exit:** inspect the returned exit code and stderr; it is a failed result.
- **Timeout/cancellation:** check CLI responsiveness and choose an intentional timeout; these remain distinct non-success outcomes.
- **Output truncated:** raise the configured byte limit only if the caller's policy permits it; truncation is explicitly marked and the output limit is not silently bypassed.

A live smoke pass proves only that this CLI adapter can invoke a bounded prompt in an isolated directory. It does not prove that the model follows the full factory workflow, that approval gates are enforced outside the prompt, or that production integrations are secure.

## More detail

- [Example target repository and end-to-end walkthrough](example-walkthrough.md)
- [Architecture contract](architecture.md)
- [Threat model and residual risk](threat-model.md)
- [Security model overview](security-model.md)
- [Contributing and PR review contract](../CONTRIBUTING.md)
- [Phase 2 roadmap](https://github.com/Anwarkamal143/super-agents/issues/24)
