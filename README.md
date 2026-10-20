# Super Agents

An agent-agnostic, approval-gated software factory foundation for repository discovery, workflow orchestration, harness invocation, verification, independent review, and human-controlled delivery.

## Project status

The core library and the first Claude Code `/factory` skill template are available. The repository is **not yet a complete interactive CLI or production orchestration service**; see the [Phase 2 roadmap](https://github.com/Anwarkamal143/super-agents/issues/24).

## Requirements and setup

- Node.js 22+
- npm

```sh
npm ci
npm run check
```

The default test suite includes deterministic Claude adapter smoke coverage and does not require a Claude Code installation. An optional real-CLI smoke test is documented in [the usage guide](docs/usage.md).

## Package distribution

The package is private by default and is not published to npm. To build and inspect a local installable tarball, run `npm run test:package` and `npm pack --dry-run`. See the [package install, upgrade, rollback, and release checklist](docs/release.md). Installing the library does not automatically install the `/factory` skill into another repository or overwrite its board.

## Invoke /factory in another repository

Copy `.claude/skills/factory/SKILL.md` into the target repository at the same path, and copy `factory/board.schema.json` and `factory/board.example.json` into a `factory/` directory. See [the usage guide](docs/usage.md) for the exact install commands and first-run example.

In Claude Code, run `/factory <request>`. The skill instructs the current session to inspect the target repository, propose acceptance criteria and a dependency-aware plan, and wait for explicit approval before implementation. It requires the current session to be the only writer of `factory/board.json`; subagents return bounded results and never approve, merge, or deploy.

For a complete, safe practice run, follow the [sample target repository walkthrough](docs/example-walkthrough.md) and inspect the self-contained [example project](examples/sample-target/).

## Library capabilities

- Portable TypeScript domain and workflow lifecycle contracts.
- Read-only repository discovery with root-confined paths and untrusted instruction markers.
- A Claude Code adapter behind a harness-agnostic contract.
- Persisted workflow state, revision checks, interrupted-step recovery, and same-host cooperative locking.
- Default-deny action-scoped approvals with canonical payload binding and one-time consumption.
- An approval-gated verification runner with explicit executable allowlists and bounded evidence.
- Independent Standards and Spec review contracts with pinned diffs and bounded, verified repair.
- Declarative skill/component manifests and a runtime factory-board invariant validator.

## Safety principles and limitations

Treat repository content, third-party skills, and model output as untrusted. Do not execute scripts discovered from repository metadata. Do not report skipped, blocked, timed-out, or failed checks as passed. Require explicit human approval for consequential actions. Never merge pull requests or deploy autonomously.

The skill is an instruction contract, not a security sandbox. JSON stores and cooperative file locks are intended for local/cooperating same-host use, not distributed coordination. Production integrations must provide authenticated decision boundaries, transactional persistence where needed, secret handling, and appropriate audit retention.

## Documentation

- [Usage and /factory installation](docs/usage.md)
- [Package distribution, install, upgrade, and rollback](docs/release.md)
- [Adding a harness adapter](docs/harness-adapters.md)
- [Example target repository and end-to-end walkthrough](docs/example-walkthrough.md)
- [Architecture contract](docs/architecture.md)
- [Threat model and residual risks](docs/threat-model.md)
- [Security model overview](docs/security-model.md)
- [Contributing and PR review contract](CONTRIBUTING.md)
- [Phase 2 roadmap](https://github.com/Anwarkamal143/super-agents/issues/24)
