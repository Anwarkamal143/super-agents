import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "./file-lock.js";

export const CONSEQUENT_ACTIONS = [
  "file.write",
  "command.execute",
  "network.request",
  "git.branch.create",
  "git.pull_request.create",
  "git.merge",
  "deployment.execute",
] as const;

export type ConsequentialAction = (typeof CONSEQUENT_ACTIONS)[number];
export type PolicyDecisionOutcome = "approved" | "denied";
export type ApprovalStatus = "active" | "consumed" | "revoked";

export interface ApprovalDecisionInput {
  readonly actionType: string;
  readonly payload: unknown;
  readonly outcome: PolicyDecisionOutcome;
  readonly decidedBy: string;
  readonly rationale?: string;
  /** Optional workflow/run scope for host integrations; not an authenticated identity. */
  readonly scopeId?: string;
  /** Workflow revision the human approved; absent on legacy records and never sufficient for native-tool authorization. */
  readonly workflowRevision?: number;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly actionType: ConsequentialAction;
  readonly payloadDigest: string;
  readonly outcome: PolicyDecisionOutcome;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly status: ApprovalStatus;
  readonly scopeId?: string;
  /** Workflow revision the human approved; legacy records may omit it. */
  readonly workflowRevision?: number;
}

export type ApprovalAuditKind =
  | "decision_recorded"
  | "authorization_denied_unknown_action"
  | "authorization_denied_missing_approval"
  | "authorization_denied_mismatch"
  | "authorization_denied_replay"
  | "authorization_granted"
  | "approval_revoked";

export interface ApprovalAuditEvent {
  readonly id: string;
  readonly kind: ApprovalAuditKind;
  readonly approvalId?: string;
  readonly actionType: string;
  readonly payloadDigest: string;
  readonly actor: string;
  readonly decisionOutcome?: PolicyDecisionOutcome;
  readonly at: string;
}

export interface ApprovalLedgerState {
  readonly approvals: readonly ApprovalRecord[];
  readonly events: readonly ApprovalAuditEvent[];
}

export interface ApprovalStore {
  load(): Promise<ApprovalLedgerState>;
  save(state: ApprovalLedgerState): Promise<void>;
  withExclusive?<T>(operation: () => Promise<T>): Promise<T>;
}

export class JsonFileApprovalStore implements ApprovalStore {
  constructor(private readonly filePath: string) {}

  withExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return withFileLock(`${this.filePath}.lock`, operation);
  }

  async load(): Promise<ApprovalLedgerState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!isLedgerState(parsed)) throw new TypeError("Approval store has an invalid structure.");
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return { approvals: [], events: [] };
      throw error;
    }
  }

  async save(state: ApprovalLedgerState): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(state, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(temporaryPath);
      } catch {
        // Preserve the original persistence failure.
      }
      throw error;
    }
  }
}

export type AuthorizationResult =
  | { readonly allowed: true; readonly approvalId: string; readonly payloadDigest: string }
  | { readonly allowed: false; readonly reason: "unknown_action" | "missing_approval" | "mismatch" | "replay" | "denied" };

export interface ApprovalPolicyOptions {
  readonly now?: () => string;
  readonly id?: () => string;
}

/**
 * Records scoped human decisions and consumes each approval at most once.
 * A decision is bound to an action type and a canonical SHA-256 payload digest.
 * The policy is default-deny; file-backed operations use a same-host cooperative lock, not a distributed transaction.
 */
export class ApprovalPolicy {
  private tail: Promise<void> = Promise.resolve();
  private readonly now: () => string;
  private readonly id: () => string;

