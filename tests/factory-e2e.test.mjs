import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ApprovalPolicy,
  JsonFileApprovalStore,
  JsonFileWorkflowStore,
  WorkflowOrchestrator,
  runFactoryWorkflow,
} from "../dist/index.js";

const passed = (axis) => ({ axis, status: "passed", summary: "No findings.", findings: [] });

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "super-agents-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const orchestrator = new WorkflowOrchestrator(new JsonFileWorkflowStore(path.join(root, "workflows.json")));
  const approvals = new ApprovalPolicy(new JsonFileApprovalStore(path.join(root, "approvals.json")));
  const run = {
    id: "run-e2e",
    requestId: "request-e2e",
    status: "created",
    revision: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return { root, orchestrator, approvals, run };
}

function reviewInput() {
  return {
    issueId: "issue-35",
    diff: "diff --git a/src/example.ts b/src/example.ts\n+export const answer = 42;\n",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    spec: "The implementation exports answer equal to 42.",
    repositoryStandards: ["Keep changes minimal.", "Tests must cover behavior."],
  };
}

function verification(root, code = "process.stdout.write('verification-ok')") {
  return {
    repositoryRoot: root,
    checks: [{
      id: "unit-tests",
      kind: "test",
      executable: "node",
      args: ["-e", code],
      cwd: ".",
      timeoutMs: 2_000,
      maxOutputBytes: 2_048,
    }],
    allowedExecutables: { node: process.execPath },
  };
}

function engine() {
  return {
    reviewStandards: async () => passed("standards"),
    reviewSpec: async () => passed("spec"),
  };
}

test("composed workflow persists approval, verification, both reviews, and stops for human delivery", async (t) => {
  const state = await setup(t);
  let implementationCalls = 0;
  const result = await runFactoryWorkflow({
    ...state,
    plan: { id: "plan-1", summary: "Implement the approved example export." },
    requestApproval: async () => ({ outcome: "approved", decidedBy: "test-human" }),
    implementApprovedPlan: async () => { implementationCalls++; return reviewInput(); },
    verification: verification(state.root),
    reviewEngine: engine(),
  });

  assert.equal(result.status, "ready_for_human_delivery");
  assert.equal(result.run.status, "completed");
  assert.equal(implementationCalls, 1);
  assert.equal(result.verification.status, "passed");
  assert.equal(result.review.status, "passed");
  assert.equal(result.review.standards.status, "passed");
  assert.equal(result.review.spec.status, "passed");
  assert.match(result.reason, /Human delivery review is still required/);

  const persisted = await state.orchestrator.getWorkflow(state.run.id);
  assert.equal(persisted.run.status, "completed");
  assert.deepEqual(persisted.events.map((event) => event.to), [
    "created", "ready", "running", "awaiting_approval", "running", "verifying", "reviewing", "completed",
  ]);
  assert.equal(persisted.steps["implement-approved-plan"].status, "succeeded");
  const audit = await state.approvals.listAuditEvents();
  assert.equal(audit.filter((event) => event.kind === "authorization_granted").length, 2);
  assert.equal(audit.some((event) => JSON.stringify(event).includes("Implement the approved example export.")), false);
});

test("denied plan approval blocks before implementation and persists cancellation", async (t) => {
  const state = await setup(t);
  let implementationCalls = 0;
  const result = await runFactoryWorkflow({
    ...state,
    plan: { id: "plan-denied", summary: "Do not implement without approval." },
    requestApproval: async () => ({ outcome: "denied", decidedBy: "test-human", rationale: "Declined." }),
    implementApprovedPlan: async () => { implementationCalls++; return reviewInput(); },
    verification: verification(state.root),
    reviewEngine: engine(),
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.run.status, "cancelled");
  assert.equal(implementationCalls, 0);
  assert.match(result.reason, /not approved/);
  const persisted = await state.orchestrator.getWorkflow(state.run.id);
  assert.equal(persisted.run.status, "cancelled");
  assert.ok((await state.approvals.listAuditEvents()).some((event) => event.decisionOutcome === "denied"));
});

test("failed verification blocks review and delivery", async (t) => {
  const state = await setup(t);
  let standardsCalls = 0;
  const result = await runFactoryWorkflow({
    ...state,
    plan: { id: "plan-failing-check", summary: "Run a failing verification check." },
    requestApproval: async () => ({ outcome: "approved", decidedBy: "test-human" }),
    implementApprovedPlan: async () => reviewInput(),
    verification: verification(state.root, "process.exitCode = 1"),
    reviewEngine: {
      reviewStandards: async () => { standardsCalls++; return passed("standards"); },
      reviewSpec: async () => passed("spec"),
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.run.status, "failed");
  assert.equal(result.verification.status, "failed");
  assert.equal(standardsCalls, 0);
  assert.match(result.reason, /Verification did not pass/);
  const persisted = await state.orchestrator.getWorkflow(state.run.id);
  assert.equal(persisted.run.status, "failed");
});


test("review findings block delivery even after verification passes", async (t) => {
  const state = await setup(t);
  const result = await runFactoryWorkflow({
    ...state,
    plan: { id: "plan-review-blocked", summary: "Exercise review gating." },
    requestApproval: async () => ({ outcome: "approved", decidedBy: "test-human" }),
    implementApprovedPlan: async () => reviewInput(),
    verification: verification(state.root),
    reviewEngine: {
      reviewStandards: async () => ({
        axis: "standards", status: "changes_requested", summary: "An issue remains.",
        findings: [{
          id: "finding-1", severity: "medium", title: "Missing coverage",
          detail: "Add a test before delivery.", status: "open",
        }],
      }),
      reviewSpec: async () => passed("spec"),
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.run.status, "failed");
  assert.equal(result.verification.status, "passed");
  assert.equal(result.review.status, "changes_requested");
  assert.match(result.reason, /review did not pass/);
});

test("ambiguous implementation failure is marked interrupted and cannot be blindly retried", async (t) => {
  const state = await setup(t);
  const result = await runFactoryWorkflow({
    ...state,
    plan: { id: "plan-ambiguous", summary: "Exercise interrupted side-effect handling." },
    requestApproval: async () => ({ outcome: "approved", decidedBy: "test-human" }),
    implementApprovedPlan: async () => { throw new Error("worker disconnected after a possible file write"); },
    verification: verification(state.root),
    reviewEngine: engine(),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.run.status, "failed");
  const persisted = await state.orchestrator.getWorkflow(state.run.id);
  assert.equal(persisted.steps["implement-approved-plan"].status, "interrupted");
  assert.equal((await state.orchestrator.beginStep(state.run.id, "implement-approved-plan")).status, "reconciliation_required");
});
