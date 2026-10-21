import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { withFileLock } from "./file-lock.js";
import type { VerificationEvidence, WorkflowRun, WorkflowStatus } from "./domain.js";
import { transitionWorkflow } from "./workflow.js";

export interface WorkflowEvent {
  readonly runId: string;
  readonly revision: number;
  readonly from: WorkflowStatus | null;
  readonly to: WorkflowStatus;
  readonly at: string;
  readonly kind?: "transition" | "step_started" | "step_finished" | "step_interrupted" | "step_reconciled";
  readonly stepId?: string;
  readonly stepStatus?: StepStatus;
  readonly actor?: string;
  /** Digest only; free-form summaries/reasons are deliberately not copied into the audit trail. */
  readonly detailDigest?: string;
}

export type StepStatus = "running" | "succeeded" | "failed" | "interrupted";

export interface WorkflowStepRecord {
  readonly id: string;
  readonly status: StepStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly summary?: string;
  readonly attempt?: number;
}

export interface PersistedWorkflow {
  readonly run: WorkflowRun;
  readonly events: readonly WorkflowEvent[];
  readonly steps: Readonly<Record<string, WorkflowStepRecord>>;
  readonly evidence: readonly VerificationEvidence[];
}

export interface WorkflowStore {
  load(): Promise<readonly PersistedWorkflow[]>;
  save(workflows: readonly PersistedWorkflow[]): Promise<void>;
  withExclusive?<T>(operation: () => Promise<T>): Promise<T>;
}

export class WorkflowConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowConflictError";
  }
}

export class JsonFileWorkflowStore implements WorkflowStore {
  constructor(private readonly filePath: string) {}

  withExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return withFileLock(`${this.filePath}.lock`, operation);
  }

  async load(): Promise<readonly PersistedWorkflow[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new TypeError("Workflow store must contain a JSON array.");
      return validatePersistedWorkflows(parsed);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
  }

  async save(workflows: readonly PersistedWorkflow[]): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(workflows, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      // Never report success if durable replacement fails; best-effort cleanup
      // does not hide the original persistence error.
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(temporaryPath);
      } catch {
        // The temporary file may not have been created or may already be gone.
      }
      throw error;
    }
  }
}

export interface OrchestratorOptions {
  readonly now?: () => string;
}

export type StepStartResult =
  | { readonly status: "started"; readonly step: WorkflowStepRecord }
  | { readonly status: "already_completed"; readonly step: WorkflowStepRecord }
  | { readonly status: "already_running"; readonly step: WorkflowStepRecord }
  | { readonly status: "reconciliation_required"; readonly step: WorkflowStepRecord };

export class WorkflowOrchestrator {
  private tail: Promise<void> = Promise.resolve();
  private readonly now: () => string;

