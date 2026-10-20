# End-to-end walkthrough: sample target repository

This walkthrough uses the small project in [`examples/sample-target/`](../examples/sample-target/). It demonstrates how to install the current Claude Code skill, inspect a target, propose a dependency-aware plan, request approval, and report evidence. It is not a claim that this repository provides a production daemon or that prompt instructions alone enforce privileged operations.

## 1. Prepare the sample

From the root of a clone of this repository:

```sh
cd examples/sample-target
node --version
npm test
```

Use Node.js 22+. The baseline test should pass before any feature work. This sample has no external dependencies and the test command runs Node's built-in test runner.

## 2. Inspect before invoking

Review these files first:

- `README.md` — stack and existing commands.
- `package.json` — declared `test` and `check` scripts.
- `src/greeting.js` and `test/greeting.test.js` — existing behavior.
- `FEATURE_REQUEST.md` — the proposed task and acceptance criteria.
- `factory/board.schema.json` and `factory/board.example.json` — the board contract and an unapproved example plan.

The declared scripts are evidence about available commands, not automatic authorization to run them. In this isolated example, the walkthrough explicitly runs `npm test` as the baseline command.

## 3. Invoke the factory

Open Claude Code with the sample directory as the working repository root, then ask:

```text
/factory Implement the request in FEATURE_REQUEST.md. First inspect the repository and report the current behavior, acceptance criteria, non-goals, files likely to change, dependency-aware plan, risks, and exact verification command. Do not edit anything yet. Wait for my explicit approval of the plan.
```

The current Claude Code session is the orchestrator. It should inspect repository evidence and present the plan before any implementation. If the plan assumes a command or behavior not supported by the files, ask it to correct the plan.

## 4. Review the plan and approve narrowly

A suitable plan should be small:

1. Confirm the existing named greeting behavior and current tests.
2. Add the default name in `src/greeting.js`.
3. Add a focused test for `greeting()` while preserving the named-name tests.
4. Run the exact approved check, for example `npm test`.
5. Perform separate Standards and Spec reviews and report their findings.
6. Present the diff and evidence for human delivery review.

Check the proposed file scope, command, acceptance criteria, and non-goals. If it is acceptable, explicitly say something like:

```text
I approve this plan and the exact verification command npm test. Proceed only within the stated file scope. Do not push, open a PR, merge, or deploy.
```

This is an example of a human decision, not a magic phrase or authenticated approval token. The skill is an instruction contract; a real integration must enforce privileged actions outside the model prompt.

## 5. Track the board honestly

The checked-in `factory/board.example.json` is illustrative. It is awaiting approval, has no recorded decisions, and contains no completed tasks. It is not a live run.

After inspecting and agreeing on a plan, the orchestrator may initialize `factory/board.json` from the schema/template and replace example data with the actual request and plan. Only the orchestrator session writes the live board. Delegated agents return bounded findings or patches; they must not write board state or record approvals. Do not commit run-specific state unless the repository's own policy calls for it.

## 6. Verify and review

After explicit approval, the orchestrator can make the scoped change and run the approved command:

```sh
npm test
```

A successful run must be backed by the actual command exit status and output. The completion report should list the command, working directory, observed outcome, and relevant evidence. Run independent Standards and Spec reviews against the actual diff, not just an agent summary.

If a check fails, report `failed`; if not run, report `not run` or `skipped`; if blocked by missing approval, report `blocked`. None of those states is success. Do not weaken tests to force a green result.

## 7. Exercise a blocked path

Try invoking the skill but decline to approve the proposed implementation plan. The correct behavior is to stop before editing files and leave implementation blocked/awaiting approval. Alternatively, if an approved test fails, the report must preserve the failure and explain the next safe step rather than claim the feature is complete.

The example board illustrates the approval boundary but is not itself a live state machine. The current skill guides this behavior; the core library's structured approval, verification, and workflow APIs are separate building blocks and are not automatically wired into the prompt.

## 8. Delivery remains human-controlled

Review the final diff, tests, review findings, and limitations. A successful sample exercise does not authorize pushing, opening a PR, merging, deploying, publishing, or changing infrastructure. Those are separate actions and need the relevant explicit authorization. Never merge or deploy autonomously.

## What this proves—and what it does not

It proves the sample has inspectable repository evidence and a reproducible local test command, and it provides a concrete path to exercise the current skill's planning and approval contract. It does not prove model compliance, enforce security boundaries outside the prompt, provide authenticated human identity, or turn the library into a production orchestration service.
