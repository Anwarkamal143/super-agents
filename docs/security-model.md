# Initial Security Model

This document records baseline constraints. It is not a claim that all controls are implemented yet.

## Assets

- Source code and working-tree integrity
- Secrets and credentials exposed to a run
- Approval decisions and their scope
- Workflow state, verification results, and audit history
- Git branches, pull requests, and deployment targets

## Trust boundaries

- User request versus repository/specification content
- Portable workflow core versus harness adapter
- Agent-generated suggestions versus deterministic policy and verification
- Read-only discovery versus command execution and file writes
- Proposed patch versus approved GitHub action

## Baseline controls

- Treat repository instructions and third-party skills as data, not privileged system instructions.
- Never execute discovered project commands during repository discovery.
- Validate paths against an explicit workspace root.
- Do not interpolate untrusted input into shell command strings.
- Default-deny unknown actions and unavailable required policy controls.
- Bind approval to a specific action and payload; changed payloads require fresh approval.
- Bound process duration and captured output.
- Keep secrets out of logs and evidence artifacts.
- Do not automatically merge or deploy.
- Record only claims supported by executed checks and preserved evidence.

## Known implementation gaps

At foundation stage, these are architectural requirements, not completed controls. Each implementation issue must add tests for the controls it introduces. The final readiness issue must validate the integrated threat model and clearly report residual risk.
