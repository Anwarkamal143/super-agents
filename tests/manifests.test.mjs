import test from "node:test";
import assert from "node:assert/strict";
import {
  applyManifestChange,
  discoverCompatibleManifests,
  validateManifest,
  validateManifestCollection,
} from "../dist/index.js";

const manifest = (overrides = {}) => ({
  schemaVersion: 1,
  id: "format-review",
  version: "1.0.0",
  description: "Review and format changed files.",
  entrypoint: "skills/format-review/README.md",
  requiredCapabilities: ["read-files", "write-files"],
  inputs: [{ id: "target", type: "string", description: "Target directory", required: true }],
  outputs: [{ id: "summary", type: "string", description: "Change summary" }],
  trust: "untrusted",
  ...overrides,
});

test("validates a portable manifest without executing its entrypoint", () => {
  const result = validateManifest(manifest());
  assert.equal(result.valid, true);
  assert.equal(result.manifest?.id, "format-review");
  assert.equal(result.manifest?.trust, "untrusted");
});

test("rejects unsupported schema versions and invalid semantic versions", () => {
  const result = validateManifest(manifest({ schemaVersion: 2, version: "latest" }));
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((item) => item.code === "unsupported-schema-version"));
  assert.ok(result.diagnostics.some((item) => item.code === "invalid-version"));
});

test("rejects traversal, absolute, Windows, and backslash entrypoints", () => {
  for (const entrypoint of ["../secret", "skills/../../secret", "/tmp/skill", "C:/secret", "skills\\secret", "./skill", ""]) {
    const result = validateManifest(manifest({ entrypoint }));
    assert.equal(result.valid, false, entrypoint);
    assert.ok(result.diagnostics.some((item) => item.code === "unsafe-entrypoint"), entrypoint);
  }
});

test("rejects duplicate manifest IDs, duplicate capabilities, and invalid field schemas", () => {
  const duplicate = manifest({
    requiredCapabilities: ["read-files", "read-files"],
    inputs: [
      { id: "target", type: "string", description: "Target" },
      { id: "target", type: "made-up", description: "" },
    ],
  });
  const result = validateManifest(duplicate);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((item) => item.code === "invalid-capabilities"));
  assert.ok(result.diagnostics.some((item) => item.code === "duplicate-field-id"));
  assert.ok(result.diagnostics.some((item) => item.code === "invalid-field-type"));
  assert.ok(result.diagnostics.some((item) => item.code === "missing-field-description"));

  const collection = validateManifestCollection([manifest(), manifest()]);
  assert.equal(collection.valid, false);
  assert.ok(collection.diagnostics.some((item) => item.code === "duplicate-manifest-id"));
});

test("reports missing harness capabilities before invocation", () => {
  const checked = validateManifestCollection([manifest(), manifest({ id: "docs-only", requiredCapabilities: [] })]);
  assert.equal(checked.valid, true);
  const result = discoverCompatibleManifests(checked.manifests, ["read-files"]);
  assert.deepEqual(result.compatible.map((item) => item.id), ["docs-only"]);
  assert.deepEqual(result.incompatible.map((item) => ({
    id: item.manifest.id,
    missing: item.missingCapabilities,
  })), [{ id: "format-review", missing: ["write-files"] }]);
});

test("registry operations are explicit and return audit events", () => {
  const first = applyManifestChange([], {
    operation: "add", manifest: manifest(), actor: "human:42", occurredAt: "2026-10-20T12:00:00.000Z",
  });
  assert.equal(first.event.operation, "add");
  assert.equal(first.event.nextVersion, "1.0.0");
  assert.throws(() => applyManifestChange(first.manifests, {
    operation: "add", manifest: manifest(), actor: "human:42", occurredAt: "2026-10-20T12:00:00.000Z",
  }), /already exists/);

  const modified = applyManifestChange(first.manifests, {
    operation: "modify", manifest: manifest({ version: "1.1.0" }), actor: "human:42", occurredAt: "2026-10-20T12:01:00.000Z",
  });
  assert.equal(modified.event.previousVersion, "1.0.0");
  assert.equal(modified.event.nextVersion, "1.1.0");

  const removed = applyManifestChange(modified.manifests, {
    operation: "remove", manifestId: "format-review", actor: "human:42", occurredAt: "2026-10-20T12:02:00.000Z",
  });
  assert.equal(removed.manifests.length, 0);
  assert.equal(removed.event.previousVersion, "1.1.0");
  assert.throws(() => applyManifestChange([], {
    operation: "remove", manifestId: "missing", actor: "human:42", occurredAt: "2026-10-20T12:02:00.000Z",
  }), /unknown manifest/);
});

test("invalid audit identity and timestamps are rejected", () => {
  assert.throws(() => applyManifestChange([], {
    operation: "add", manifest: manifest(), actor: " ", occurredAt: "not-a-date",
  }), /actor and valid occurredAt/);
});
