import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKFLOW_TRANSITIONS,
  WorkflowTransitionError,
  isTerminalWorkflowStatus,
  transitionWorkflow,
} from "../dist/workflow.js";

const makeRun = (status = "created") => ({
  id: "run-1",
  requestId: "request-1",
  status,
  revision: 0,
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
});

test("defines a transition list for every workflow status", () => {
  assert.deepEqual(Object.keys(WORKFLOW_TRANSITIONS).sort(), [
    "awaiting_approval", "cancelled", "completed", "created", "failed",
    "ready", "reviewing", "running", "verifying",
  ]);
});

test("accepts a legal transition and returns an updated immutable run", () => {
  const original = makeRun();
  const updated = transitionWorkflow(original, "ready", "2026-10-20T10:01:00.000Z");

  assert.equal(updated.status, "ready");
  assert.equal(updated.revision, 1);
  assert.equal(updated.updatedAt, "2026-10-20T10:01:00.000Z");
  assert.deepEqual(original, makeRun());
  assert.notStrictEqual(updated, original);
});

test("rejects illegal transitions without mutating the input run", () => {
  const original = makeRun("created");
  assert.throws(
    () => transitionWorkflow(original, "completed", "2026-10-20T10:01:00.000Z"),
    (error) => error instanceof WorkflowTransitionError
      && error.from === "created"
      && error.to === "completed",
  );
  assert.deepEqual(original, makeRun("created"));
});

test("approval can resume execution and a denied action can cancel the run", () => {
  const awaiting = makeRun("awaiting_approval");
  assert.equal(
    transitionWorkflow(awaiting, "running", "2026-10-20T10:01:00.000Z").status,
    "running",
  );
  assert.equal(
    transitionWorkflow(awaiting, "cancelled", "2026-10-20T10:01:00.000Z").status,
    "cancelled",
  );
});

test("terminal states cannot transition", () => {
  for (const status of ["completed", "failed", "cancelled"]) {
    assert.equal(isTerminalWorkflowStatus(status), true);
    assert.throws(
      () => transitionWorkflow(makeRun(status), "running", "2026-10-20T10:01:00.000Z"),
      WorkflowTransitionError,
    );
  }
});

test("rejects malformed timestamps before creating a new run", () => {
  assert.throws(
    () => transitionWorkflow(makeRun(), "ready", "not-a-timestamp"),
    RangeError,
  );
});
