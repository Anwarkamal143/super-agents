import type { WorkflowRun, WorkflowStatus } from "./domain.js";

/**
 * The only supported state changes for a workflow run.
 *
 * Terminal states intentionally have no outgoing transitions. Approval
 * denial is represented by cancellation; a future policy layer may preserve
 * the denial as a separate ApprovalDecision record.
 */
export const WORKFLOW_TRANSITIONS = {
  created: ["ready", "cancelled"],
  ready: ["running", "cancelled"],
  running: ["awaiting_approval", "verifying", "failed", "cancelled"],
  awaiting_approval: ["running", "cancelled"],
  verifying: ["reviewing", "failed", "cancelled"],
  reviewing: ["completed", "running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<WorkflowStatus, readonly WorkflowStatus[]>;

export class WorkflowTransitionError extends Error {
  readonly from: WorkflowStatus;
  readonly to: WorkflowStatus;

  constructor(from: WorkflowStatus, to: WorkflowStatus) {
    super(`Invalid workflow transition: ${from} -> ${to}`);
    this.name = "WorkflowTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * Returns a new run when the transition is legal. The supplied timestamp
 * makes the operation deterministic and testable; the input object is never
 * mutated. Revision increments exactly once on success.
 */
export function transitionWorkflow(
  run: WorkflowRun,
  to: WorkflowStatus,
  at: string,
): WorkflowRun {
  if (!Number.isFinite(Date.parse(at))) {
    throw new RangeError(`Invalid transition timestamp: ${at}`);
  }

  const allowed: readonly WorkflowStatus[] = WORKFLOW_TRANSITIONS[run.status];
  if (!allowed.includes(to)) {
    throw new WorkflowTransitionError(run.status, to);
  }

  return {
    ...run,
    status: to,
    revision: run.revision + 1,
    updatedAt: at,
  };
}

export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return WORKFLOW_TRANSITIONS[status].length === 0;
}
