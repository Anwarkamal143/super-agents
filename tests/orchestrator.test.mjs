import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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


test("rejects malformed persisted workflow records instead of trusting active-looking status", async () => {
  await withStore(async (store) => {
    const filePath = store.filePath;
    await writeFile(filePath, JSON.stringify([{
      run: { id: "run-1", status: "running" },
      events: [],
      steps: {},
      evidence: [],
    }]));
    await assert.rejects(
      store.load(),
      /run must include non-empty id and requestId fields/,
    );
  });
});

test("rejects duplicate persisted workflow run IDs", async () => {
  await withStore(async (store) => {
    const orchestrator = new WorkflowOrchestrator(store);
    await orchestrator.createRun(makeRun("duplicate"));
    const valid = await store.load();
    await writeFile(store.filePath, JSON.stringify([...valid, valid[0]]));
    await assert.rejects(store.load(), /duplicate run id: duplicate/);
  });
});

test("loads legacy evidence records without provenance while validating workflow structure", async () => {
  await withStore(async (store) => {
    const orchestrator = new WorkflowOrchestrator(store);
    await orchestrator.createRun(makeRun("legacy-evidence"));
    const valid = await store.load();
    const workflow = valid[0];
    await writeFile(store.filePath, JSON.stringify([{
      ...workflow,
      evidence: [{
        id: "evidence-legacy",
        runId: "legacy-evidence",
        kind: "test",
        outcome: "passed",
        summary: "Historical record without provenance.",
        observedAt: "2026-10-20T10:00:00.000Z",
        artifactIds: [],
      }],
    }]));
    const restored = await store.load();
    assert.equal(restored[0].evidence[0].id, "evidence-legacy");
    assert.equal("source" in restored[0].evidence[0], false);
  });
});


test("rejects persisted audit events that reference a different run", async () => {
  await withStore(async (store) => {
    const orchestrator = new WorkflowOrchestrator(store);
    await orchestrator.createRun(makeRun("event-run"));
    const workflows = await store.load();
    const corrupted = structuredClone(workflows);
    corrupted[0].events[0].runId = "another-run";
    await writeFile(store.filePath, JSON.stringify(corrupted));
    await assert.rejects(store.load(), /events\\[0\\] has an invalid structure/);
  });
});

test("rejects malformed evidence fields and unknown provenance", async () => {
  await withStore(async (store) => {
    const orchestrator = new WorkflowOrchestrator(store);
    await orchestrator.createRun(makeRun("evidence-run"));
    const workflows = await store.load();
    const corrupted = structuredClone(workflows);
    corrupted[0].evidence.push({
      id: "evidence-1",
      runId: "evidence-run",
      kind: "test",
      outcome: "passed",
      summary: "Test output reported as passed.",
      observedAt: "2026-10-20T10:00:00.000Z",
      artifactIds: ["artifact-1"],
      source: "trusted_runner",
    });
    await writeFile(store.filePath, JSON.stringify(corrupted));
    await assert.rejects(store.load(), /evidence\\[0\\] has an invalid structure/);
  });
});

test("accepts current evidence with recognized provenance and artifact IDs", async () => {
  await withStore(async (store) => {
    const orchestrator = new WorkflowOrchestrator(store);
    await orchestrator.createRun(makeRun("current-evidence"));
    const workflows = await store.load();
    const updated = structuredClone(workflows);
    updated[0].evidence.push({
      id: "evidence-current",
      runId: "current-evidence",
      kind: "test",
      outcome: "passed",
      summary: "Deterministic test suite passed.",
      observedAt: "2026-10-20T10:00:00.000Z",
      artifactIds: ["artifact-1"],
      source: "runner_observed",
    });
    await writeFile(store.filePath, JSON.stringify(updated));
    assert.equal((await store.load())[0].evidence[0].source, "runner_observed");
  });
});