  constructor(private readonly store: ApprovalStore, options: ApprovalPolicyOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? randomUUID;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = () => this.store.withExclusive ? this.store.withExclusive(operation) : operation();
    const result = this.tail.then(run, run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async listApprovals(): Promise<readonly ApprovalRecord[]> {
    return this.exclusive(async () => (await this.store.load()).approvals.map((item) => ({ ...item })));
  }

  async listAuditEvents(): Promise<readonly ApprovalAuditEvent[]> {
    return this.exclusive(async () => (await this.store.load()).events.map((item) => ({ ...item })));
  }

  async recordDecision(input: ApprovalDecisionInput): Promise<ApprovalRecord> {
    return this.exclusive(async () => {
      if (!isConsequentialAction(input.actionType)) {
        throw new TypeError(`Unknown action cannot be approved: ${input.actionType}`);
      }
      if (!input.decidedBy.trim()) throw new TypeError("decidedBy must be non-empty.");
      if (input.scopeId !== undefined && !input.scopeId.trim()) throw new TypeError("scopeId must be non-empty when provided.");
      if (input.workflowRevision !== undefined && (!Number.isSafeInteger(input.workflowRevision) || input.workflowRevision < 0)) {
        throw new TypeError("workflowRevision must be a non-negative safe integer when provided.");
      }
      const payloadDigest = digestPayload(input.payload);
      const state = await this.store.load();
      const at = this.now();
      const record: ApprovalRecord = {
        id: this.id(),
        actionType: input.actionType,
        payloadDigest,
        outcome: input.outcome,
        decidedBy: input.decidedBy,
        decidedAt: at,
        status: input.outcome === "approved" ? "active" : "revoked",
        ...(input.scopeId ? { scopeId: input.scopeId } : {}),
        ...(input.workflowRevision !== undefined ? { workflowRevision: input.workflowRevision } : {}),
      };
      const event: ApprovalAuditEvent = {
        id: this.id(),
        kind: "decision_recorded",
        approvalId: record.id,
        actionType: record.actionType,
        payloadDigest,
        actor: record.decidedBy,
        decisionOutcome: record.outcome,
        at,
      };
      await this.store.save({ approvals: [...state.approvals, record], events: [...state.events, event] });
      return record;
    });
  }

  async authorizeAndConsume(
    actionType: string,
    payload: unknown,
    approvalId: string | undefined,
    actor: string,
  ): Promise<AuthorizationResult> {
    return this.exclusive(async () => {
      if (!actor.trim()) throw new TypeError("actor must be non-empty.");
      const payloadDigest = digestPayload(payload);
      const state = await this.store.load();
      const now = this.now();
      const base = { actionType, payloadDigest, actor, at: now };
      const deny = async (kind: ApprovalAuditKind, reason: Exclude<AuthorizationResult, { allowed: true }>["reason"], approval?: ApprovalRecord): Promise<AuthorizationResult> => {
        await this.store.save({
          approvals: state.approvals,
          events: [...state.events, { id: this.id(), kind, ...base, ...(approval ? { approvalId: approval.id } : {}) }],
        });
        return { allowed: false, reason };
      };

      if (!isConsequentialAction(actionType)) {
        return deny("authorization_denied_unknown_action", "unknown_action");
      }
      if (!approvalId) return deny("authorization_denied_missing_approval", "missing_approval");

      const record = state.approvals.find((item) => item.id === approvalId);
      if (!record) return deny("authorization_denied_missing_approval", "missing_approval");
      if (record.outcome !== "approved") return deny("authorization_denied_mismatch", "denied", record);
      if (record.status !== "active") return deny("authorization_denied_replay", "replay", record);
      if (record.actionType !== actionType || record.payloadDigest !== payloadDigest) {
        return deny("authorization_denied_mismatch", "mismatch", record);
      }

      const consumed: ApprovalRecord = { ...record, status: "consumed" };
      const event: ApprovalAuditEvent = {
        id: this.id(),
        kind: "authorization_granted",
        approvalId: record.id,
        ...base,
      };
      await this.store.save({
        approvals: state.approvals.map((item) => item.id === record.id ? consumed : item),
        events: [...state.events, event],
      });
      return { allowed: true, approvalId: record.id, payloadDigest };
    });
  }

  async revoke(approvalId: string, actor: string): Promise<boolean> {
    return this.exclusive(async () => {
      if (!actor.trim()) throw new TypeError("actor must be non-empty.");
      const state = await this.store.load();
      const record = state.approvals.find((item) => item.id === approvalId);
      if (!record || record.status !== "active") return false;
      const at = this.now();
      await this.store.save({
        approvals: state.approvals.map((item) => item.id === approvalId ? { ...item, status: "revoked" } : item),
        events: [...state.events, {
          id: this.id(),
          kind: "approval_revoked",
          approvalId,
          actionType: record.actionType,
          payloadDigest: record.payloadDigest,
          actor,
          at,
        }],
      });
      return true;
    });
  }
}

export function digestPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalize(payload), "utf8").digest("hex");
}

