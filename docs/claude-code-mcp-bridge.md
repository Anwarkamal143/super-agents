# Claude Code MCP bridge: local setup

This is an **opt-in local integration**. It does not mutate the consuming repository's Claude Code settings. The bridge keeps the active Claude Code session as the model orchestrator; it does not launch a second model/CLI orchestrator.

## Build

From a checkout of this package, run:

```sh
npm ci
npm run check
npm run build
```

Node.js 22+ is required. The MCP server and hook are emitted to `dist/claude-code-mcp.js` and `dist/claude-code-pretool-hook.js`.

## Configure a target repository

Create a local configuration from this template, replacing both absolute paths. Keep the state directory local to the target repository and do not commit runtime state.

```json
{
  "mcpServers": {
    "super-agents-factory": {
      "command": "node",
      "args": ["/absolute/path/to/super-agents/dist/claude-code-mcp.js"],
      "env": {
        "FACTORY_STATE_DIR": "/absolute/path/to/target-repository/.factory-state"
      }
    }
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(Write|Edit|MultiEdit|NotebookEdit|Bash)$",
        "hooks": [
          {
            "type": "command",
            "command": "FACTORY_STATE_DIR=/absolute/path/to/target-repository/.factory-state node /absolute/path/to/super-agents/dist/claude-code-pretool-hook.js"
          }
        ]
      }
    ]
  }
}
```

Use the supported Claude Code local/project settings mechanism for your environment and review its precedence rules. Do not blindly replace an existing settings file: merge the MCP server and hook entries while preserving other settings. Add `.factory-state/` to the target repository's ignore rules. The state contains workflow history and approval metadata.

**Do not enable the bridge without the PreToolUse gate.** MCP approval is an interaction, not a sandbox. If the hook is absent, misconfigured, or cannot read the same state directory, direct native tool calls are not technically gated by this server.

