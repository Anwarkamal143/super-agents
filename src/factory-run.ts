import { createHash } from "node:crypto";
import type { ApprovalPolicy } from "./approval.js";
import type { PinnedReviewInput, ReviewEngine } from "./review.js";
import { reviewPinnedDiff } from "./review.js";
import type { VerificationConfig, VerificationReport } from "./verification.js";
import { runVerification } from "./verification.js";
import type { VerificationEvidence, WorkflowRun, WorkflowStatus } from "./domain.js";
import type { WorkflowOrchestrator } from "./orchestrator.js";

export interface HumanApprovalRequest {
  readonly actionType: "file.write" | "command.execute";
  readonly payload: unknown;
  readonly reason: string;
}

export interface HumanApprovalResponse {
  readonly outcome: "approved" | "denied";
  readonly decidedBy: string;
  readonly rationale?: string;
}

/**
 * This callback must be backed by an actual host/user interaction. Returning
 * "approved" is a decision supplied by the caller, not authentication by this
 * library. Do not implement it by trusting model output or repository text.
 */
export type RequestHumanApproval = (
  request: HumanApprovalRequest,
) => Promise<HumanApprovalResponse | undefined>;

export interface FactoryRunOptions {
  readonly run: WorkflowRun;
  readonly plan: {
    readonly id: string;
    readonly summary: string;
  };
  readonly orchestrator: WorkflowOrchestrator;
  readonly approvals: ApprovalPolicy;
  readonly requestApproval: RequestHumanApproval;
  readonly implementApprovedPlan: () => Promise<PinnedReviewInput>;
  readonly verification: Omit<VerificationConfig, "authorize">;
  readonly reviewEngine: ReviewEngine;
  readonly actorForExecution?: string;
}

export interface FactoryRunResult {
  readonly status: "ready_for_human_delivery" | "blocked" | "failed";
  readonly run: WorkflowRun;
  readonly reason?: string;
  readonly verification?: VerificationReport;
  readonly review?: Awaited<ReturnType<typeof reviewPinnedDiff>>;
}

/**
 * Composes the workflow, exact-payload approval ledger, verification runner,
 * and independent standards/spec reviews. It stops at human delivery review:
 * this function never creates a PR, merges, deploys, or publishes.
 */
