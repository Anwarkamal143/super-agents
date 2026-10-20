# Sample target repository

This is a deliberately tiny Node.js project used by the [factory walkthrough](../../docs/example-walkthrough.md). It is a fixture for learning and review, not a production application.

## Current project

- Node.js 22+
- Native ES modules
- Tests: `node --test`
- Source: `src/greeting.js`

Run the existing baseline from this directory:

```sh
node --test
```

## Suggested factory exercise

Read [FEATURE_REQUEST.md](FEATURE_REQUEST.md). The request is intentionally small and should be treated as unapproved until the human reviews and explicitly approves the plan. Follow the walkthrough in the parent repository before changing code.

The copied `factory/board.schema.json` and `factory/board.example.json` are planning artifacts. The example board records no completed work and no approval. The factory orchestrator must be the only writer of a real `factory/board.json`.
