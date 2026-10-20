# Safe Repository Discovery

`discoverRepository(rootPath, options?)` inspects a selected repository without executing project code. It reports the resolved root, Git metadata presence, detected language/manifest/lockfile facts, supported quality commands declared in `package.json`, relevant instruction files, assumptions, missing information, and diagnostics.

## Safety contract

- Discovery is read-only: it does not run scripts, package managers, Git hooks, build tools, or commands declared in manifests.
- Repository files and project instructions are untrusted data. Returned instruction files are explicitly marked `trust: "untrusted"`; consumers must not treat their content as higher-priority factory instructions.
- File paths are resolved against the selected root. Absolute paths, traversal segments, and symlinks that resolve outside the root are rejected.
- Only known root-level instruction files and two known tool-specific instruction paths are inspected. Discovery does not recursively scan the repository.
- Each instruction file is capped at 32 KiB by default. The limit can be configured with `maxInstructionBytes`.
- Package scripts are returned as declared command strings for a later policy-controlled verification stage. Discovery does not execute them.
- Facts include evidence paths. Missing information and assumptions are separate collections, and ambiguity (such as multiple package managers) is reported rather than silently guessed.

## Example

```ts
import { discoverRepository } from "super-agents";

const result = await discoverRepository("/work/my-project");
console.log(result.facts);
console.log(result.qualityCommands); // descriptions only; never executed here
console.log(result.diagnostics);
```

The API uses Node.js filesystem access and is intended to be called by a trusted host with an explicit target root. It does not establish that the repository is safe; it only reports bounded observations for subsequent policy and approval decisions.
