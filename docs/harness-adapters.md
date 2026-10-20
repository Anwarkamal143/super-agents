# Adding a harness adapter

The portable contract lives in `src/harness.ts`: `HarnessAdapter`, `HarnessInvocation`, `HarnessCapabilities`, and `HarnessResult`. The contract does not import a particular agent SDK or CLI. The Claude Code implementation in `src/claude-code.ts` is one adapter, not the definition of the whole system.

## Adapter responsibilities

1. Give the adapter a stable, unique `id`.
2. Implement `detectCapabilities()` with the actual capabilities available in the current environment. Do not claim unsupported structured output or parallel-agent behavior.
3. Validate invocations with `validateInvocation()` before doing work.
4. Treat `prompt` as data, not shell syntax. If invoking a process is required, pass arguments without shell interpolation and use a trusted executable path.
5. Enforce the requested timeout and output-byte bound, honor cancellation when supported, and report truncation explicitly.
6. Return distinct outcomes: `succeeded`, `failed`, `timed_out`, `cancelled`, or `unavailable`. A non-zero exit, missing capability, truncation, or timeout must not be represented as success.
7. Keep approval and verification policy separate. Capability detection is not authorization to perform a consequential action.

## Portable contract tests

`tests/harness-contract.test.mjs` applies the same contract assertions to two implementations:

- `ClaudeCodeAdapter` backed by an injected fake process (no installed CLI or credentials).
- `ScriptedHarnessAdapter`, a deterministic test fixture that does not import Claude-specific code or spawn a process.

The scripted adapter is test support, not a production agent runtime. It proves that a second implementation can satisfy the public contract without depending on the Claude adapter. Adapter-specific tests should additionally cover each runtime's unique behavior, including spawn errors, timeouts, cancellation, output truncation, and capability detection.

Run the contract and full test suite:

```sh
npm run check
```

These tests use no external service, API key, or real agent CLI. Passing them proves interface compatibility for the tested cases; it does not prove that every future adapter is secure or that prompt-based approval instructions are enforced outside the model.