export async function runFactoryWorkflow(options: FactoryRunOptions): Promise<FactoryRunResult> {
  let run = (await options.orchestrator.createRun(options.run)).run;
  const transition = async (status: WorkflowStatus) => {
    run = await options.orchestrator.transition(run.id, status, run.revision);
  };
  const blocked = async (reason: string): Promise<FactoryRunResult> => {
    if (run.status === "running" || run.status === "awaiting_approval") await transition("cancelled");
    return { status: "blocked", run, reason };
  };
  const failed = async (reason: string, verification?: VerificationReport, review?: Awaited<ReturnType<typeof reviewPinnedDiff>>): Promise<FactoryRunResult> => {
    if (run.status === "running" || run.status === "verifying" || run.status === "reviewing") await transition("failed");
    return { status: "failed", run, reason, ...(verification ? { verification } : {}), ...(review ? { review } : {}) };
  };

  await transition("ready");
  await transition("running");
  await transition("awaiting_approval");

  const planPayload = {
    runId: run.id,
    planId: options.plan.id,
    planDigest: createHash("sha256").update(options.plan.summary, "utf8").digest("hex"),
  };
  let planDecision: HumanApprovalResponse | undefined;
  try {
    planDecision = await options.requestApproval({
      actionType: "file.write",
      payload: planPayload,
      reason: "Approve implementation of this exact, reviewed plan.",
    });
  } catch {
    return blocked("The human approval interaction failed; implementation remains blocked.");
  }
  if (!planDecision || planDecision.outcome !== "approved" || !planDecision.decidedBy.trim()) {
    if (planDecision?.outcome === "denied" && planDecision.decidedBy.trim()) {
      await options.approvals.recordDecision({
        actionType: "file.write", payload: planPayload, outcome: "denied",
        decidedBy: planDecision.decidedBy, rationale: planDecision.rationale,
      });
    }
    return blocked("Implementation was not approved; no implementation callback was invoked.");
  }
  const planApproval = await options.approvals.recordDecision({
    actionType: "file.write", payload: planPayload, outcome: "approved",
    decidedBy: planDecision.decidedBy, rationale: planDecision.rationale,
  });
  const planAuthorization = await options.approvals.authorizeAndConsume(
    "file.write", planPayload, planApproval.id, options.actorForExecution ?? "factory-orchestrator",
  );
  if (!planAuthorization.allowed) return blocked(`Plan approval could not be consumed: ${planAuthorization.reason}.`);

  await transition("running");
  const stepStart = await options.orchestrator.beginStep(run.id, "implement-approved-plan");
  if (stepStart.status !== "started") {
    return blocked(`Implementation step cannot start safely (status: ${stepStart.status}); reconcile prior work before retrying.`);
  }

  let reviewInput: PinnedReviewInput;
  try {
    reviewInput = await options.implementApprovedPlan();
    await options.orchestrator.finishStep(
      run.id, "implement-approved-plan", "succeeded", "Implementation callback returned a pinned review input.",
    );
  } catch (error) {
    // A thrown implementation callback may have changed files before failing.
    // Preserve an interrupted marker; never assume retry is safe.
    await options.orchestrator.recoverInterruptedSteps(run.id, "factory-orchestrator");
    return failed(error instanceof Error ? error.message : "Implementation outcome is ambiguous; reconciliation is required.");
  }

  await transition("verifying");
  const verificationStep = await options.orchestrator.beginStep(run.id, "verification");
  if (verificationStep.status !== "started") {
    return failed(`Verification step cannot start safely (status: ${verificationStep.status}).`);
  }
  let verification: VerificationReport;
  try {
    verification = await runVerification({
    ...options.verification,
    authorize: async (actionType, payload) => {
      const decision = await options.requestApproval({
        actionType,
        payload,
        reason: `Authorize exact verification check "${payload.checkId}".`,
      });
      if (!decision || decision.outcome !== "approved" || !decision.decidedBy.trim()) {
        if (decision?.outcome === "denied" && decision.decidedBy.trim()) {
          await options.approvals.recordDecision({
            actionType, payload, outcome: "denied", decidedBy: decision.decidedBy,
            rationale: decision.rationale,
          });
        }
        return false;
      }
      const approval = await options.approvals.recordDecision({
        actionType, payload, outcome: "approved", decidedBy: decision.decidedBy,
        rationale: decision.rationale,
      });
      const authorization = await options.approvals.authorizeAndConsume(
        actionType, payload, approval.id, options.actorForExecution ?? "factory-verifier",
      );
      return authorization.allowed;
    },
    });
  } catch (error) {
    await options.orchestrator.recoverInterruptedSteps(run.id, "factory-orchestrator");
    return failed(error instanceof Error ? error.message : "Verification could not complete.");
  }
  const verificationEvidence: VerificationEvidence = {
    id: `verification-${run.id}`,
    runId: run.id,
    source: "runner_observed",
    kind: "command",
    outcome: verification.status === "passed" ? "passed" : verification.status === "failed" ? "failed" : "unknown",
    summary: `Verification ${verification.status}; ${verification.checks.length} check(s) observed.`,
    observedAt: verification.finishedAt,
    artifactIds: [],
  };
  await options.orchestrator.finishStep(
    run.id, "verification", verification.status === "passed" ? "succeeded" : "failed",
    verificationEvidence.summary, verificationEvidence,
  );
  if (verification.status !== "passed") {
    return failed(`Verification did not pass (status: ${verification.status}); review and delivery are blocked.`, verification);
  }

  await transition("reviewing");
  const reviewStep = await options.orchestrator.beginStep(run.id, "independent-review");
  if (reviewStep.status !== "started") {
    return failed(`Review step cannot start safely (status: ${reviewStep.status}).`, verification);
  }
  let review: Awaited<ReturnType<typeof reviewPinnedDiff>>;
  try {
    review = await reviewPinnedDiff(reviewInput, options.reviewEngine);
  } catch (error) {
    await options.orchestrator.recoverInterruptedSteps(run.id, "factory-orchestrator");
    return failed(error instanceof Error ? error.message : "Review failed.", verification);
  }
  const reviewEvidence: VerificationEvidence = {
    id: `review-${run.id}`,
    runId: run.id,
    source: "review_engine",
    kind: "review",
    outcome: review.status === "passed" ? "passed" : review.status === "changes_requested" ? "failed" : "unknown",
    summary: `Independent review ${review.status}; standards=${review.standards.status}, spec=${review.spec.status}.`,
    observedAt: new Date().toISOString(),
    artifactIds: [],
  };
  await options.orchestrator.finishStep(
    run.id, "independent-review", review.status === "passed" ? "succeeded" : "failed",
    reviewEvidence.summary, reviewEvidence,
  );
  if (review.status !== "passed") {
    return failed(`Independent review did not pass (status: ${review.status}); delivery is blocked.`, verification, review);
  }

  await transition("completed");
  return {
    status: "ready_for_human_delivery",
    run,
    verification,
    review,
    reason: "Verification and both review axes passed. Human delivery review is still required; no external delivery action was performed.",
  };
}
