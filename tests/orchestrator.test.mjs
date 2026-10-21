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

test("revision-guarded operations reject stale revisions without invoking the callback", async () => {
  await withStore(async (store) => {
    const orchestrator = new WorkflowOrchestrator(store);
    await orchestrator.createRun({ ...makeRun(), status: "running", revision: 2 });
    let invoked = false;
    const result = await orchestrator.withActiveWorkflowRevision("run-1", 1, async () => {
      invoked = true;
    });
    assert.deepEqual(result, { current: false });
    assert.equal(invoked, false);
  });
});

test("workflow transitions wait until revision-guarded approval consumption completes", async () => {
  await withStore(async (store) => {
    const guardedOrchestrator = new WorkflowOrchestrator(store);
    const transitioningOrchestrator = new WorkflowOrchestrator(store);
    await guardedOrchestrator.createRun({ ...makeRun(), status: "running" });

    let signalEntered;
    const entered = new Promise((resolve) => { signalEntered = resolve; });
    let releaseOperation;
    const hold = new Promise((resolve) => { releaseOperation = resolve; });
    let transitionFinished = false;

    const guarded = guardedOrchestrator.withActiveWorkflowRevision("run-1", 0, async () => {
      signalEntered();
      await hold;
      return "approval-consumed";
    });
    await entered;

    const transition = transitioningOrchestrator.transition("run-1", "verifying", 0).then((run) => {
      transitionFinished = true;
      return run;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(transitionFinished, false, "transition must remain blocked on the workflow store lock");

    releaseOperation();
    assert.deepEqual(await guarded, { current: true, value: "approval-consumed" });
    assert.equal((await transition).revision, 1);
    assert.equal((await guardedOrchestrator.getWorkflow("run-1"))?.run.status, "verifying");
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
    await assert.rejects(store.load(), /events\[0\] has an invalid structure/);
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
    await assert.rejects(store.load(), /evidence\[0\] has an invalid structure/);
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


test("rejects malformed structured runner verification metadata", async () => {
  await withStore(async (store) => {
    const orchestrator = new WorkflowOrchestrator(store);
    await orchestrator.createRun(makeRun("runner-metadata"));
    const valid = await store.load();
    const corrupted = structuredClone(valid);
    corrupted[0].evidence.push({
      id: "runner-evidence",
      runId: "runner-metadata",
      source: "runner_observed",
      kind: "test",
      outcome: "passed",
      summary: "Runner observed test passed.",
      observedAt: "2026-10-20T10:00:00.000Z",
      artifactIds: [],
      runner: {
        checkId: "fixture-check",
        status: "passed",
        exitCode: 0,
        durationMs: 5,
        observedStdoutBytes: 7,
        observedStderrBytes: 0,
        outputTruncated: false,
        stdoutDigest: "a".repeat(64),
        stderrDigest: "b".repeat(64),
      },
    });
    await writeFile(store.filePath, JSON.stringify(corrupted));
    assert.equal((await store.load())[0].evidence[0].runner.checkId, "fixture-check");

    corrupted[0].evidence[0].runner.stdoutDigest = "not-a-digest";
    await writeFile(store.filePath, JSON.stringify(corrupted));
    await assert.rejects(store.load(), /evidence\[0\] has an invalid structure/);
  });
});

test("rejects runner metadata attached to model-reported evidence", async () => {
  await withStore(async (store) => {
    const orchestrator = new WorkflowOrchestrator(store);
    await orchestrator.createRun(makeRun("spoofed-runner-metadata"));
    const valid = await store.load();
    const corrupted = structuredClone(valid);
    corrupted[0].evidence.push({
      id: "spoofed-evidence",
      runId: "spoofed-runner-metadata",
      source: "model_reported",
      kind: "test",
      outcome: "passed",
      summary: "Model claim.",
      observedAt: "2026-10-20T10:00:00.000Z",
      artifactIds: [],
      runner: {
        checkId: "fixture-check",
        status: "passed",
        exitCode: 0,
        durationMs: 5,
        observedStdoutBytes: 0,
        observedStderrBytes: 0,
        outputTruncated: false,
        stdoutDigest: "a".repeat(64),
        stderrDigest: "b".repeat(64),
      },
    });
    await writeFile(store.filePath, JSON.stringify(corrupted));
    await assert.rejects(store.load(), /evidence\[0\] has an invalid structure/);
  });
});

test("rejects malformed persisted step fields and terminal state mismatches", async () => {
  await withStore(async (store) => {
    const orchestrator = new WorkflowOrchestrator(store);
    await orchestrator.createRun(makeRun("step-validation"));
    await orchestrator.beginStep("step-validation", "verify");
    await orchestrator.finishStep("step-validation", "verify", "succeeded", "checks passed");
    const valid = await store.load();

    for (const mutate of [
      (step) => { step.finishedAt = ""; },
      (step) => { step.summary = "  "; },
      (step) => { step.attempt = 0; },
      (step) => { delete step.finishedAt; },
      (step) => { delete step.summary; },
    ]) {
      const corrupted = structuredClone(valid);
      mutate(corrupted[0].steps.verify);
      await writeFile(store.filePath, JSON.stringify(corrupted));
      await assert.rejects(store.load(), /steps\["verify"\] has an invalid structure/);
    }
  });
});

test("valid running and interrupted steps remain loadable during recovery", async () => {
  await withStore(async (store) => {
    const orchestrator = new WorkflowOrchestrator(store);
    await orchestrator.createRun(makeRun("step-recovery"));
    await orchestrator.beginStep("step-recovery", "deploy");
    assert.equal((await store.load())[0].steps.deploy.status, "running");

    await orchestrator.recoverInterruptedSteps("step-recovery", "operator");
    const restored = await store.load();
    assert.equal(restored[0].steps.deploy.status, "interrupted");
    assert.equal(restored[0].steps.deploy.finishedAt, undefined);
    assert.equal(restored[0].steps.deploy.summary, undefined);
  });
});
