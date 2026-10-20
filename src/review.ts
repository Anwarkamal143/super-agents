import { createHash, randomUUID } from "node:crypto";

export type ReviewAxis = "standards" | "spec";
export type ReviewSeverity = "critical" | "high" | "medium" | "low" | "info";
export type ReviewFindingStatus = "open" | "resolved" | "accepted";

export interface ReviewFinding {
  readonly id: string;
  readonly severity: ReviewSeverity;
  readonly title: string;
  readonly detail: string;
  readonly file?: string;
  readonly line?: number;
  readonly status: ReviewFindingStatus;
}

export interface AxisReviewReport {
  readonly axis: ReviewAxis;
  readonly status: "passed" | "changes_requested" | "blocked";
  readonly findings: readonly ReviewFinding[];
  readonly summary: string;
}

export interface PinnedReviewInput {
  readonly issueId: string;
  readonly diff: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly spec?: string;
  readonly repositoryStandards: readonly string[];
}

export interface ReviewInput extends PinnedReviewInput {
  readonly diffDigest: string;
  readonly fixedPoint: string;
}

export interface ReviewAggregate {
  readonly status: "passed" | "changes_requested" | "blocked";
  readonly fixedPoint: string;
  readonly diffDigest: string;
  readonly standards: AxisReviewReport;
  readonly spec: AxisReviewReport;
  readonly repairAttempts: number;
  readonly repairLimit: number;
  readonly history: readonly ReviewCycle[];
  readonly reason?: string;
}

export interface ReviewCycle {
  readonly fixedPoint: string;
  readonly diffDigest: string;
  readonly standards: AxisReviewReport;
  readonly spec: AxisReviewReport;
  readonly verification: "passed" | "failed" | "incomplete";
}

export interface ReviewEngine {
  readonly reviewStandards: (input: ReviewInput) => Promise<unknown>;
  readonly reviewSpec: (input: ReviewInput) => Promise<unknown>;
}

export interface ReviewOptions {
  readonly id?: () => string;
}

export class ReviewInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewInputError";
  }
}

export class ReviewOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewOutputError";
  }
}

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const FINDING_STATUSES = ["open", "resolved", "accepted"] as const;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

/** Validate and pin review context before invoking either reviewer. */
export function prepareReviewInput(input: PinnedReviewInput): ReviewInput {
  if (!input.issueId.trim()) throw new ReviewInputError("An originating issue/spec identifier is required.");
  if (!COMMIT_PATTERN.test(input.baseCommit)) {
    throw new ReviewInputError("Invalid diff base: baseCommit must be a full 40- or 64-character commit hash.");
  }
  if (!COMMIT_PATTERN.test(input.headCommit)) {
    throw new ReviewInputError("Invalid fixed point: headCommit must be a full 40- or 64-character commit hash.");
  }
  if (input.baseCommit.toLowerCase() === input.headCommit.toLowerCase()) {
    throw new ReviewInputError("The review diff base and fixed point must be different commits.");
  }
  if (!input.diff.trim()) throw new ReviewInputError("Cannot review an empty diff.");
  if (!Array.isArray(input.repositoryStandards) || input.repositoryStandards.length === 0 ||
      input.repositoryStandards.some((standard) => typeof standard !== "string" || !standard.trim())) {
    throw new ReviewInputError("At least one non-empty repository standard is required.");
  }
  if (input.spec !== undefined && !input.spec.trim()) {
    throw new ReviewInputError("A supplied spec must be non-empty; omit it to explicitly report a missing spec.");
  }
  const fixedPoint = input.headCommit.toLowerCase();
  return {
    ...input,
    baseCommit: input.baseCommit.toLowerCase(),
    headCommit: fixedPoint,
    diffDigest: createHash("sha256").update(input.diff, "utf8").digest("hex"),
    fixedPoint,
  };
}

/** Run two independent axes against the same immutable diff fixed point. */
export async function reviewPinnedDiff(input: PinnedReviewInput, engine: ReviewEngine): Promise<ReviewAggregate> {
  const prepared = prepareReviewInput(input);
  const standardsRaw = await engine.reviewStandards(prepared);
  const standards = validateAxisReviewReport(standardsRaw, "standards");
  let spec: AxisReviewReport;

  if (input.spec === undefined) {
    spec = {
      axis: "spec",
      status: "blocked",
      findings: [],
      summary: "No originating specification was supplied; spec compliance cannot be assessed.",
    };
  } else {
    const specRaw = await engine.reviewSpec(prepared);
    spec = validateAxisReviewReport(specRaw, "spec");
  }

  const status = standards.status === "blocked" || spec.status === "blocked"
    ? "blocked"
    : standards.status === "changes_requested" || spec.status === "changes_requested"
      ? "changes_requested"
      : "passed";
  const cycle: ReviewCycle = {
    fixedPoint: prepared.fixedPoint,
    diffDigest: prepared.diffDigest,
    standards,
    spec,
    verification: "incomplete",
  };
  return {
    status,
    fixedPoint: prepared.fixedPoint,
    diffDigest: prepared.diffDigest,
    standards,
    spec,
    repairAttempts: 0,
    repairLimit: 0,
    history: [cycle],
    ...(status === "blocked" ? { reason: "Review blocked because required review context or an axis report is unavailable." } : {}),
  };
}