export function canonicalize(value: unknown): string {
  const ancestors = new Set<object>();
  const visit = (item: unknown): string => {
    if (item === null) return "null";
    if (typeof item === "string") return JSON.stringify(item);
    if (typeof item === "boolean") return item ? "true" : "false";
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("Payload numbers must be finite.");
      return Object.is(item, -0) ? "0" : JSON.stringify(item);
    }
    if (typeof item !== "object") throw new TypeError("Payload must contain only JSON-compatible values.");
    if (ancestors.has(item)) throw new TypeError("Payload must not contain circular references.");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return `[${item.map(visit).join(",")}]`;
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Payload objects must be plain JSON objects.");
      }
      const object = item as Record<string, unknown>;
      const keys = Object.keys(object).sort();
      return `{${keys.map((key) => {
        if (object[key] === undefined) throw new TypeError("Payload must not contain undefined values.");
        return `${JSON.stringify(key)}:${visit(object[key])}`;
      }).join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return visit(value);
}

function isConsequentialAction(action: unknown): action is ConsequentialAction {
  return typeof action === "string" && (CONSEQUENT_ACTIONS as readonly string[]).includes(action);
}

const APPROVAL_AUDIT_KINDS: readonly ApprovalAuditKind[] = [
  "decision_recorded",
  "authorization_denied_unknown_action",
  "authorization_denied_missing_approval",
  "authorization_denied_mismatch",
  "authorization_denied_replay",
  "authorization_granted",
  "approval_revoked",
];

function isLedgerState(value: unknown): value is ApprovalLedgerState {
  if (!isPlainRecord(value)) return false;
  const approvals = value["approvals"];
  const events = value["events"];
  if (!Array.isArray(approvals) || !Array.isArray(events)) return false;

  const approvalIds = new Set<string>();
  for (const item of approvals) {
    if (!isPlainRecord(item)) return false;
    const { id, actionType, payloadDigest, outcome, decidedBy, decidedAt, status, scopeId, workflowRevision } = item;
    if (
      !isNonEmptyString(id) ||
      !isConsequentialAction(actionType) ||
      !isPayloadDigest(payloadDigest) ||
      (outcome !== "approved" && outcome !== "denied") ||
      !isNonEmptyString(decidedBy) ||
      !isTimestamp(decidedAt) ||
      (status !== "active" && status !== "consumed" && status !== "revoked") ||
      (scopeId !== undefined && !isNonEmptyString(scopeId)) ||
      (workflowRevision !== undefined && (!Number.isSafeInteger(workflowRevision) || (workflowRevision as number) < 0)) ||
      (outcome === "denied" && status !== "revoked") ||
      approvalIds.has(id)
    ) return false;
    approvalIds.add(id);
  }

  const eventIds = new Set<string>();
  for (const item of events) {
    if (!isPlainRecord(item)) return false;
    const { id, kind, approvalId, actionType, payloadDigest, actor, decisionOutcome, at } = item;
    if (
      !isNonEmptyString(id) ||
      !(APPROVAL_AUDIT_KINDS as readonly unknown[]).includes(kind) ||
      (approvalId !== undefined && !isNonEmptyString(approvalId)) ||
      !isNonEmptyString(actionType) ||
      !isPayloadDigest(payloadDigest) ||
      !isNonEmptyString(actor) ||
      (decisionOutcome !== undefined && decisionOutcome !== "approved" && decisionOutcome !== "denied") ||
      !isTimestamp(at) ||
      eventIds.has(id)
    ) return false;
    if ((kind === "decision_recorded" && (approvalId === undefined || decisionOutcome === undefined)) ||
        ((kind === "authorization_granted" || kind === "approval_revoked") && approvalId === undefined)) return false;
    eventIds.add(id);
  }
  return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPayloadDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
