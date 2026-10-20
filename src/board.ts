export const FACTORY_BOARD_SCHEMA_VERSION = 1 as const;

export const FACTORY_BOARD_STATUSES = [
  "planning", "awaiting_approval", "running", "blocked", "completed", "failed", "cancelled",
] as const;

export const FACTORY_TASK_STATUSES = [
  "pending", "ready", "running", "blocked", "needs_approval", "succeeded", "failed", "skipped", "interrupted",
] as const;

export interface FactoryBoardEvidence {
  readonly kind: "command" | "test" | "typecheck" | "review" | "artifact" | "human-decision" | "other";
  readonly outcome: "passed" | "failed" | "blocked" | "skipped" | "not-run" | "unknown";
  readonly summary: string;
  readonly observedAt: string;
  readonly artifact?: string;
}

export interface FactoryBoardTask {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: (typeof FACTORY_TASK_STATUSES)[number];
  readonly dependsOn: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly owner: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly evidence: readonly FactoryBoardEvidence[];
  readonly approvalRequired?: boolean;
  readonly recoveryNote?: string;
}

export interface FactoryBoardDecision {
  readonly id: string;
  readonly scope: string;
  readonly outcome: "approved" | "denied" | "revoked";
  readonly actor: string;
  readonly decidedAt: string;
  readonly rationale?: string;
}

export interface FactoryBoard {
  readonly schemaVersion: 1;
  readonly factory: {
    readonly id: string;
    readonly title: string;
    readonly request: string;
    readonly orchestrator: string;
    readonly createdAt: string;
  };
  readonly status: (typeof FACTORY_BOARD_STATUSES)[number];
  readonly updatedAt: string;
  readonly tasks: readonly FactoryBoardTask[];
  readonly decisions: readonly FactoryBoardDecision[];
}

export interface FactoryBoardValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isDateTime = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));

const taskIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * Validates the board's safety-critical invariants at runtime. The companion
 * JSON Schema defines the complete interchange shape; this validator adds
 * dependency integrity and cycle detection without external dependencies.
 */
