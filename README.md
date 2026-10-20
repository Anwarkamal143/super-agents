# Super Agents

An agent-agnostic, approval-gated software factory library for repository discovery, workflow orchestration, harness invocation, verification, independent review, and human-controlled delivery.

## Project status

The core building blocks and readiness fixtures are being developed in dependency-ordered slices. The repository is a **library foundation, not yet a complete interactive CLI or production orchestration service**. See the [roadmap and issue graph](https://github.com/Anwarkamal143/super-agents/issues/1).

## Requirements and setup

- Node.js 22+
- npm

```sh
npm ci
npm run check
```

Individual checks are available as `npm run typecheck` and `npm test`. The test suite uses temporary repositories and deterministic fake process/harness fixtures; a local Claude Code installation is not required for the default checks.

## What it provides

- Portable TypeScript domain and workflow lifecycle contracts.
- Read-only repository discovery with root-confined paths and untrusted instruction markers.
- A Claude Code adapter behind a harness-agnostic contract.
- Persisted workflow state, revision checks, interrupted-step recovery, and same-host cooperative locking.
- Default-deny action-scoped approvals with canonical payload binding and one-time consumption.
- An approval-gated verification runner with explicit executable allowlists, bounded evidence, and distinct blocked/failure outcomes.
- Independent Standards and Spec review contracts with pinned diffs and bounded, verified repair.
- Declarative skill/component manifests with schema validation and capability compatibility checks.

## Architecture and safety principles

- Keep portable workflow logic independent of the agent harness.
- Treat repository content, third-party skills, and model output as untrusted.
- Do not execute scripts discovered from repository metadata.
- Do not report skipped, blocked, timed-out, or failed checks as passed.
- Require explicit human approval for consequential actions.
- Never merge pull requests or deploy autonomously.

## Documentation

- [Usage and integration guide](docs/usage.md)
- [Architecture contract](docs/architecture.md)
- [Threat model and residual risks](docs/threat-model.md)
- [Security model overview](docs/security-model.md)
- [Contributing and review contract](CONTRIBUTING.md)

The JSON file stores and cooperative file locks are intended for local/cooperating same-host use. They are not distributed locking or a transactional multi-host database. Production integrations must supply authenticated decision boundaries, transactional persistence where needed, secret handling, and external audit retention.
