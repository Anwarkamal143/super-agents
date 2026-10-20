# Security model

The factory uses explicit trust boundaries and fail-closed policy gates. This page is a short orientation, not a certification or a claim that every deployment integration is secure by default.

## Core controls

- Repository instruction files and third-party content are untrusted data; discovery does not execute declared commands.
- Paths are checked against the selected workspace root; manifests describe entrypoints but never import or execute them.
- Harness prompts are passed without shell interpolation.
- Unknown consequential actions are denied. Approval binds an action type to a canonical payload digest and is consumed once.
- Verification requires an explicit absolute executable allowlist and authorization of the exact invocation; it uses `shell: false`, bounds process duration/output, and distinguishes blocked, skipped, cancelled, timed-out, and failed checks.
- Standards and Spec reviews are separate, validate structured output, and use pinned diff context. Missing spec or mismatched repair verification cannot pass.
- Interrupted steps are not replayed automatically; ambiguous side effects require reconciliation.
- Merge and deployment remain human-controlled.

## Integration responsibilities

The package does not authenticate the human who records an approval, guarantee that a harness obeys prompt trust boundaries, automatically redact secrets from process output, provide distributed locking, or make audit history tamper-evident. File locks coordinate cooperating processes on the same host only. Production integrations must wire approval to an authenticated human decision boundary, keep secrets out of summaries and output, use transactional persistence for multi-host writers, and route every consequential side effect through exact-payload authorization.

For assets, trust boundaries, threat scenarios, implemented mitigations, and residual risk, see the [Threat Model and Residual Risk](threat-model.md).
