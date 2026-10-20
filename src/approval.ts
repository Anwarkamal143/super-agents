import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

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
}

export interface ApprovalRecord {
  readonly id: string;
  readonly actionType: ConsequentialAction;
  readonly payloadDigest: string;
  readonly outcome: PolicyDecisionOutcome;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly status: ApprovalStatus;
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
}

export class JsonFileApprovalStore implements ApprovalStore {
  constructor(private readonly filePath: string) {}

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
 * The policy is default-deny; its JSON store supports a single writer only.
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
    const result = this.tail.then(operation, operation);
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

function isConsequentialAction(action: string): action is ConsequentialAction {
  return (CONSEQUENT_ACTIONS as readonly string[]).includes(action);
}

function isLedgerState(value: unknown): value is ApprovalLedgerState {
  if (!value || typeof value !== "object") return false;
  const state = value as { approvals?: unknown; events?: unknown };
  return Array.isArray(state.approvals) && Array.isArray(state.events);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
