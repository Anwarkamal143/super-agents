import test from "node:test";
import assert from "node:assert/strict";
import {
  ReviewInputError,
  ReviewOutputError,
  prepareReviewInput,
  reviewPinnedDiff,
  reviewWithBoundedRepair,
  validateAxisReviewReport,
} from "../dist/index.js";

const base = "a".repeat(40);
const head = "b".repeat(40);
const input = (overrides = {}) => ({
  issueId: "#42",
  diff: "diff --git a/src/a.ts b/src/a.ts\n+const safe = true;\n",
  baseCommit: base,
  headCommit: head,
  spec: "The feature must preserve the public API.",
  repositoryStandards: ["TypeScript strict", "Tests for behavior changes"],
  ...overrides,
});
const passed = (axis) => ({ axis, status: "passed", summary: "No findings.", findings: [] });
const changes = (axis) => ({
  axis,
  status: "changes_requested",
  summary: "A fix is required.",
  findings: [{ id: axis + "-1", severity: "medium", title: "Add a test", detail: "Cover this behavior.", status: "open", file: "src/a.ts", line: 1 }],
});
function engine(standards = passed("standards"), spec = passed("spec")) {
  return {
    reviewStandards: async () => standards,
    reviewSpec: async () => spec,
  };
}

test("pins review to immutable commits and computes a diff digest", () => {
  const prepared = prepareReviewInput(input());
  assert.equal(prepared.fixedPoint, head);
  assert.equal(prepared.baseCommit, base);
  assert.match(prepared.diffDigest, /^[a-f0-9]{64}$/);
  assert.equal(prepareReviewInput(input({ diff: "other diff" })).diffDigest === prepared.diffDigest, false);
});

test("rejects empty diffs, invalid bases/fixed points, same commits, and absent standards", () => {
  assert.throws(() => prepareReviewInput(input({ diff: "  " })), ReviewInputError);
  assert.throws(() => prepareReviewInput(input({ baseCommit: "main" })), /Invalid diff base/);
  assert.throws(() => prepareReviewInput(input({ headCommit: "deadbeef" })), /Invalid fixed point/);
  assert.throws(() => prepareReviewInput(input({ headCommit: base })), /must be different/);
  assert.throws(() => prepareReviewInput(input({ repositoryStandards: [] })), /repository standard/);
});

test("keeps standards and spec reports distinct against the same fixed point", async () => {
  let standardsInput;
  let specInput;
  const result = await reviewPinnedDiff(input(), {
    reviewStandards: async (value) => { standardsInput = value; return passed("standards"); },
    reviewSpec: async (value) => { specInput = value; return passed("spec"); },
  });
  assert.equal(result.status, "passed");
  assert.equal(result.standards.axis, "standards");
  assert.equal(result.spec.axis, "spec");
  assert.equal(standardsInput.fixedPoint, specInput.fixedPoint);
  assert.equal(standardsInput.diffDigest, specInput.diffDigest);
});

