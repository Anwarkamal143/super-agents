import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { VerificationEvidence, WorkflowRun, WorkflowStatus } from "./domain.js";
import { transitionWorkflow } from "./workflow.js";

export interface WorkflowEvent {
  readonly runId: string;
  readonly revision: number;
  readonly from: WorkflowStatus | null;
  readonly to: WorkflowStatus;
  readonly at: string;
}

export type StepStatus = "running" | "succeeded" | "failed";

export interface WorkflowStepRecord {
  readonly id: string;
  readonly status: StepStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly summary?: string;
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
}

export class WorkflowConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowConflictError";
  }
}

export class JsonFileWorkflowStore implements WorkflowStore {
  constructor(private readonly filePath: string) {}

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
      await writeFile(temporaryPath, JSON.stringify(workflows, null, 2), { encoding: "utf8", flag: "wx" });
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
  | { readonly status: "already_running"; readonly step: WorkflowStepRecord };

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
    const result = this.tail.then(operation, operation);
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
        events: [{ runId: run.id, revision: run.revision, from: null, to: run.status, at: run.createdAt }],
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
      const step: WorkflowStepRecord = { id: stepId, status: "running", startedAt: this.now() };
      const next = [...workflows];
      next[index] = { ...current, steps: { ...current.steps, [stepId]: step } };
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
      const step: WorkflowStepRecord = {
        id: stepId,
        status: outcome,
        startedAt: existing.startedAt,
        finishedAt: this.now(),
        summary,
      };
      const next = [...workflows];
      next[index] = {
        ...current,
        steps: { ...current.steps, [stepId]: step },
        evidence: evidence ? [...current.evidence, evidence] : current.evidence,
      };
      await this.writeAll(next);
      return step;
    });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
