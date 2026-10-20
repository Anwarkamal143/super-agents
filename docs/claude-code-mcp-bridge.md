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

The hook defaults to deny for `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, and `Bash` unless it finds an active approval for the exact canonical `{ toolName, toolInput }` payload. The approval is consumed once. A changed argument or replay is denied. Other tool integrations and external processes are outside this hook's boundary; keep Claude Code's normal permission controls enabled.

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

Call `factory_verification_run` with the workflow ID and current revision. The bridge validates the profile through the verification runner, then requests a fresh human approval for each exact executable, argument list, resolved working directory, environment-key list, timeout, and output limit before spawning that process. The runner uses `shell: false`, confines the working directory to the repository, and bounds runtime and captured output. The MCP response returns output digests and byte counts, not raw stdout/stderr; persisted evidence is labelled `runner_observed`.

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
