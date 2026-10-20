# Example request: support a default greeting name

## Request

Update the greeting helper so calling `greeting()` without an argument returns `Hello, world!`, while an explicitly supplied name keeps the current personalized behavior.

## Acceptance criteria

- `greeting()` returns exactly `Hello, world!`.
- `greeting("Ada")` returns exactly `Hello, Ada!`.
- Existing behavior for a supplied name remains unchanged.
- Add or update focused tests and run the repository's declared `npm test` check.
- Do not add dependencies, make network calls, or modify unrelated files.

## Approval boundary

This file describes a proposed exercise, not authorization to implement it. The orchestrator must inspect the repository, present a plan and exact checks, then wait for explicit human approval before editing.
