/**
 * Harness-independent domain contracts.
 *
 * These are data-only contracts: they deliberately contain no adapter,
 * filesystem, network, UI, or persistence implementation details.
 */

export type RequestId = string;
export type TaskId = string;
export type RunId = string;
export type ApprovalId = string;
export type ArtifactId = string;
export type EvidenceId = string;

export interface FactoryRequest {
  readonly id: RequestId;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly createdAt: string;
  readonly requestedBy: string;
}

export type TaskStatus = "pending" | "ready" | "running" | "succeeded" | "failed" | "skipped";

export interface FactoryTask {
  readonly id: TaskId;
  readonly runId: RunId;
  readonly title: string;
  readonly description: string;
  readonly dependsOn: readonly TaskId[];
  readonly status: TaskStatus;
}

export type WorkflowStatus =
  | "created"
  | "ready"
  | "running"
  | "awaiting_approval"
  | "verifying"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowRun {
  readonly id: RunId;
  readonly requestId: RequestId;
  readonly status: WorkflowStatus;
  /** Monotonically increases by one for each accepted transition. */
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ApprovalOutcome = "approved" | "denied";

export interface ApprovalDecision {
  readonly id: ApprovalId;
  readonly runId: RunId;
  /** Exact action or capability this decision applies to; never a blanket grant. */
  readonly scope: string;
  readonly outcome: ApprovalOutcome;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly rationale?: string;
}

export type ArtifactKind =
  | "patch"
  | "test-report"
  | "review-report"
  | "log"
  | "document"
  | "other";

export interface FactoryArtifact {
  readonly id: ArtifactId;
  readonly runId: RunId;
  readonly kind: ArtifactKind;
  /** Opaque locator interpreted by an owning adapter/store, not the domain layer. */
  readonly uri: string;
  readonly mediaType?: string;
  /** Optional content digest for integrity checks; never an authorization signal. */
  readonly digest?: string;
  readonly createdAt: string;
}

export type EvidenceKind = "command" | "test" | "typecheck" | "approval" | "review" | "other";
export type EvidenceOutcome = "passed" | "failed" | "skipped" | "unknown";

export type EvidenceSource = "model_reported" | "runner_observed" | "review_engine";

export type RunnerVerificationStatus = "passed" | "failed" | "skipped" | "timed_out" | "cancelled" | "blocked";

export interface RunnerVerificationMetadata {
  /** Stable ID from the operator-configured verification profile. */
  readonly checkId: string;
  readonly status: RunnerVerificationStatus;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly observedStdoutBytes: number;
  readonly observedStderrBytes: number;
  readonly outputTruncated: boolean;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
  /** Bounded, sanitized runner-generated reason; never raw stdout/stderr. */
  readonly reason?: string;
}

export interface VerificationEvidence {
  /** Provenance is persisted; a model assertion is never promoted to runner evidence. */
  readonly source: EvidenceSource;
  readonly id: EvidenceId;
  readonly runId: RunId;
  readonly kind: EvidenceKind;
  readonly outcome: EvidenceOutcome;
  readonly summary: string;
  readonly observedAt: string;
  readonly artifactIds: readonly ArtifactId[];
  /** Structured process observations; only the trusted local verification path may populate this. */
  readonly runner?: RunnerVerificationMetadata;
}
