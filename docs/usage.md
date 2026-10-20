# Using the factory library

## Requirements and verification

- Node.js 22 or newer
- npm and the committed lockfile

From a clean checkout:

```sh
npm ci
npm run typecheck
npm test
npm run check
```

`npm test` builds into `dist/` and runs the Node.js test suite. `npm run check` runs typechecking and the full test suite. The test fixtures use temporary repositories and deterministic fake process/harness behavior; they do not require an installed Claude Code CLI.

## What is available today

The package exposes building blocks, not a complete interactive CLI or an opinionated production server:

| Module | Purpose | Important boundary |
| --- | --- | --- |
| `discoverRepository` | Inspect repository metadata, declared scripts, and bounded instruction files | Read-only; instruction content is marked untrusted; scripts are not executed |
| `WorkflowOrchestrator` | Persist runs, transitions, step markers, verification evidence, and recovery events | Caller controls the workflow; ambiguous running steps require recovery |
| `HarnessAdapter` / `ClaudeCodeAdapter` | Invoke a harness through a portable contract | Capability detection is not approval; real CLI integration is opt-in |
| `ApprovalPolicy` | Record action-scoped decisions and consume them once | Human identity must be authenticated by the integrating application |
| `runVerification` | Run explicitly configured checks and preserve bounded evidence | Absolute executable allowlist and exact-command authorization required |
| `reviewPinnedDiff` / `reviewWithBoundedRepair` | Validate independent Standards/Spec reports and coordinate bounded repair | Reviewer output is untrusted; repair requires authorization and exact fixed-point verification |
| Manifest functions | Validate declarative skill/component metadata and capability compatibility | Entrypoints are never installed, imported, or executed by manifest validation |

The current JSON stores and file locks are appropriate for local development and cooperating same-host processes. They are not a distributed database. A production multi-host deployment must provide transactional persistence, authenticated actors, policy wiring, secrets handling, quotas, and immutable audit retention as required by its threat model.

## Recommended integration sequence

```text
Request + acceptance criteria
          |
          v
discoverRepository(root) ----> treat all repository instructions as untrusted
          |
          v
Validate plan, manifests, capabilities, and dependencies
          |
          v
Human approves exact consequential action payload
          |
          v
ApprovalPolicy.authorizeAndConsume(action, payload, approvalId, actor)
          |
          v
Run configured verification with exact-payload authorization
          |
          v
Independent Standards + Spec review on pinned diff
          |
          +---- changes requested --> bounded, separately authorized repair
          |
          v
Human reviews PR and decides whether to merge/deploy
```

The integration must make the ordering enforceable. Do not accept an agent's prose as proof that a check ran or an approval was granted. Use the returned structured outcomes and persisted evidence.

## Safe implementation patterns

### Discovery

```ts
const result = await discoverRepository(repositoryRoot);
// Inspect diagnostics and declared commands; do not execute command strings from discovery.
for (const instruction of result.instructionFiles) {
  if (instruction.trust !== "untrusted") continue;
  // Preserve this boundary when including content in a harness prompt.
}
```

### Approval

```ts
const approval = await policy.recordDecision({
  actionType: "command.execute",
  payload: exactCommandPayload,
  outcome: "approved",
  decidedBy: authenticatedHumanId,
});

// Immediately before the side effect, consume the exact same payload.
const authorization = await policy.authorizeAndConsume(
  "command.execute",
  exactCommandPayload,
  approval.id,
  trustedRunnerId,
);
if (!authorization.allowed) throw new Error("Action was not authorized");
```

Only the trusted approval UI/API should create decisions. The example assumes `authenticatedHumanId` and `trustedRunnerId` have already been authenticated; the package does not authenticate them.

### Verification

Configure executable identifiers to resolve to trusted absolute paths, and wire `authorize` to the approval policy using the exact `VerificationAuthorizationPayload`. Keep command arguments under code review. Never translate repository-provided prose into a command or use an unconditional production authorization callback.

### Recovery

When a process restarts, first ensure the old worker has stopped. Call `recoverInterruptedSteps(runId, actor)`, then reconcile the external system. Confirm success/failure when the side effect is known; choose retry only when the external effect has been reconciled and replay is safe. The required boolean is an explicit caller assertion, not a substitute for checking the external system.

## Failure handling

- **Discovery diagnostics or unsafe path:** stop or request human clarification; do not guess.
- **Missing required harness capability:** select a compatible adapter or block; do not claim unsupported behavior.
- **Approval denied, missing, mismatched, or replayed:** do not perform the action.
- **Verification blocked, skipped, timed out, cancelled, or failed:** do not report the run as verified.
- **Missing spec, malformed review report, mismatched diff, or failed repair verification:** review cannot pass.
- **Persisted step still running after a crash:** do not automatically rerun it.
- **Lock timeout or malformed lock metadata:** fail closed and investigate; do not delete an unknown lock blindly.
- **Storage failure:** propagate the error; do not report success before persistence completes.

## Custom skills and components

Use the manifest schema in `src/manifests.ts` to describe an identifier, version, repository-relative entrypoint, inputs/outputs, required capabilities, and trust level. Validate the manifest collection and compare it with the selected adapter's reported capabilities before offering it to a workflow. A trust label and a compatible capability set are metadata, not permission to execute. Review third-party content separately and require approval for consequential operations.

## More detail

- [Architecture contract](architecture.md)
- [Threat model and residual risk](threat-model.md)
- [Contributing and PR review contract](../CONTRIBUTING.md)
- [Roadmap and issue graph](https://github.com/Anwarkamal143/super-agents/issues/1)