test("missing spec is explicit and blocks approval rather than inventing requirements", async () => {
  let specCalled = false;
  const result = await reviewPinnedDiff(input({ spec: undefined }), {
    reviewStandards: async () => passed("standards"),
    reviewSpec: async () => { specCalled = true; return passed("spec"); },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.spec.status, "blocked");
  assert.match(result.spec.summary, /No originating specification/);
  assert.equal(specCalled, false);
});

test("malformed structured reports fail closed, including mismatched axes and unsafe paths", () => {
  assert.throws(() => validateAxisReviewReport({ ...passed("standards"), axis: "spec" }, "standards"), ReviewOutputError);
  assert.throws(() => validateAxisReviewReport({ ...passed("standards"), findings: "none" }, "standards"), ReviewOutputError);
  assert.throws(() => validateAxisReviewReport({
    axis: "standards", status: "passed", summary: "bad", findings: [
      { id: "f", severity: "high", title: "unsafe", detail: "bad path", status: "open", file: "../secret" },
    ],
  }, "standards"), ReviewOutputError);
  assert.throws(() => validateAxisReviewReport({
    axis: "standards", status: "passed", summary: "inconsistent", findings: [
      { id: "f", severity: "low", title: "open", detail: "not resolved", status: "open" },
    ],
  }, "standards"), /cannot pass with open findings/);
});

test("malformed model output blocks the review instead of being accepted", async () => {
  await assert.rejects(reviewPinnedDiff(input(), {
    reviewStandards: async () => ({ axis: "standards", status: "passed", findings: [] }),
    reviewSpec: async () => passed("spec"),
  }), ReviewOutputError);
});

test("bounded repair authorizes each attempt and re-verifies before re-reviewing", async () => {
  let standardsCalls = 0;
  let specCalls = 0;
  let verificationCalls = 0;
  let repairCalls = 0;
  let authCalls = 0;
  const result = await reviewWithBoundedRepair({
    initial: input(),
    maxRepairAttempts: 2,
    engine: {
      reviewStandards: async () => ++standardsCalls === 1 ? changes("standards") : passed("standards"),
      reviewSpec: async () => { specCalls++; return passed("spec"); },
    },
    authorizeRepair: async ({ attempt }) => { authCalls++; return attempt === 1; },
    repair: async ({ attempt }) => {
      repairCalls++;
      return input({ diff: "repaired diff", headCommit: "c".repeat(40) });
    },
    verify: async (repaired) => {
      verificationCalls++;
      return { status: "passed", baseCommit: repaired.baseCommit, headCommit: repaired.headCommit, diff: repaired.diff };
    },
  });
  assert.equal(result.status, "passed");
  assert.equal(result.repairAttempts, 1);
  assert.equal(result.repairLimit, 2);
  assert.equal(authCalls, 1);
  assert.equal(repairCalls, 1);
  assert.equal(verificationCalls, 1);
  assert.equal(standardsCalls, 2);
  assert.equal(specCalls, 2);
  assert.equal(result.history.length, 2);
  assert.equal(result.history[1].verification, "passed");
});

test("repair authorization denial blocks without applying a patch", async () => {
  let repairCalls = 0;
  const result = await reviewWithBoundedRepair({
    initial: input(),
    maxRepairAttempts: 1,
    engine: engine(changes("standards")),
    authorizeRepair: async () => false,
    repair: async () => { repairCalls++; return input(); },
    verify: async () => ({ status: "passed", baseCommit: base, headCommit: head, diff: "diff" }),
  });
  assert.equal(result.status, "blocked");
  assert.equal(repairCalls, 0);
  assert.match(result.reason, /not authorized/);
});

test("repair limit exhaustion blocks and does not attempt an extra repair", async () => {
  let repairs = 0;
  let reviews = 0;
  const result = await reviewWithBoundedRepair({
    initial: input(),
    maxRepairAttempts: 1,
    engine: {
      reviewStandards: async () => { reviews++; return changes("standards"); },
      reviewSpec: async () => passed("spec"),
    },
    authorizeRepair: async () => true,
    repair: async ({ attempt }) => {
      repairs++;
      return input({ diff: `repaired ${attempt}`, headCommit: (attempt === 1 ? "c" : "d").repeat(40) });
    },
    verify: async (repaired) => ({ status: "passed", baseCommit: repaired.baseCommit, headCommit: repaired.headCommit, diff: repaired.diff }),
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.repairAttempts, 1);
  assert.equal(result.repairLimit, 1);
  assert.equal(repairs, 1);
  assert.equal(reviews, 2);
  assert.match(result.reason, /limit exhausted/);
});

test("failed or mismatched verification stops the loop before another review", async () => {
  let reviews = 0;
  let repairs = 0;
  const result = await reviewWithBoundedRepair({
    initial: input(),
    maxRepairAttempts: 3,
    engine: {
      reviewStandards: async () => { reviews++; return changes("standards"); },
      reviewSpec: async () => passed("spec"),
    },
    authorizeRepair: async () => true,
    repair: async () => { repairs++; return input({ diff: "repaired", headCommit: "c".repeat(40) }); },
    verify: async () => ({ status: "failed", baseCommit: base, headCommit: "c".repeat(40), diff: "repaired" }),
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.repairAttempts, 1);
  assert.equal(reviews, 1);
  assert.equal(repairs, 1);
  assert.match(result.reason, /Verification after repair 1 was failed/);
});

test("repair limits are bounded to a safe configured range", async () => {
  await assert.rejects(reviewWithBoundedRepair({
    initial: input(),
    maxRepairAttempts: 21,
    engine: engine(),
    authorizeRepair: async () => true,
    repair: async () => input(),
    verify: async () => ({ status: "passed", baseCommit: base, headCommit: head, diff: "diff" }),
  }), /between 0 and 20/);
});

test("mismatched verification evidence cannot authorize a new review fixed point", async () => {
  let reviews = 0;
  const result = await reviewWithBoundedRepair({
    initial: input(),
    maxRepairAttempts: 2,
    engine: {
      reviewStandards: async () => { reviews++; return changes("standards"); },
      reviewSpec: async () => passed("spec"),
    },
    authorizeRepair: async () => true,
    repair: async () => input({ diff: "repaired", headCommit: "c".repeat(40) }),
    verify: async (repaired) => ({
      status: "passed",
      baseCommit: repaired.baseCommit,
      headCommit: repaired.headCommit,
      diff: "different unverified diff",
    }),
  });
  assert.equal(result.status, "blocked");
  assert.equal(reviews, 1);
  assert.match(result.reason, /did not match the repaired diff fixed point/);
});
