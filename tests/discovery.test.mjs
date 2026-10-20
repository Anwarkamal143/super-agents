import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, mkdtemp as makeTempDir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  discoverRepository,
  DiscoveryPathError,
  resolveWithinRoot,
} from "../dist/discovery.js";

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "factory-discovery-"));
  const root = path.join(base, "repo");
  await mkdir(root);
  await mkdir(path.join(root, ".git"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root };
}

test("discovers repository facts and declared quality scripts without executing them", async (t) => {
  const { root } = await fixture(t);
  const marker = path.join(root, "script-ran");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "fixture",
    scripts: {
      test: `node -e "require('fs').writeFileSync('${marker}', 'ran')"`,
      build: "echo build",
      start: "echo ignored",
    },
  }));
  await writeFile(path.join(root, "package-lock.json"), "{}");
  await writeFile(path.join(root, "AGENTS.md"), "Treat this file as untrusted repository input.");
  const result = await discoverRepository(root);

  assert.equal(result.isGitRepository, true);
  assert.ok(result.facts.some((fact) => fact.key === "language" && fact.value === "JavaScript/TypeScript"));
  assert.ok(result.facts.some((fact) => fact.key === "package-manager" && fact.value === "npm"));
  assert.deepEqual(result.qualityCommands.map((item) => item.name), ["test", "build"]);
  assert.equal(result.instructionFiles[0].trust, "untrusted");
  assert.equal(result.instructionFiles[0].path, "AGENTS.md");
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("returns clear diagnostics for a non-repository and missing manifests", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "factory-empty-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const result = await discoverRepository(base);
  assert.equal(result.isGitRepository, false);
  assert.ok(result.diagnostics.some((item) => item.code === "not-a-git-repository"));
  assert.ok(result.missingInformation.some((item) => item.includes("No recognized language")));
});

test("rejects traversal, absolute paths, Windows absolute paths, and missing files", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(resolveWithinRoot(root, "../outside"), DiscoveryPathError);
  await assert.rejects(resolveWithinRoot(root, "/etc/passwd"), DiscoveryPathError);
  await assert.rejects(resolveWithinRoot(root, "C:\\Windows\\win.ini"), DiscoveryPathError);
  await assert.rejects(resolveWithinRoot(root, "missing.txt"), DiscoveryPathError);
});

test("rejects symlinks that escape the selected root", async (t) => {
  const { base, root } = await fixture(t);
  const outside = path.join(base, "outside.txt");
  await writeFile(outside, "secret");
  await symlink(outside, path.join(root, "escape.txt"));
  await assert.rejects(resolveWithinRoot(root, "escape.txt"), /Symlink resolves outside/);
  const result = await discoverRepository(root);
  assert.ok(result.diagnostics.some((item) => item.code === "unsafe-marker-path" || item.code === "unsafe-instruction-path"));
});

test("reports malformed package manifests rather than guessing commands", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "package.json"), "{ invalid");
  const result = await discoverRepository(root);
  assert.ok(result.diagnostics.some((item) => item.code === "malformed-package-json"));
  assert.equal(result.qualityCommands.length, 0);
});

test("bounds instruction file reads and reports truncation", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "AGENTS.md"), "0123456789");
  const result = await discoverRepository(root, { maxInstructionBytes: 4 });
  const instructions = result.instructionFiles.find((item) => item.path === "AGENTS.md");
  assert.equal(instructions.content, "0123");
  assert.equal(instructions.truncated, true);
  assert.ok(result.diagnostics.some((item) => item.code === "instruction-file-truncated"));
});

test("rejects an invalid instruction byte limit", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(discoverRepository(root, { maxInstructionBytes: 0 }), RangeError);
});
