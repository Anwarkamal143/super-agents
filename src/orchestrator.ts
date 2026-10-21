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
      return parsed as PersistedWorkflow[];
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

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
