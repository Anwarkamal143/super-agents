import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout;
}

test("packed package installs into a temporary consumer and exposes ESM, declarations, and factory assets", async () => {
  const temp = await mkdtemp(path.join(root, ".tmp-package-smoke-"));
  try {
    const packOutput = run(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", temp]);
    const [pack] = JSON.parse(packOutput);
    assert.ok(pack.filename.endsWith(".tgz"));
    const tarball = path.join(temp, pack.filename);
    const tarListing = run("tar", ["-tzf", tarball]);
    for (const expected of [
      "package/package.json",
      "package/dist/index.js",
      "package/scripts/validate-claude-code-smoke-report.mjs",
      "package/dist/index.d.ts",
      "package/factory/board.schema.json",
      "package/factory/board.example.json",
      "package/.claude/skills/factory/SKILL.md",
      "package/docs/release.md",
    ]) assert.ok(tarListing.includes(expected), `packed tarball missing ${expected}`);

    for (const forbidden of [
      "package/src/",
      "package/tests/",
      "package/node_modules/",
      "package/.git/",
      "package/.env",
      "package/.env.example",
    ]) assert.equal(tarListing.includes(forbidden), false, `unexpected packed entry ${forbidden}`);

    const consumer = path.join(temp, "consumer");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(consumer));
    await writeFile(path.join(consumer, "package.json"), JSON.stringify({
      name: "super-agents-package-consumer-smoke",
      private: true,
      type: "module",
    }, null, 2));
    run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball], { cwd: consumer });

    const moduleOutput = run(process.execPath, ["--input-type=module", "-e", [
      'import { FACTORY_NAME, validateFactoryBoard } from "super-agents";',
      'import board from "super-agents/factory/board.example.json" with { type: "json" };',
      'import { readFile } from "node:fs/promises";',
      'import assert from "node:assert/strict";',
      'assert.equal(FACTORY_NAME, "super-agents");',
      'assert.equal(validateFactoryBoard(board).valid, true);',
      'const skill = await readFile(new URL(import.meta.resolve("super-agents/skill")), "utf8");',
      'assert.match(skill, /single orchestrator/i);',
      'console.log("package-consumer-ok");',
    ].join("\n")], { cwd: consumer });
    assert.match(moduleOutput, /package-consumer-ok/);

    const tsconfig = {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      files: ["consumer.ts"],
    };
    await writeFile(path.join(consumer, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
    await writeFile(path.join(consumer, "consumer.ts"), [
      'import { FACTORY_NAME, validateFactoryBoard, type HarnessAdapter } from "super-agents";',
      'const name: string = FACTORY_NAME;',
      'void name;',
      'void validateFactoryBoard;',
      'let adapter: HarnessAdapter | undefined;',
      'void adapter;',
      '',
    ].join("\n"));
    const tsc = process.execPath;
    run(tsc, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", path.join(consumer, "tsconfig.json")], { cwd: consumer });

    const installedPackage = JSON.parse(await readFile(path.join(consumer, "node_modules/super-agents/package.json"), "utf8"));
    assert.equal(installedPackage.private, true, "package remains private by default");
    assert.equal(installedPackage.engines.node, ">=22");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