export function validateFactoryBoard(input: unknown): FactoryBoardValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return { valid: false, errors: ["Board must be an object."] };

  if (input["schemaVersion"] !== FACTORY_BOARD_SCHEMA_VERSION) errors.push("schemaVersion must be 1.");
  if (!isRecord(input["factory"])) errors.push("factory must be an object.");
  else {
    for (const key of ["id", "title", "request", "orchestrator"] as const) {
      if (!nonEmpty(input["factory"][key])) errors.push(`factory.${key} must be a non-empty string.`);
    }
    if (!isDateTime(input["factory"]["createdAt"])) errors.push("factory.createdAt must be a date-time string.");
  }
  if (!(FACTORY_BOARD_STATUSES as readonly unknown[]).includes(input["status"])) errors.push("status is not a supported factory status.");
  if (!isDateTime(input["updatedAt"])) errors.push("updatedAt must be a date-time string.");
  if (!Array.isArray(input["tasks"])) errors.push("tasks must be an array.");
  if (!Array.isArray(input["decisions"])) errors.push("decisions must be an array.");

  const tasks = Array.isArray(input["tasks"]) ? input["tasks"] : [];
  const ids = new Set<string>();
  const dependencies = new Map<string, string[]>();
  for (const [index, raw] of tasks.entries()) {
    const prefix = `tasks[${index}]`;
    if (!isRecord(raw)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    if (!nonEmpty(raw["id"]) || !taskIdPattern.test(raw["id"])) errors.push(`${prefix}.id is invalid.`);
    else if (ids.has(raw["id"])) errors.push(`Duplicate task id: ${raw["id"]}.`);
    else ids.add(raw["id"]);
    if (!nonEmpty(raw["title"])) errors.push(`${prefix}.title must be a non-empty string.`);
    if (typeof raw["description"] !== "string") errors.push(`${prefix}.description must be a string.`);
    if (!(FACTORY_TASK_STATUSES as readonly unknown[]).includes(raw["status"])) errors.push(`${prefix}.status is unsupported.`);
    if (!Array.isArray(raw["dependsOn"]) || raw["dependsOn"].some((id) => typeof id !== "string") ||
      (Array.isArray(raw["dependsOn"]) && new Set(raw["dependsOn"]).size !== raw["dependsOn"].length)) {
      errors.push(`${prefix}.dependsOn must be an array of unique task IDs.`);
    }
    if (!Array.isArray(raw["acceptanceCriteria"]) || raw["acceptanceCriteria"].length === 0 ||
      raw["acceptanceCriteria"].some((item) => !nonEmpty(item))) errors.push(`${prefix}.acceptanceCriteria must contain non-empty strings.`);
    if (!nonEmpty(raw["owner"])) errors.push(`${prefix}.owner must be a non-empty string.`);
    if (!Number.isSafeInteger(raw["attempts"]) || (raw["attempts"] as number) < 0) errors.push(`${prefix}.attempts must be a non-negative integer.`);
    if (!Number.isSafeInteger(raw["maxAttempts"]) || (raw["maxAttempts"] as number) < 1 || (raw["maxAttempts"] as number) > 10) {
      errors.push(`${prefix}.maxAttempts must be an integer from 1 to 10.`);
    }
    if (raw["attempts"] !== undefined && raw["maxAttempts"] !== undefined &&
      Number.isSafeInteger(raw["attempts"]) && Number.isSafeInteger(raw["maxAttempts"]) &&
      (raw["attempts"] as number) > (raw["maxAttempts"] as number)) errors.push(`${prefix}.attempts cannot exceed maxAttempts.`);
    if (!Array.isArray(raw["evidence"])) errors.push(`${prefix}.evidence must be an array.`);
    else raw["evidence"].forEach((evidence, evidenceIndex) => {
      if (!isRecord(evidence)) {
        errors.push(`${prefix}.evidence[${evidenceIndex}] must be an object.`);
        return;
      }
      if (!nonEmpty(evidence["kind"]) || !nonEmpty(evidence["outcome"]) || typeof evidence["summary"] !== "string" ||
        !isDateTime(evidence["observedAt"])) errors.push(`${prefix}.evidence[${evidenceIndex}] has invalid required fields.`);
    });
    if (typeof raw["approvalRequired"] !== "undefined" && typeof raw["approvalRequired"] !== "boolean") {
      errors.push(`${prefix}.approvalRequired must be boolean.`);
    }
    if (typeof raw["recoveryNote"] !== "undefined" && typeof raw["recoveryNote"] !== "string") {
      errors.push(`${prefix}.recoveryNote must be a string.`);
    }
    dependencies.set(typeof raw["id"] === "string" ? raw["id"] : `invalid-${index}`,
      Array.isArray(raw["dependsOn"]) ? raw["dependsOn"].filter((id): id is string => typeof id === "string") : []);
  }

  for (const [taskId, deps] of dependencies) {
    for (const dependency of deps) {
      if (!ids.has(dependency)) errors.push(`Task ${taskId} depends on unknown task ${dependency}.`);
      if (dependency === taskId) errors.push(`Task ${taskId} cannot depend on itself.`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      errors.push(`Dependency cycle detected at task ${id}.`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) if (dependencies.has(dependency)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of dependencies.keys()) visit(id);

  const decisions = Array.isArray(input["decisions"]) ? input["decisions"] : [];
  const decisionIds = new Set<string>();
  for (const [index, raw] of decisions.entries()) {
    const prefix = `decisions[${index}]`;
    if (!isRecord(raw)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    if (!nonEmpty(raw["id"])) errors.push(`${prefix}.id must be a non-empty string.`);
    else if (decisionIds.has(raw["id"])) errors.push(`Duplicate decision id: ${raw["id"]}.`);
    else decisionIds.add(raw["id"]);
    if (!nonEmpty(raw.scope) || !nonEmpty(raw.actor)) errors.push(`${prefix} requires a scope and actor.`);
    if (!(["approved", "denied", "revoked"] as readonly unknown[]).includes(raw.outcome)) errors.push(`${prefix}.outcome is unsupported.`);
    if (!isDateTime(raw.decidedAt)) errors.push(`${prefix}.decidedAt must be a date-time string.`);
  }

  return { valid: errors.length === 0, errors };
}
