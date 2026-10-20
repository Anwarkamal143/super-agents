import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  JsonFileWorkflowStore,
  WorkflowConflictError,
  WorkflowOrchestrator,
} from "../dist/index.js";

const makeRun = (id = "recovery-run") => ({
  id, requestId: "request-1", status: "created", revision: 0,
  createdAt: "2026-10-20T10:00:00.000Z", updatedAt: "2026-10-20T10:00:00.000Z",
});

async function withDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "super-agents-recovery-"));
  try { await callback(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("separate orchestrators cannot overwrite each other's concurrent transitions", async () => {
  await withDirectory(async (directory) => {
    const file = path.join(directory, "workflows.json");
    const first = new WorkflowOrchestrator(new JsonFileWorkflowStore(file));
    const second = new WorkflowOrchestrator(new JsonFileWorkflowStore(file));
    await first.createRun(makeRun());
    const results = await Promise.allSettled([
      first.transition("recovery-run", "ready", 0),
      second.transition("recovery-run", "cancelled", 0),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected" && rejected.reason instanceof WorkflowConflictError);
    const restored = await second.getWorkflow("recovery-run");
    assert.equal(restored?.run.revision, 1);
    assert.equal(restored?.events.filter((event) => event.kind === "transition").length, 2);
  });
});

test("startup recovery marks running steps interrupted instead of replaying them", async () => {
  await withDirectory(async (directory) => {
    const store = new JsonFileWorkflowStore(path.join(directory, "workflows.json"));
    const first = new WorkflowOrchestrator(store, { now: () => "2026-10-20T10:01:00.000Z" });
    await first.createRun(makeRun());
    await first.beginStep("recovery-run", "publish");
    const restarted = new WorkflowOrchestrator(store, { now: () => "2026-10-20T10:02:00.000Z" });
    const interrupted = await restarted.recoverInterruptedSteps("recovery-run", "operator");
    assert.equal(interrupted.length, 1);
    assert.equal(interrupted[0].status, "interrupted");
    assert.equal((await restarted.beginStep("recovery-run", "publish")).status, "reconciliation_required");
  });
});

test("interrupted external effects require explicit reconciliation before retry", async () => {
  await withDirectory(async (directory) => {
    const store = new JsonFileWorkflowStore(path.join(directory, "workflows.json"));
    const orchestrator = new WorkflowOrchestrator(store);
    await orchestrator.createRun(makeRun());
    await orchestrator.beginStep("recovery-run", "publish");
    await orchestrator.recoverInterruptedSteps("recovery-run", "operator");
    await assert.rejects(
      orchestrator.resolveInterruptedStep("recovery-run", "publish", "retry", "operator", "unknown outcome"),
      /external effect was reconciled/,
    );
    const retried = await orchestrator.resolveInterruptedStep(
      "recovery-run", "publish", "retry", "operator",
      "remote API confirms no publication happened", { externalEffectReconciled: true },
    );
    assert.equal(retried.status, "running");
    assert.equal(retried.attempt, 2);
  });
});

test("reconciliation can record confirmed completion and audit only a reason digest", async () => {
  await withDirectory(async (directory) => {
    const file = path.join(directory, "workflows.json");
    const orchestrator = new WorkflowOrchestrator(new JsonFileWorkflowStore(file));
    await orchestrator.createRun(makeRun());
    await orchestrator.beginStep("recovery-run", "deploy");
    await orchestrator.recoverInterruptedSteps("recovery-run", "operator");
    await orchestrator.resolveInterruptedStep(
      "recovery-run", "deploy", "confirm_succeeded", "operator", "remote system confirms deployed; secret=private-value",
    );
    const raw = await readFile(file, "utf8");
    const state = await orchestrator.getWorkflow("recovery-run");
    assert.equal(state?.steps.deploy?.status, "succeeded");
    assert.equal(raw.includes("secret=private-value"), false);
    assert.ok(state?.events.some((event) => event.kind === "step_reconciled" && /^[a-f0-9]{64}$/.test(event.detailDigest ?? "")));
  });
});

test("recovery and step audit records are ordered and do not store free-form summaries", async () => {
  await withDirectory(async (directory) => {
    const file = path.join(directory, "workflows.json");
    const orchestrator = new WorkflowOrchestrator(new JsonFileWorkflowStore(file));
    await orchestrator.createRun(makeRun());
    await orchestrator.beginStep("recovery-run", "verify");
    await orchestrator.finishStep("recovery-run", "verify", "succeeded", "token=do-not-audit");
    const raw = await readFile(file, "utf8");
    const state = await orchestrator.getWorkflow("recovery-run");
    assert.equal(raw.includes("token=do-not-audit"), true, "step record retains its summary for operational context");
    const audit = state?.events.filter((event) => event.kind?.startsWith("step_")) ?? [];
    assert.deepEqual(audit.map((event) => event.kind), ["step_started", "step_finished"]);
    assert.equal(JSON.stringify(audit).includes("token=do-not-audit"), false);
  });
});


test("workflow state file is owner-readable and owner-writable only on POSIX", { skip: process.platform === "win32" }, async () => {
  await withDirectory(async (directory) => {
    const file = path.join(directory, "workflows.json");
    const orchestrator = new WorkflowOrchestrator(new JsonFileWorkflowStore(file));
    await orchestrator.createRun(makeRun());
    const metadata = await stat(file);
    assert.equal(metadata.mode & 0o777, 0o600);
  });
});
