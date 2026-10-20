# Contributing

## Runtime and checks

- Node.js 22+
- npm with the committed lockfile
- `npm ci`
- `npm run typecheck`
- `npm test`
- `npm run check`

Run typechecking and focused tests while implementing. Run the full suite before requesting review.

## Issue-first development

Every change should be scoped to a GitHub issue with acceptance criteria, prerequisites, and a verification plan. Start from the latest `main`, create a dedicated branch, and open a pull request targeting `main`. Do not merge your own pull request. Work on dependent issues only after prerequisites are merged.

## Review contract

Review each change on two separate axes:

1. **Standards:** documented repository conventions and relevant maintainability concerns.
2. **Spec:** whether the change satisfies the originating issue without missing requirements or scope creep.

Keep findings distinct. A pass on one axis does not imply a pass on the other.

## Pull request body

Use these sections:

- **Summary:** show the smallest useful diagram, call tree, component/file tree, or diff sketch.
- **Evidence:** state before/after behavior and include exact test/check output.
- **Merge Danger:** classify the change as a one-way or two-way door and state the blast radius.

Be explicit about checks that were not run. Never claim CI passed until the actual run reports success.
