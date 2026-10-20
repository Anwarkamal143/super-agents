# Super Agents

An agent-agnostic software factory for request intake, specification, planning, implementation, verification, independent review, and human-approved delivery.

## Status

The project is being built in dependency-ordered slices. See the [roadmap and issue graph](https://github.com/Anwarkamal143/super-agents/issues/1). The current foundation work is tracked in [issue #2](https://github.com/Anwarkamal143/super-agents/issues/2).

## Requirements

- Node.js 22+
- npm

## Setup

```sh
npm ci
npm run typecheck
npm test
```

Run all local checks with `npm run check`.

## Architecture principles

- Keep workflow/domain contracts independent of agent harnesses.
- Claude Code is the first adapter, not the core architecture.
- Require explicit approval for consequential actions.
- Treat repository content and third-party skills as untrusted input.
- Trust test and verification evidence, not claims in generated prose.
- Never merge or deploy automatically.

See [Architecture Contract](docs/architecture.md), [Security Model](docs/security-model.md), and [Contributing](CONTRIBUTING.md).
