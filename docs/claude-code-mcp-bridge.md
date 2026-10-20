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

## Workflow tools

1. Call `factory_session_create` with a stable request ID.
2. Inspect the repository and form a bounded plan in the active Claude Code session.
3. Call `factory_plan_request_approval` with the current revision and exact plan. A human decision must arrive through MCP elicitation. Decline, cancel, unsupported elicitation, malformed response, timeout, or persistence failure blocks the plan.
4. Continue work in the active session only after the plan is approved.
5. Before each governed native write or command, call `factory_action_request_approval` with the native tool name and its exact `toolInput`. The hook compares that payload to the real PreToolUse input and consumes the one-time approval.
6. Submit evidence with `factory_evidence_submit`. Evidence submitted by the model is labelled `model-reported-unverified`; it is not trusted runner evidence.
7. Use `factory_phase_transition` with the latest expected revision. `factory_delivery_status` only reports state and never creates a PR, merges, deploys, or publishes.

## Protocol and trust limitations

- The repository did not have a pinned MCP TypeScript SDK dependency. This implementation uses a small built-in Node.js stdio JSON-RPC adapter for the legacy `2025-11-25` elicitation round-trip rather than silently adding a runtime dependency and an ungenerated lockfile. It is intentionally narrow, not a general-purpose MCP implementation.
- The real Claude Code client may negotiate a newer MCP protocol or implement elicitation differently. If the configured client does not support this exact request/response flow, approval fails closed. Do not claim real-host compatibility until the interactive smoke test below passes.
- The host does not provide a cryptographically authenticated human identity to this server. The recorded actor label is provenance metadata, not an authenticated identity claim.
- Local JSON files and cooperative locks are single-host state, not distributed transactions. Do not share the state directory across hosts or run multiple uncoordinated copies.
- The active model can submit misleading evidence. Only independently captured output from a trusted runner can establish that a command/test actually ran.
- The hook cannot control tools or processes outside its configured native-tool matcher. Treat it as defense-in-depth, not a system-wide sandbox.

## Interactive smoke test required before production use

In a disposable target repository and an interactive Claude Code session:

1. Confirm Claude Code's version and that the MCP server connects without protocol errors.
2. Invoke the plan approval tool and choose **decline**; verify the workflow is cancelled and no governed native action is allowed.
3. Start a fresh run, approve the exact plan, then approve one harmless fixture write; verify the active session continues without spawning another CLI orchestration process.
4. Verify a modified payload and a replay are denied by the hook.
5. Test a Bash action and confirm the exact command input is what the human approves.
6. Test unavailable elicitation and a state-directory permission failure; both must fail closed.
7. Record the actual observed UI, Claude Code version, commands and results. Unit tests are not a substitute for this test.
