# Interactive Claude Code smoke-test report

> This is a report template, not evidence that the test has run. Fill it only from an actual interactive Claude Code session. Use `NOT RUN` when a step has not been observed. Do not paste credentials, tokens, private prompts, full environment dumps, or unredacted private paths.

## Run metadata

- Date/time and timezone:
- Tester:
- Repository/commit under test:
- Claude Code version (`claude --version`):
- Node.js version (`node --version`):
- OS/version:
- Bridge commit:
- MCP transport/configuration method:
- State directory location (redacted or generalized):
- PreToolUse hook enabled and confirmed loaded? **PASS / FAIL / NOT RUN**
- Evidence link or sanitized output:

## Result vocabulary

Use exactly one status for every check:

- **PASS** — observed behavior met the expected result.
- **FAIL** — observed behavior violated the expected result.
- **BLOCKED** — a dependency or environment issue prevented the check.
- **NOT RUN** — no attempt was made.

Each status must include an inline observation and evidence reference on the corresponding `Observed:` and `Evidence:` lines. Do not mark a check PASS from unit tests alone. After recording actual host results, validate a copy of this report with `npm run validate:smoke-report -- path/to/completed-report.md`. The validator checks completeness and status consistency only; it cannot authenticate observations.

## Checks

### 1. Host connection and protocol negotiation

- Status: **NOT RUN**
- Expected: Claude Code connects to the configured MCP server without protocol/elicitation errors.
- Observed: <describe what you actually observed>
- Evidence: <link or sanitized output reference>
### 2. Human declines plan approval

- Status: **NOT RUN**
- Expected: A visible human decision prompt appears; choosing **decline** leaves the run blocked/cancelled and no implementation phase starts.
- Observed: <describe what you actually observed>
- Evidence: <link or sanitized output reference>
### 3. Human approves plan and active session resumes

- Status: **NOT RUN**
- Expected: A fresh run displays the plan for approval; after approval, the currently active Claude Code session continues. No second `claude` orchestration process is launched.
- Observed: <describe what you actually observed>
- Evidence: <link or sanitized output reference>
### 4. Exact harmless fixture write

- Status: **NOT RUN**
- Expected: The exact target and payload are shown for approval; only that approved payload is permitted by the PreToolUse gate.
- Fixture target (redacted/generalized):
- Observed: <describe what you actually observed>
- Evidence: <link or sanitized output reference>
### 5. Modified payload denial

- Status: **NOT RUN**
- Expected: Changing any approved payload argument is denied and requires a new approval.
- Observed: <describe what you actually observed>
- Evidence: <link or sanitized output reference>
### 6. Replay denial

- Status: **NOT RUN**
- Expected: Reusing a consumed approval is denied.
- Observed: <describe what you actually observed>
- Evidence: <link or sanitized output reference>
### 7. Bash action approval

- Status: **NOT RUN**
- Expected: The exact command/tool input and working-directory context are reviewed before the governed Bash action; unapproved or modified input is denied.
- Command summary (do not include secrets):
- Observed: <describe what you actually observed>
- Evidence: <link or sanitized output reference>
### 8. Elicitation unavailable or malformed

- Status: **NOT RUN**
- Expected: The workflow fails closed; no action approval is created and no governed native action is allowed.
- How the failure was simulated:
- Observed: <describe what you actually observed>
- Evidence: <link or sanitized output reference>
### 9. State-directory/persistence failure

- Status: **NOT RUN**
- Expected: The bridge/hook reports failure and denies the governed action rather than treating missing or unreadable state as approval.
- How the failure was simulated:
- Observed: <describe what you actually observed>
- Evidence: <link or sanitized output reference>
## Final assessment

- Overall: **NOT RUN**
- Failed or blocked checks:
- Known limitations:
- Follow-up issue(s):
- Reviewer:
- Review date:

## Redaction checklist

- [ ] No access tokens, credentials, cookies, or environment secrets included.
- [ ] Private filesystem paths and repository identifiers generalized where needed.
- [ ] Logs/screenshots contain only the minimum evidence needed.
- [ ] Each PASS is supported by an actual host observation, not a deterministic unit test alone.
