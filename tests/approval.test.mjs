import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ApprovalPolicy,
  JsonFileApprovalStore,
  canonicalize,
  digestPayload,
} from "../dist/index.js";

async function withPolicy(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "super-agents-approval-"));
  try {
    const store = new JsonFileApprovalStore(path.join(directory, "approvals.json"));
    await run(new ApprovalPolicy(store), store, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("canonical payload digest is stable across object key order and changes with values", () => {
  assert.equal(canonicalize({ z: 2, a: 1 }), '{"a":1,"z":2}');
  assert.equal(digestPayload({ z: 2, a: 1 }), digestPayload({ a: 1, z: 2 }));
  assert.notEqual(digestPayload({ a: 1 }), digestPayload({ a: 2 }));
  assert.throws(() => canonicalize({ value: undefined }), /undefined/);
  const circular = {};
  circular.self = circular;
  assert.throws(() => canonicalize(circular), /circular/);
});

test("unknown actions are denied by default and cannot receive an approval", async () => {
  await withPolicy(async (policy) => {
    await assert.rejects(policy.recordDecision({
      actionType: "shell.root",
      payload: { command: "anything" },
      outcome: "approved",
      decidedBy: "human",
    }), /Unknown action/);
    const result = await policy.authorizeAndConsume("shell.root", { command: "anything" }, undefined, "runner");
    assert.deepEqual(result, { allowed: false, reason: "unknown_action" });
    const events = await policy.listAuditEvents();
    assert.equal(events.at(-1).kind, "authorization_denied_unknown_action");
    assert.equal(JSON.stringify(events).includes("anything"), false);
  });
});

test("approval is scoped to action and exact payload, then consumed once", async () => {
  await withPolicy(async (policy) => {
    const approval = await policy.recordDecision({
      actionType: "command.execute",
      payload: { command: "npm test", cwd: "/repo" },
      outcome: "approved",
      decidedBy: "human-reviewer",
      rationale: "approved for this change",
    });

    const changed = await policy.authorizeAndConsume(
      "command.execute",
      { command: "npm test", cwd: "/other-repo" },
      approval.id,
      "runner",
    );
    assert.deepEqual(changed, { allowed: false, reason: "mismatch" });

    const wrongAction = await policy.authorizeAndConsume(
      "file.write",
      { command: "npm test", cwd: "/repo" },
      approval.id,
      "runner",
    );
    assert.deepEqual(wrongAction, { allowed: false, reason: "mismatch" });

    const allowed = await policy.authorizeAndConsume(
      "command.execute",
      { cwd: "/repo", command: "npm test" },
      approval.id,
      "runner",
    );
    assert.equal(allowed.allowed, true);

    const replay = await policy.authorizeAndConsume(
      "command.execute",
      { command: "npm test", cwd: "/repo" },
      approval.id,
      "runner",
    );
    assert.deepEqual(replay, { allowed: false, reason: "replay" });

    const events = await policy.listAuditEvents();
    assert.ok(events.some((event) => event.kind === "authorization_denied_mismatch"));
    assert.ok(events.some((event) => event.kind === "authorization_granted"));
    assert.ok(events.some((event) => event.kind === "authorization_denied_replay"));
  });
});

test("denied decision cannot authorize and active approval can be revoked", async () => {
  await withPolicy(async (policy) => {
    const denied = await policy.recordDecision({
      actionType: "git.merge",
      payload: { pullRequest: 42 },
      outcome: "denied",
      decidedBy: "reviewer",
    });
    assert.deepEqual(
      await policy.authorizeAndConsume("git.merge", { pullRequest: 42 }, denied.id, "runner"),
      { allowed: false, reason: "denied" },
    );

    const approved = await policy.recordDecision({
      actionType: "deployment.execute",
      payload: { environment: "production" },
      outcome: "approved",
      decidedBy: "reviewer",
    });
    assert.equal(await policy.revoke(approved.id, "reviewer"), true);
    assert.deepEqual(
      await policy.authorizeAndConsume("deployment.execute", { environment: "production" }, approved.id, "runner"),
      { allowed: false, reason: "replay" },
    );
  });
});

test("audit records contain payload digests, not raw payloads, rationale, or secrets", async () => {
  await withPolicy(async (policy, store) => {
    await policy.recordDecision({
      actionType: "network.request",
      payload: { url: "https://internal.example", authorization: "Bearer top-secret" },
      outcome: "approved",
      decidedBy: "reviewer",
      rationale: "private rationale",
    });
    const state = await store.load();
    const serialized = JSON.stringify(state);
    assert.equal(serialized.includes("top-secret"), false);
    assert.equal(serialized.includes("private rationale"), false);
    assert.equal(serialized.includes("internal.example"), false);
    assert.equal(state.events[0].decisionOutcome, "approved");
    assert.match(state.approvals[0].payloadDigest, /^[a-f0-9]{64}$/);
  });
});

test("JSON ledger survives reload and malformed persistence fails closed", async () => {
  await withPolicy(async (policy, store, directory) => {
    const approval = await policy.recordDecision({
      actionType: "git.branch.create",
      payload: { branch: "feat/safe" },
      outcome: "approved",
      decidedBy: "reviewer",
    });
    const reloaded = new ApprovalPolicy(new JsonFileApprovalStore(path.join(directory, "approvals.json")));
    assert.equal((await reloaded.listApprovals())[0].id, approval.id);
    assert.equal((await reloaded.authorizeAndConsume("git.branch.create", { branch: "feat/safe" }, approval.id, "runner")).allowed, true);
    assert.equal((await policy.listApprovals())[0].status, "consumed");
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "super-agents-approval-corrupt-"));
  try {
    const file = path.join(directory, "approvals.json");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(file, '{"approvals":"bad","events":[]}'));
    await assert.rejects(new JsonFileApprovalStore(file).load(), /invalid structure/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistence failure never returns an approval or authorization grant", async () => {
  const store = {
    load: async () => ({ approvals: [], events: [] }),
    save: async () => { throw new Error("disk unavailable"); },
  };
  const policy = new ApprovalPolicy(store);
  await assert.rejects(policy.recordDecision({
    actionType: "file.write",
    payload: { path: "README.md" },
    outcome: "approved",
    decidedBy: "reviewer",
  }), /disk unavailable/);
  await assert.rejects(policy.authorizeAndConsume("file.write", { path: "README.md" }, "fake-id", "runner"), /disk unavailable/);
});

test("separate approval policy instances cannot consume the same approval twice", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "super-agents-approval-race-"));
  try {
    const file = path.join(directory, "approvals.json");
    const first = new ApprovalPolicy(new JsonFileApprovalStore(file));
    const second = new ApprovalPolicy(new JsonFileApprovalStore(file));
    const approval = await first.recordDecision({
      actionType: "git.merge", payload: { pullRequest: 99 }, outcome: "approved", decidedBy: "reviewer",
    });
    const results = await Promise.all([
      first.authorizeAndConsume("git.merge", { pullRequest: 99 }, approval.id, "runner-a"),
      second.authorizeAndConsume("git.merge", { pullRequest: 99 }, approval.id, "runner-b"),
    ]);
    assert.equal(results.filter((result) => result.allowed).length, 1);
    assert.equal(results.filter((result) => !result.allowed && result.reason === "replay").length, 1);
    const events = await second.listAuditEvents();
    assert.equal(events.filter((event) => event.kind === "authorization_granted").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