export function validateAxisReviewReport(value: unknown, expectedAxis: ReviewAxis): AxisReviewReport {
  if (!isRecord(value) || value.axis !== expectedAxis ||
      (value.status !== "passed" && value.status !== "changes_requested" && value.status !== "blocked") ||
      typeof value.summary !== "string" || !value.summary.trim() || !Array.isArray(value.findings)) {
    throw new ReviewOutputError(`Malformed ${expectedAxis} review report.`);
  }

  const seen = new Set<string>();
  const findings: ReviewFinding[] = value.findings.map((raw, index) => {
    if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id.trim() || seen.has(raw.id) ||
        !SEVERITIES.includes(raw.severity as ReviewSeverity) ||
        typeof raw.title !== "string" || !raw.title.trim() ||
        typeof raw.detail !== "string" || !raw.detail.trim() ||
        !FINDING_STATUSES.includes(raw.status as ReviewFindingStatus)) {
      throw new ReviewOutputError(`Malformed ${expectedAxis} finding at index ${index}.`);
    }
    seen.add(raw.id);
    if (raw.file !== undefined && (typeof raw.file !== "string" || !raw.file.trim() || raw.file.startsWith("/") ||
      raw.file.split(/[\\/]/).includes(".."))) {
      throw new ReviewOutputError(`Invalid file path in ${expectedAxis} finding ${raw.id}.`);
    }
    if (raw.line !== undefined && (!Number.isSafeInteger(raw.line) || (raw.line as number) < 1)) {
      throw new ReviewOutputError(`Invalid line number in ${expectedAxis} finding ${raw.id}.`);
    }
    return {
      id: raw.id,
      severity: raw.severity as ReviewSeverity,
      title: raw.title,
      detail: raw.detail,
      ...(raw.file !== undefined ? { file: raw.file as string } : {}),
      ...(raw.line !== undefined ? { line: raw.line as number } : {}),
      status: raw.status as ReviewFindingStatus,
    };
  });

  if (value.status === "passed" && findings.some((finding) =>
    finding.status === "open" && (finding.severity === "critical" || finding.severity === "high"))) {
    throw new ReviewOutputError(`${expectedAxis} report cannot pass with open critical/high findings.`);
  }
  if (value.status === "passed" && findings.some((finding) => finding.status === "open")) {
    throw new ReviewOutputError(`${expectedAxis} report cannot pass with open findings.`);
  }
  return {
    axis: expectedAxis,
    status: value.status,
    summary: value.summary,
    findings,
  };
}

export interface RepairVerification {
  readonly status: "passed" | "failed" | "incomplete";
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly diff: string;
}

export interface BoundedRepairOptions {
  readonly initial: PinnedReviewInput;
  readonly engine: ReviewEngine;
  readonly maxRepairAttempts: number;
  /** Must authorize the exact proposed repair before it is applied. */
  readonly authorizeRepair: (input: { readonly issueId: string; readonly fixedPoint: string; readonly diffDigest: string; readonly attempt: number }) => Promise<boolean>;
  /** Applies a repair and returns the new pinned diff. */
  readonly repair: (input: { readonly review: ReviewAggregate; readonly attempt: number }) => Promise<PinnedReviewInput>;
  /** Runs verification against the repaired fixed point; it must not be bypassed. */
  readonly verify: (input: PinnedReviewInput) => Promise<RepairVerification>;
  readonly id?: () => string;
}

/**
 * Bounded repair loop. Every repair is authorized, then verified, then reviewed
 * again against a new fixed point. This coordinates callbacks; it does not
 * authenticate approvers or execute verification itself.
 */
export async function reviewWithBoundedRepair(options: BoundedRepairOptions): Promise<ReviewAggregate> {
  if (!Number.isSafeInteger(options.maxRepairAttempts) || options.maxRepairAttempts < 0 || options.maxRepairAttempts > 20) {
    throw new RangeError("maxRepairAttempts must be an integer between 0 and 20.");
  }
  const history: ReviewCycle[] = [];
  let input = options.initial;
  let attempts = 0;
  let current = await reviewPinnedDiff(input, options.engine);
  history.push(...current.history);

  while (current.status === "changes_requested" && attempts < options.maxRepairAttempts) {
    const attempt = attempts + 1;
    const approved = await options.authorizeRepair({
      issueId: input.issueId,
      fixedPoint: current.fixedPoint,
      diffDigest: current.diffDigest,
      attempt,
    });
    if (!approved) {
      return { ...current, status: "blocked", repairAttempts: attempts, repairLimit: options.maxRepairAttempts,
        history, reason: "Repair was not authorized; stopping without applying changes." };
    }

    const repaired = await options.repair({ review: current, attempt });
    const verification = await options.verify(repaired);
    attempts = attempt;
    if (verification.status !== "passed") {
      const failedCycle: ReviewCycle = {
        fixedPoint: verification.headCommit,
        diffDigest: createHash("sha256").update(verification.diff, "utf8").digest("hex"),
        standards: current.standards,
        spec: current.spec,
        verification: verification.status,
      };
      history.push(failedCycle);
      return {
        ...current,
        status: "blocked",
        fixedPoint: verification.headCommit,
        diffDigest: failedCycle.diffDigest,
        repairAttempts: attempts,
        repairLimit: options.maxRepairAttempts,
        history,
        reason: `Verification after repair ${attempt} was ${verification.status}; review cannot continue.`,
      };
    }

    input = repaired;
    current = await reviewPinnedDiff(input, options.engine);
    const last = current.history[0];
    history.push({ ...last, verification: "passed" });
  }

  if (current.status === "changes_requested" && attempts >= options.maxRepairAttempts) {
    return {
      ...current,
      status: "blocked",
      repairAttempts: attempts,
      repairLimit: options.maxRepairAttempts,
      history,
      reason: `Repair limit exhausted after ${attempts} attempt(s); human intervention is required.`,
    };
  }
  return { ...current, repairAttempts: attempts, repairLimit: options.maxRepairAttempts, history };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
