import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  JsonFileWorkflowStore,
  WorkflowConflictError,
  WorkflowOrchestrator,
} from "../dist/orchestrator.js";

const makeRun = (id = "run-1") => ({
  id,
  requestId: "request-1",
  status: "created",
  revision: 0,
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
});

async function withStore(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "super-agents-"));
  try {
    const store = new JsonFileWorkflowStore(path.join(directory, "workflows.json"));
    await callback(store);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("persists runs and transition history and restores them after restart", async () => {
  await withStore(async (store) => {
    const first = new WorkflowOrchestrator(store, { now: () => "2026-10-20T10:01:00.000Z" });
    await first.createRun(makeRun());
    await first.transition("run-1", "ready", 0);

    const restarted = new WorkflowOrchestrator(store);
    const restored = await restarted.getWorkflow("run-1");
    assert.equal(restored?.run.status, "ready");
    assert.equal(restored?.run.revision, 1);
    assert.deepEqual(restored?.events.map((event) => event.to), ["created", "ready"]);
  });
});

test("serializes competing transitions and rejects stale revisions deterministically", async () => {
  await withStore(async (store) => {
    const orchestrator = new WorkflowOrchestrator(store, { now: () => "2026-10-20T10:01:00.000Z" });
    await orchestrator.createRun(makeRun());
    const outcomes = await Promise.allSettled([
      orchestrator.transition("run-1", "ready", 0),
      orchestrator.transition("run-1", "cancelled", 0),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    assert.ok(rejected?.status === "rejected" && rejected.reason instanceof WorkflowConflictError);
    assert.equal((await orchestrator.getWorkflow("run-1"))?.run.revision, 1);
  });
});

test("a completed step is not started again after reload", async () => {
  await withStore(async (store) => {
    const orchestrator = new WorkflowOrchestrator(store, { now: () => "2026-10-20T10:01:00.000Z" });
    await orchestrator.createRun(makeRun());
    assert.equal((await orchestrator.beginStep("run-1", "verify")).status, "started");
    await orchestrator.finishStep("run-1", "verify", "succeeded", "checks passed");

    const restarted = new WorkflowOrchestrator(store);
    assert.equal((await restarted.beginStep("run-1", "verify")).status, "already_completed");
    assert.equal((await restarted.getWorkflow("run-1"))?.steps.verify?.status, "succeeded");
  });
});

test("a running step is not blindly repeated after restart", async () => {
  await withStore(async (store) => {
    const orchestrator = new WorkflowOrchestrator(store);
    await orchestrator.createRun(makeRun());
    await orchestrator.beginStep("run-1", "deploy-preview");
    const restarted = new WorkflowOrchestrator(store);
    assert.equal((await restarted.beginStep("run-1", "deploy-preview")).status, "already_running");
  });
});

test("persistence errors reject the operation instead of reporting success", async () => {
  const brokenStore = {
    async load() { return []; },
    async save() { throw new Error("disk unavailable"); },
  };
  const orchestrator = new WorkflowOrchestrator(brokenStore);
  await assert.rejects(orchestrator.createRun(makeRun()), /disk unavailable/);
  assert.deepEqual(await orchestrator.listRuns(), []);
});

test("duplicate run creation is rejected", async () => {
  await withStore(async (store) => {
    const orchestrator = new WorkflowOrchestrator(store);
    await orchestrator.createRun(makeRun());
    await assert.rejects(orchestrator.createRun(makeRun()), WorkflowConflictError);
  });
});