The hook defaults to deny for `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, and `Bash` unless it finds an active approval for the exact canonical `{ toolName, toolInput }` payload **and** the current workflow revision. A phase/state revision change makes an older approval stale; the hook revokes it and denies the action, even if the run is still active. Legacy approvals without revision metadata are denied and revoked. The hook holds the workflow store's cooperative same-host lock while rechecking active status/revision and consuming the approval, so transitions using that same store cannot interleave between the final check and consumption. The approval is consumed once. A changed argument or replay is denied. This is not a distributed transaction: external actors that bypass the lock protocol and multi-host writers are outside the guarantee. Other tool integrations and external processes are outside this hook's boundary; keep Claude Code's normal permission controls enabled.

## Persisted-state validation and corruption recovery

The workflow store validates each persisted run's required identifiers, recognized status, revision and timestamps, plus the event, step and evidence collection shapes, before returning records to the bridge or native-tool hook. Duplicate run IDs and malformed records fail the read; the hook therefore denies governed actions instead of trusting a parseable but incomplete `run.status`. Historical evidence records may omit the newer `source` provenance field and remain readable for compatibility.

Do not delete, reset, or hand-edit a malformed state file as an automatic recovery step. Preserve a copy, inspect it, and restore or repair it deliberately before retrying. These checks detect structural corruption, not malicious edits by a local actor who can alter both workflow and approval files; the JSON store is not tamper-evident.

## Audit event and evidence validation

Persisted audit events and verification evidence are validated field by field before the store returns them. Event run IDs must match their containing workflow; event status/revision fields and optional step metadata must use recognized values. Evidence must have valid identifiers, kind/outcome, observation timestamp, summary, artifact ID strings, and a recognized provenance value when present. Runner-observed evidence may also carry a structured runner record: validated check ID/status, exit code, duration, observed byte counts, truncation flag, SHA-256 output digests, and an optional bounded reason. Runner metadata is rejected unless the evidence source is `runner_observed`. Its keys are strictly allowlisted, and status must match the enclosing evidence outcome (`passed` → `passed`, `failed`/`timed_out` → `failed`, `skipped` → `skipped`, `cancelled`/`blocked` → `unknown`). Historical evidence without `source` or runner metadata remains supported.

This validation checks structure and consistency only. Structured runner metadata makes results machine-readable but is still local process output metadata, not a cryptographic attestation that a trusted runner executed the claimed check. Do not treat persisted claims as proof beyond the guarantees of the process that wrote them.

## JSON-RPC envelope validation

The stdio bridge validates each parsed JSON-RPC envelope before dispatch. Requests must use `jsonrpc: "2.0"`, a non-empty method, a valid string or finite-number ID when present, and object-shaped MCP params. Invalid request envelopes with a usable ID receive `-32600 Invalid Request`; malformed IDs use a null error ID. Host elicitation responses are separately checked before they can resolve a pending approval request.

Only `notifications/initialized` and `notifications/cancelled` are handled as notifications. A request-only method such as `tools/call` without an ID is ignored and never dispatched, so it cannot create a workflow or mutate persisted state without a correlatable request/response exchange. This is envelope validation for the bridge's minimal supported protocol, not a claim that the adapter implements every JSON-RPC or MCP extension.

## Inbound frame size limit

The stdio bridge accepts newline-delimited JSON-RPC frames up to **1,048,576 bytes (1 MiB)**, measured before UTF-8 decoding and excluding the newline delimiter. Input is copied into a fixed-size buffer; the server does not use an unbounded line accumulator. If a frame exceeds the cap, it is discarded through the next newline and a bounded `-32700` error is emitted without parsing or echoing the payload. Processing resumes with the next frame. CRLF delimiters are supported.

This protects the bridge from oversized single-frame buffering and JSON parsing. It does not cap the size of an individual upstream stream chunk already delivered by Node, or replace host-level process/memory limits.

## Concurrent tool-call limit

The bridge accepts at most **16 in-flight `tools/call` requests**. A request that reuses an ID still in flight receives JSON-RPC `-32600` with a `null` response ID and is not dispatched a second time. The null ID is deliberate: replying with the active ID would be indistinguishable from the original request's eventual response and could incorrectly settle the original client promise. Clients should treat this as an uncorrelated protocol error, not as completion of the original request. A new request arriving at capacity receives `-32000` with a retry-after-completion message; it is not queued and cannot mutate workflow or approval state. Request IDs and capacity slots are released in a `finally` path after success or failure, including host cancellation.

This bounds concurrent tool-handler work and pending elicitation pressure, but it is not a total process resource limit: one active tool can still consume resources within its own documented bounds, and an individual input chunk may already have been allocated by Node. Clients should wait for a response or cancellation before retrying a busy request, using a fresh request ID for each new attempt.

## MCP request validation

The bridge validates raw `tools/call` arguments against the server's published input schema before dispatching a tool handler. This independently enforces required fields, value types, enum membership, string bounds, non-negative safe-integer revisions, and rejection of unexpected fields where the schema sets `additionalProperties: false`. Do not rely on a client or model honoring `tools/list` schemas: malformed arguments are rejected before workflow, approval, or evidence state is mutated.

For `factory_evidence_submit`, the accepted input contract intentionally has no `source`, `provenance`, or caller-supplied evidence object: the handler constructs the persisted record with `source: "model_reported"`. Attempts to add a runner/review provenance label or smuggle a nested evidence object are rejected before dispatch, and therefore cannot append evidence or change readiness counts. The only MCP path that emits `runner_observed` is `factory_verification_run`, after the configured runner reports a completed check. Keep regression tests for direct and nested spoof attempts.

This is request-shape validation, not proof that model-reported evidence is true or that the local host identity is authenticated. A locally privileged actor who can modify workflow JSON can still rewrite provenance labels; this store does not provide tamper evidence or cryptographic attestation. Keep the PreToolUse gate and normal Claude Code permissions enabled.

## Approval-ledger validation

The file-backed approval store validates every approval and audit event before returning ledger state. It rejects malformed action/outcome/status values, invalid timestamps or payload digests, missing identity fields, invalid optional scope metadata, and duplicate approval/event IDs. A malformed ledger makes policy operations fail closed; the PreToolUse hook denies the governed action when it cannot load trustworthy state.

If validation fails, preserve a copy of the file and investigate or restore a known-good ledger deliberately. Do not silently drop records or auto-repair the ledger, because doing so could erase one-time consumption or audit history. These checks validate structure and basic consistency only: they do not detect a malicious rewrite that preserves a valid JSON shape, authenticate the actor, or provide cryptographic tamper evidence.

## Operator-configured verification runner

The bridge can execute a verification profile through the existing bounded runner. Configure `FACTORY_VERIFICATION_PROFILE` in the MCP server process environment with operator-reviewed JSON. The profile is **not** accepted as an MCP tool argument and is never discovered from repository files.

Example profile (replace the executable path and review the exact arguments for your environment):

```json
{
  "allowedExecutables": {
    "node": "/absolute/path/to/node"
  },
  "checks": [
    {
      "id": "typecheck",
      "kind": "typecheck",
      "executable": "node",
      "args": ["./node_modules/typescript/bin/tsc", "--noEmit"],
      "cwd": ".",
      "timeoutMs": 60000,
      "maxOutputBytes": 65536,
      "environmentAllowlist": ["PATH", "HOME", "TMPDIR"]
    }
  ]
}
```

Call `factory_verification_run` with the workflow ID and current revision. The bridge validates the profile through the verification runner, then requests a fresh human approval for each exact executable, argument list, resolved working directory, environment-key list, timeout, and output limit before spawning that process. The runner uses `shell: false`, confines the working directory to the repository, and bounds runtime and captured output. Exceeding the combined output limit fails the check even if the process exits successfully after termination is requested; retained output remains bounded while digests and observed byte counts cover all received output. Timeout, cancellation, output overflow, and output-stream errors request SIGTERM followed by bounded SIGKILL escalation if the child remains alive. Stream errors fail the check; if SIGKILL fails or termination cannot be confirmed, the runner records a failed result rather than reporting success, but cannot guarantee the operating system has stopped that process. Checks execute sequentially and fail fast. Each result (including skipped records after a stop condition) is persisted as workflow evidence before the runner advances; if that persistence callback fails, the runner rejects and no later check is authorized or spawned. Previously persisted records remain available, while the current step may require recovery/reconciliation. This is local best-effort durability, not a transaction across process execution and JSON storage. Checks a failed, timed-out, blocked, or cancelled check stops the run before later checks can request approval or spawn a process. Remaining checks still receive explicit `skipped` result records with a reason; an explicitly configured skip does not itself stop later checks. The MCP response returns output digests and byte counts, not raw stdout/stderr; persisted evidence is labelled `runner_observed`.

**The profile is privileged operator configuration.** An approved interpreter can execute code supplied in its arguments, and package scripts may launch further processes. Review every executable and argument in the profile; do not blindly trust a repository's scripts or set the profile from repository-controlled data. This local runner is not a sandbox. Keep host permissions and the PreToolUse gate enabled. A declined or unavailable approval produces blocked/incomplete evidence and does not spawn that check. Runner-observed provenance means this process observed the configured command locally; it is not a cryptographic attestation or proof of an independently trusted runner.

## Workflow tools

1. Call `factory_session_create` with a stable request ID.
2. Inspect the repository and form a bounded plan in the active Claude Code session.
3. Call `factory_plan_request_approval` with the current revision and exact plan. A human decision must arrive through MCP elicitation. Decline, cancel, unsupported elicitation, malformed response, timeout, or persistence failure blocks the plan.
4. Continue work in the active session only after the plan is approved.
5. Before each governed native write or command, call `factory_action_request_approval` with the native tool name and its exact `toolInput`. The hook compares that payload to the real PreToolUse input and consumes the one-time approval.
6. Call `factory_verification_run` to execute the operator-configured verification profile. Each check needs a fresh exact invocation approval and emits `runner_observed` evidence. Use `factory_evidence_submit` only for claims made by the active model; those are always labelled `model_reported`.
7. `factory_delivery_status` reports evidence counts and pass states by provenance and always keeps human delivery approval required. Use `factory_phase_transition` with the latest expected revision. The bridge never creates a PR, merges, deploys, or publishes.

## Protocol and trust limitations

- The repository did not have a pinned MCP TypeScript SDK dependency. This implementation uses a small built-in Node.js stdio JSON-RPC adapter for the legacy `2025-11-25` elicitation round-trip rather than silently adding a runtime dependency and an ungenerated lockfile. It is intentionally narrow, not a general-purpose MCP implementation.
- The real Claude Code client may negotiate a newer MCP protocol or implement elicitation differently. If the configured client does not support this exact request/response flow, approval fails closed. Do not claim real-host compatibility until the interactive smoke test below passes.
- The host does not provide a cryptographically authenticated human identity to this server. The recorded actor label is provenance metadata, not an authenticated identity claim.
- Local JSON files and cooperative locks are single-host state, not distributed transactions. Do not share the state directory across hosts or run multiple uncoordinated copies.
- The active model can submit misleading evidence. Persisted provenance distinguishes model assertions (`model_reported`), process observations (`runner_observed`), and review-engine results (`review_engine`). Provenance labels are not cryptographic attestations; only independently operated, trusted runner infrastructure can establish a stronger execution guarantee.
- The hook cannot control tools or processes outside its configured native-tool matcher. Treat it as defense-in-depth, not a system-wide sandbox.

## Persisted step validation

The JSON workflow store validates step IDs, statuses, non-empty start timestamps, optional attempt counts, and optional completion fields before returning persisted state. When present, `finishedAt` and `summary` must be non-empty strings; `attempt` must be a positive safe integer. Steps marked `succeeded` or `failed` must include both completion fields. Running and interrupted steps may omit them because interruption recovery deliberately preserves an unfinished attempt for human reconciliation.

Malformed step state is rejected rather than repaired or silently normalized. This is structural validation, not proof that a step actually ran or that a stored timestamp is truthful.

## Interactive smoke test required before production use

Use the [interactive smoke-test report template](./claude-code-smoke-report-template.md) to capture version details, actual UI observations, evidence, and blocked/not-run steps. The template is intentionally blank until someone runs the test in a real interactive Claude Code session.

In a disposable target repository and an interactive Claude Code session:

1. Confirm Claude Code's version and that the MCP server connects without protocol errors.
2. Invoke the plan approval tool and choose **decline**; verify the workflow is cancelled and no governed native action is allowed.
3. Start a fresh run, approve the exact plan, then approve one harmless fixture write; verify the active session continues without spawning another CLI orchestration process.
4. Verify a modified payload and a replay are denied by the hook.
5. Test a Bash action and confirm the exact command input is what the human approves.
6. Test unavailable elicitation and a state-directory permission failure; both must fail closed.
7. Record the actual observed UI, Claude Code version, commands and results. Unit tests are not a substitute for this test.

## Restart and interrupted-step recovery

The bridge exposes `factory_session_recover_interrupted` and `factory_step_reconcile` for operator-controlled recovery. Recovery first asks the host for explicit approval, rechecks the workflow revision and exact set of running steps, then marks those steps `interrupted`. It never retries commands automatically. Each interrupted step must be reconciled individually after inspecting whether its process or external effect completed. Confirming success/failure is a human assertion, not runner-observed evidence. Retrying requires a separate exact step/resolution/reason prompt and explicit human confirmation that replay is safe; stale state after elicitation is rejected. If host elicitation is unavailable, recovery/reconciliation is blocked.