  constructor(
    private readonly store: WorkflowStore,
    options: OrchestratorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = () => this.store.withExclusive ? this.store.withExclusive(operation) : operation();
    const result = this.tail.then(run, run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readAll(): Promise<PersistedWorkflow[]> {
    return (await this.store.load()).map((workflow) => ({
      ...workflow,
      events: [...workflow.events],
      steps: { ...workflow.steps },
      evidence: [...workflow.evidence],
    }));
  }

  private async writeAll(workflows: readonly PersistedWorkflow[]): Promise<void> {
    await this.store.save(workflows);
  }

  async listRuns(): Promise<readonly WorkflowRun[]> {
    return this.exclusive(async () => (await this.readAll()).map(({ run }) => run));
  }

  async getWorkflow(runId: string): Promise<PersistedWorkflow | undefined> {
    return this.exclusive(async () => (await this.readAll()).find((item) => item.run.id === runId));
  }

  async createRun(run: WorkflowRun): Promise<PersistedWorkflow> {
    return this.exclusive(async () => {
      const workflows = await this.readAll();
      if (workflows.some((item) => item.run.id === run.id)) {
        throw new WorkflowConflictError(`Workflow run already exists: ${run.id}`);
      }
      const created: PersistedWorkflow = {
        run,
        events: [{ runId: run.id, revision: run.revision, from: null, to: run.status, at: run.createdAt, kind: "transition" }],
        steps: {},
        evidence: [],
      };
      await this.writeAll([...workflows, created]);
      return created;
    });
  }

  async transition(runId: string, to: WorkflowStatus, expectedRevision: number): Promise<WorkflowRun> {
    return this.exclusive(async () => {
      const workflows = await this.readAll();
      const index = workflows.findIndex((item) => item.run.id === runId);
      if (index < 0) throw new WorkflowConflictError(`Workflow run not found: ${runId}`);
      const current = workflows[index]!;
      if (current.run.revision !== expectedRevision) {
        throw new WorkflowConflictError(
          `Revision conflict for ${runId}: expected ${expectedRevision}, found ${current.run.revision}`,
        );
      }
      const at = this.now();
      const updatedRun = transitionWorkflow(current.run, to, at);
      const updated: PersistedWorkflow = {
        ...current,
        run: updatedRun,
        events: [...current.events, {
          runId,
          revision: updatedRun.revision,
          from: current.run.status,
          to,
          at,
          kind: "transition",
        }],
      };
      const next = [...workflows];
      next[index] = updated;
      await this.writeAll(next);
      return updatedRun;
    });
  }

  async beginStep(runId: string, stepId: string): Promise<StepStartResult> {
    return this.exclusive(async () => {
      if (!stepId.trim()) throw new TypeError("Step id must be non-empty.");
      const workflows = await this.readAll();
      const index = workflows.findIndex((item) => item.run.id === runId);
      if (index < 0) throw new WorkflowConflictError(`Workflow run not found: ${runId}`);
      const current = workflows[index]!;
      const existing = current.steps[stepId];
      if (existing?.status === "succeeded") return { status: "already_completed", step: existing };
      if (existing?.status === "running") return { status: "already_running", step: existing };
      if (existing?.status === "interrupted") return { status: "reconciliation_required", step: existing };
      const at = this.now();
      const step: WorkflowStepRecord = { id: stepId, status: "running", startedAt: at, attempt: (existing?.attempt ?? 0) + 1 };
      const next = [...workflows];
      next[index] = {
        ...current,
        steps: { ...current.steps, [stepId]: step },
        events: [...current.events, {
          runId, revision: current.run.revision, from: current.run.status, to: current.run.status,
          at, kind: "step_started", stepId, stepStatus: "running",
        }],
      };
      await this.writeAll(next);
      return { status: "started", step };
    });
  }

  async finishStep(
    runId: string,
    stepId: string,
    outcome: "succeeded" | "failed",
    summary: string,
    evidence?: VerificationEvidence,
  ): Promise<WorkflowStepRecord> {
    return this.exclusive(async () => {
      const workflows = await this.readAll();
      const index = workflows.findIndex((item) => item.run.id === runId);
      if (index < 0) throw new WorkflowConflictError(`Workflow run not found: ${runId}`);
      const current = workflows[index]!;
      const existing = current.steps[stepId];
      if (!existing || existing.status !== "running") {
        throw new WorkflowConflictError(`Step is not running: ${stepId}`);
      }
      const at = this.now();
      const step: WorkflowStepRecord = {
        id: stepId, status: outcome, startedAt: existing.startedAt, finishedAt: at,
        summary, attempt: existing.attempt ?? 1,
      };
      const next = [...workflows];
      next[index] = {
        ...current,
        steps: { ...current.steps, [stepId]: step },
        events: [...current.events, {
          runId, revision: current.run.revision, from: current.run.status, to: current.run.status,
          at, kind: "step_finished", stepId, stepStatus: outcome,
          detailDigest: digestText(summary),
        }],
        evidence: evidence ? [...current.evidence, evidence] : current.evidence,
      };
      await this.writeAll(next);
      return step;
    });
  }
  async recoverInterruptedSteps(runId: string, actor: string, expectedRunningStepIds?: readonly string[]): Promise<readonly WorkflowStepRecord[]> {
    return this.exclusive(async () => {
      if (!actor.trim()) throw new TypeError("Recovery actor must be non-empty.");
      const workflows = await this.readAll();
      const index = workflows.findIndex((item) => item.run.id === runId);
      if (index < 0) throw new WorkflowConflictError(`Workflow run not found: ${runId}`);
      const current = workflows[index]!;
      if (expectedRunningStepIds) {
        const actual = Object.values(current.steps).filter((step) => step.status === "running").map((step) => step.id).sort();
        const expected = [...expectedRunningStepIds].sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new WorkflowConflictError("Running steps changed during recovery approval; reload and inspect current steps.");
        }
      }
      const at = this.now();
      const steps: Record<string, WorkflowStepRecord> = { ...current.steps };
      const events: WorkflowEvent[] = [...current.events];
      const recovered: WorkflowStepRecord[] = [];
      for (const [stepId, existing] of Object.entries(current.steps)) {
        if (existing.status !== "running") continue;
        const step: WorkflowStepRecord = { ...existing, status: "interrupted" };
        steps[stepId] = step;
        recovered.push(step);
        events.push({
          runId, revision: current.run.revision, from: current.run.status, to: current.run.status,
          at, kind: "step_interrupted", stepId, stepStatus: "interrupted", actor,
        });
      }
      if (recovered.length > 0) {
        const next = [...workflows];
        next[index] = { ...current, steps, events };
        await this.writeAll(next);
      }
      return recovered;
    });
  }

  async resolveInterruptedStep(
    runId: string,
    stepId: string,
    resolution: "confirm_succeeded" | "confirm_failed" | "retry",
    actor: string,
    reason: string,
    options: { readonly externalEffectReconciled?: boolean } = {},
  ): Promise<WorkflowStepRecord> {
    return this.exclusive(async () => {
      if (!actor.trim()) throw new TypeError("Recovery actor must be non-empty.");
      if (!reason.trim()) throw new TypeError("A reconciliation reason is required.");
      if (resolution === "retry" && options.externalEffectReconciled !== true) {
        throw new WorkflowConflictError("Retry requires explicit confirmation that the external effect was reconciled and replay is safe.");
      }
      const workflows = await this.readAll();
      const index = workflows.findIndex((item) => item.run.id === runId);
      if (index < 0) throw new WorkflowConflictError(`Workflow run not found: ${runId}`);
      const current = workflows[index]!;
      const existing = current.steps[stepId];
      if (!existing || existing.status !== "interrupted") {
        throw new WorkflowConflictError(`Step is not awaiting reconciliation: ${stepId}`);
      }
      const at = this.now();
      const status: StepStatus = resolution === "confirm_succeeded" ? "succeeded"
        : resolution === "confirm_failed" ? "failed" : "running";
      const step: WorkflowStepRecord = resolution === "retry"
        ? { id: stepId, status, startedAt: at, attempt: (existing.attempt ?? 1) + 1 }
        : { ...existing, status, finishedAt: at, summary: `Reconciled: ${resolution}` };
      const next = [...workflows];
      next[index] = {
        ...current,
        steps: { ...current.steps, [stepId]: step },
        events: [...current.events, {
          runId, revision: current.run.revision, from: current.run.status, to: current.run.status,
          at, kind: "step_reconciled", stepId, stepStatus: status, actor,
          detailDigest: digestText(reason),
        }],
      };
      await this.writeAll(next);
      return step;
    });
  }

}

const WORKFLOW_STATUSES = new Set<WorkflowStatus>([
  "created", "ready", "running", "awaiting_approval", "verifying", "reviewing",
  "completed", "failed", "cancelled",
]);

/**
 * Validate persisted records before callers use their status for authorization.
 * Evidence provenance remains optional for compatibility with records written
 * before the source field was introduced.
 */
function validatePersistedWorkflows(value: unknown[]): PersistedWorkflow[] {
  const seenRunIds = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const label = `Workflow store record at index ${index}`;
    if (!isRecord(candidate)) throw new TypeError(`${label} must be an object.`);
    const run = candidate["run"];
    if (!isRecord(run)) throw new TypeError(`${label}.run must be an object.`);
    if (!isNonEmptyString(run["id"]) || !isNonEmptyString(run["requestId"])) {
      throw new TypeError(`${label}.run must include non-empty id and requestId fields.`);
    }
    if (!isWorkflowStatus(run["status"])) {
      throw new TypeError(`${label}.run.status is not a recognized workflow status.`);
    }
    if (!Number.isSafeInteger(run["revision"]) || (run["revision"] as number) < 0) {
      throw new TypeError(`${label}.run.revision must be a non-negative safe integer.`);
    }
    if (!isNonEmptyString(run["createdAt"]) || !isNonEmptyString(run["updatedAt"])) {
      throw new TypeError(`${label}.run must include non-empty createdAt and updatedAt timestamps.`);
    }
    const runId = run["id"];
    if (seenRunIds.has(runId)) throw new TypeError(`Workflow store contains duplicate run id: ${runId}`);
    seenRunIds.add(runId);
    const events = candidate["events"];
    if (!Array.isArray(events)) {
      throw new TypeError(`${label}.events must be an array of objects.`);
    }
    for (const [eventIndex, event] of events.entries()) {
      if (!isRecord(event) ||
          event["runId"] !== runId ||
          !Number.isSafeInteger(event["revision"]) || (event["revision"] as number) < 0 ||
          !(event["from"] === null || isWorkflowStatus(event["from"])) ||
          !isWorkflowStatus(event["to"]) ||
          !isNonEmptyString(event["at"]) ||
          (event["kind"] !== undefined && !["transition", "step_started", "step_finished", "step_interrupted", "step_reconciled"].includes(String(event["kind"]))) ||
          (event["stepId"] !== undefined && !isNonEmptyString(event["stepId"])) ||
          (event["stepStatus"] !== undefined && !["running", "succeeded", "failed", "interrupted"].includes(String(event["stepStatus"]))) ||
          (event["actor"] !== undefined && !isNonEmptyString(event["actor"])) ||
          (event["detailDigest"] !== undefined && !isNonEmptyString(event["detailDigest"]))) {
        throw new TypeError(`${label}.events[${eventIndex}] has an invalid structure.`);
      }
    }
    const steps = candidate["steps"];
    if (!isRecord(steps)) {
      throw new TypeError(`${label}.steps must be an object keyed by step id.`);
    }
    for (const [stepId, step] of Object.entries(steps)) {
      const status = isRecord(step) ? step["status"] : undefined;
      const terminal = status === "succeeded" || status === "failed";
      if (!isRecord(step) || step["id"] !== stepId || !isNonEmptyString(step["id"]) ||
          !isNonEmptyString(step["startedAt"]) ||
          !["running", "succeeded", "failed", "interrupted"].includes(String(status)) ||
          (step["finishedAt"] !== undefined && !isNonEmptyString(step["finishedAt"])) ||
          (step["summary"] !== undefined && !isNonEmptyString(step["summary"])) ||
          (terminal && (!isNonEmptyString(step["finishedAt"]) || !isNonEmptyString(step["summary"]))) ||
          (step["attempt"] !== undefined && (!Number.isSafeInteger(step["attempt"]) || (step["attempt"] as number) < 1))) {
        throw new TypeError(`${label}.steps[${JSON.stringify(stepId)}] has an invalid structure.`);
      }
    }
    const evidence = candidate["evidence"];
    if (!Array.isArray(evidence)) {
      throw new TypeError(`${label}.evidence must be an array of objects.`);
    }
    for (const [evidenceIndex, item] of evidence.entries()) {
      if (!isRecord(item) ||
          !isNonEmptyString(item["id"]) ||
          item["runId"] !== runId ||
          !["command", "test", "typecheck", "approval", "review", "other"].includes(String(item["kind"])) ||
          !["passed", "failed", "skipped", "unknown"].includes(String(item["outcome"])) ||
          !isNonEmptyString(item["summary"]) ||
          !isNonEmptyString(item["observedAt"]) ||
          !Array.isArray(item["artifactIds"]) ||
          !item["artifactIds"].every(isNonEmptyString) ||
          (item["source"] !== undefined && !["model_reported", "runner_observed", "review_engine"].includes(String(item["source"])))) {
        throw new TypeError(`${label}.evidence[${evidenceIndex}] has an invalid structure.`);
      }
    }
  }
  return value as PersistedWorkflow[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return typeof value === "string" && WORKFLOW_STATUSES.has(value as WorkflowStatus);
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
