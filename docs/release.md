# Package distribution, install, upgrade, and rollback

## Distribution posture

This repository intentionally keeps `"private": true` in `package.json`. The package is **not publishable to npm** in this configuration. Use a locally built tarball for review and installation, or have the owner approve a separate internal-registry/publication change. Do not remove `private`, publish, create tags, or upload artifacts as part of this workflow without explicit authorization.

The package's `files` allowlist includes built `dist/` output, factory schema/examples, the factory skill, docs, and README. `tests/`, `src/`, local configuration, and development dependencies are not intended for consumers.

## Build and inspect a release candidate

Run on Node.js 22+ from a clean checkout:

```sh
npm ci
npm run check
npm run test:package
npm pack --dry-run
npm pack --json
```

Inspect the pack listing and metadata before sharing the tarball. Confirm the ESM entrypoint, declaration files, skill, schema, example board, and documentation are present. Confirm no secrets, `.env` files, tests, source tree, `node_modules`, or git metadata are present. The automated package smoke test performs a real local pack, installs the tarball into a temporary consumer, imports the ESM API/assets, typechecks a TypeScript consumer, and deletes its temporary files.

## Install into another repository

A package install gives access to the library API and packaged assets. It does **not** automatically install or overwrite the target repository's `.claude/skills/factory/SKILL.md` or create/replace its live board.

1. Back up or commit the target repository's current state.
2. Build and inspect a tarball as described above, then copy the exact tarball path to a trusted location.
3. Install the reviewed tarball in the target project:

   ```sh
   npm install --save-exact /absolute/path/to/super-agents-0.1.0.tgz
   ```

4. Review the installed version and the [usage guide](usage.md). If you choose to copy the skill/schema/example into the project, compare them with existing files first and review the diff.
5. Never overwrite `factory/board.json`. It is run state, not a distributable template. If it already exists, preserve it and validate/migrate it explicitly.
6. Run the target repository's approved checks and verify the intended package import in a small consumer test.

The repository's `/factory` skill is also usable as a reviewed file copy. A package installation does not make Claude Code discover a skill in the dependency's `node_modules`; copy the reviewed skill into `.claude/skills/factory/SKILL.md` only as a deliberate, separately reviewed step.

## Upgrade

1. Commit/backup the target repo and record the current package version and skill/schema hashes.
2. Inspect release notes and the candidate tarball's contents before installation.
3. Install the exact candidate tarball version; avoid floating versions for controlled upgrades.
4. Review package API/type changes and the skill/schema diff separately. Do not replace the live board.
5. Run typecheck, tests, and a dry-run of the intended workflow. Confirm approvals are still action-bound and no check is falsely reported as passed.
6. Commit the package lockfile and any intentional skill/schema updates together with the upgrade evidence.

## Rollback

1. Stop any in-progress factory run and reconcile external side effects before restarting.
2. Restore the previously recorded package version from the lockfile or reinstall the prior known-good tarball.
3. Restore the prior skill/schema files from version control only if those files were deliberately changed by the upgrade.
4. Preserve `factory/board.json` and its history. Do not replace it with `factory/board.example.json`.
5. Re-run the repository's checks and validate that the previous version loads. Record the rollback and any incompatible state migration.

Rollback of package files cannot undo external side effects or safely reverse a workflow that has already changed external systems.

## Human-controlled release checklist

- [ ] Owner approved the intended distribution channel; `private: true` remains until publication is explicitly approved.
- [ ] Version and release notes describe API, schema, skill, and compatibility changes.
- [ ] Node.js 22+ typecheck and full test suite pass.
- [ ] Package smoke test passes from a real local tarball.
- [ ] `npm pack --dry-run` listing and package metadata were reviewed.
- [ ] Public ESM entrypoint and declarations resolve in a temporary consumer.
- [ ] No secrets, source tests, local files, or development dependencies are packed.
- [ ] Install, upgrade, and rollback instructions have been checked against the candidate.
- [ ] Skill and schema changes are reviewed separately; consumer run-state files are never overwritten.
- [ ] Any registry publish, tag, GitHub release, or credential use has explicit human approval and is performed manually.

## Operational acceptance and known limits

This acceptance covers local package distribution and consumer import/type resolution only. It does not establish that the factory is a production daemon, a security sandbox, or a multi-host workflow service. The local JSON stores and cooperative locks remain same-host mechanisms. Integrations remain responsible for authenticated human approvals, secret handling, durable external audit, and privileged-operation enforcement.
