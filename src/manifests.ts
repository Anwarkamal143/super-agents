/**
 * Portable, declarative skill/component manifests.
 *
 * Manifests describe content; they never install, import, or execute it.
 * Treat manifest values and referenced content as untrusted input.
 */

export const MANIFEST_SCHEMA_VERSION = 1 as const;

export type ManifestTrust = "first-party" | "reviewed-third-party" | "untrusted";
export type ManifestValueType = "string" | "number" | "boolean" | "object" | "array";

export interface ManifestField {
  readonly id: string;
  readonly type: ManifestValueType;
  readonly description: string;
  readonly required?: boolean;
}

export interface SkillComponentManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly id: string;
  readonly version: string;
  readonly description: string;
  /** A repository-relative data/content entrypoint; it is not dynamically imported. */
  readonly entrypoint: string;
  readonly requiredCapabilities: readonly string[];
  readonly inputs: readonly ManifestField[];
  readonly outputs: readonly ManifestField[];
  readonly trust: ManifestTrust;
}

export interface ManifestDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly manifestId?: string;
  readonly field?: string;
}

export interface ManifestValidationResult {
  readonly valid: boolean;
  readonly manifest?: SkillComponentManifest;
  readonly diagnostics: readonly ManifestDiagnostic[];
}

export interface ManifestDiscoveryResult {
  readonly compatible: readonly SkillComponentManifest[];
  readonly incompatible: readonly {
    readonly manifest: SkillComponentManifest;
    readonly missingCapabilities: readonly string[];
  }[];
}

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FIELD_TYPES = new Set<ManifestValueType>(["string", "number", "boolean", "object", "array"]);
const TRUST_LEVELS = new Set<ManifestTrust>(["first-party", "reviewed-third-party", "untrusted"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRelativeEntrypoint(value: string): boolean {
  if (!value || value.includes("\\") || value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    && !value.includes("\0");
}

function validateFields(value: unknown, fieldName: "inputs" | "outputs", manifestId: string, diagnostics: ManifestDiagnostic[]): value is readonly ManifestField[] {
  if (!Array.isArray(value)) {
    diagnostics.push({ code: "invalid-fields", message: `${fieldName} must be an array.`, manifestId, field: fieldName });
    return false;
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const field: unknown = value[index];
    if (!isRecord(field)) {
      diagnostics.push({ code: "invalid-field", message: `${fieldName}[${index}] must be an object.`, manifestId, field: fieldName });
      continue;
    }
    const id = field["id"];
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      diagnostics.push({ code: "invalid-field-id", message: `${fieldName}[${index}].id must be a stable lowercase identifier.`, manifestId, field: fieldName });
    } else if (seen.has(id)) {
      diagnostics.push({ code: "duplicate-field-id", message: `Duplicate ${fieldName} field id "${id}".`, manifestId, field: fieldName });
    } else {
      seen.add(id);
    }
    if (typeof field["type"] !== "string" || !FIELD_TYPES.has(field["type"] as ManifestValueType)) {
      diagnostics.push({ code: "invalid-field-type", message: `${fieldName}[${index}].type is unsupported.`, manifestId, field: fieldName });
    }
    if (typeof field["description"] !== "string" || field["description"].trim().length === 0) {
      diagnostics.push({ code: "missing-field-description", message: `${fieldName}[${index}].description must be non-empty.`, manifestId, field: fieldName });
    }
    if (field["required"] !== undefined && typeof field["required"] !== "boolean") {
      diagnostics.push({ code: "invalid-required-flag", message: `${fieldName}[${index}].required must be a boolean when provided.`, manifestId, field: fieldName });
    }
  }
  return true;
}

/** Validate an untrusted JSON value without coercing or executing any field. */
export function validateManifest(value: unknown): ManifestValidationResult {
  const diagnostics: ManifestDiagnostic[] = [];
  if (!isRecord(value)) {
    return { valid: false, diagnostics: [{ code: "invalid-manifest", message: "Manifest must be a JSON object." }] };
  }

  const id = typeof value["id"] === "string" ? value["id"] : undefined;
  if (value["schemaVersion"] !== MANIFEST_SCHEMA_VERSION) {
    diagnostics.push({ code: "unsupported-schema-version", message: `schemaVersion must be ${MANIFEST_SCHEMA_VERSION}.`, manifestId: id });
  }
  if (id === undefined || !ID_PATTERN.test(id)) {
    diagnostics.push({ code: "invalid-id", message: "id must be a stable lowercase identifier (letters, digits, dot, underscore, hyphen).", manifestId: id });
  }
  if (typeof value["version"] !== "string" || !SEMVER_PATTERN.test(value["version"])) {
    diagnostics.push({ code: "invalid-version", message: "version must be a semantic version (for example 1.2.3).", manifestId: id });
  }
  if (typeof value["description"] !== "string" || value["description"].trim().length === 0) {
    diagnostics.push({ code: "missing-description", message: "description must be non-empty.", manifestId: id });
  }
  if (typeof value["entrypoint"] !== "string" || !isSafeRelativeEntrypoint(value["entrypoint"])) {
    diagnostics.push({ code: "unsafe-entrypoint", message: "entrypoint must be a normalized repository-relative path without traversal, absolute paths, or backslashes.", manifestId: id, field: "entrypoint" });
  }
  if (!Array.isArray(value["requiredCapabilities"])
    || value["requiredCapabilities"].some((item) => typeof item !== "string" || !ID_PATTERN.test(item))
    || new Set(value["requiredCapabilities"]).size !== value["requiredCapabilities"].length) {
    diagnostics.push({ code: "invalid-capabilities", message: "requiredCapabilities must contain unique stable capability identifiers.", manifestId: id, field: "requiredCapabilities" });
  }
  if (typeof value["trust"] !== "string" || !TRUST_LEVELS.has(value["trust"] as ManifestTrust)) {
    diagnostics.push({ code: "invalid-trust", message: "trust must be first-party, reviewed-third-party, or untrusted.", manifestId: id, field: "trust" });
  }
  validateFields(value["inputs"], "inputs", id ?? "unknown", diagnostics);
  validateFields(value["outputs"], "outputs", id ?? "unknown", diagnostics);

  if (diagnostics.length > 0) return { valid: false, diagnostics };
  return { valid: true, manifest: value as unknown as SkillComponentManifest, diagnostics };
}

/** Validate manifests and reject duplicate IDs instead of silently choosing one. */
export function validateManifestCollection(values: readonly unknown[]): {
  readonly manifests: readonly SkillComponentManifest[];
  readonly diagnostics: readonly ManifestDiagnostic[];
  readonly valid: boolean;
} {
  const manifests: SkillComponentManifest[] = [];
  const diagnostics: ManifestDiagnostic[] = [];
  const ids = new Set<string>();
  for (const value of values) {
    const result = validateManifest(value);
    diagnostics.push(...result.diagnostics);
    if (!result.valid || !result.manifest) continue;
    if (ids.has(result.manifest.id)) {
      diagnostics.push({
        code: "duplicate-manifest-id",
        message: `Duplicate manifest id "${result.manifest.id}" is not allowed.`,
        manifestId: result.manifest.id,
      });
      continue;
    }
    ids.add(result.manifest.id);
    manifests.push(result.manifest);
  }
  return { manifests, diagnostics, valid: diagnostics.length === 0 };
}

/** Discovery only filters declarative metadata; it never loads an entrypoint. */
export function discoverCompatibleManifests(
  manifests: readonly SkillComponentManifest[],
  availableCapabilities: readonly string[],
): ManifestDiscoveryResult {
  const available = new Set(availableCapabilities);
  const compatible: SkillComponentManifest[] = [];
  const incompatible: Array<{ manifest: SkillComponentManifest; missingCapabilities: readonly string[] }> = [];
  for (const manifest of manifests) {
    const missingCapabilities = manifest.requiredCapabilities.filter((capability) => !available.has(capability));
    if (missingCapabilities.length === 0) compatible.push(manifest);
    else incompatible.push({ manifest, missingCapabilities });
  }
  return { compatible, incompatible };
}

export type ManifestChange = "add" | "modify" | "remove";

export interface ManifestAuditEvent {
  readonly operation: ManifestChange;
  readonly manifestId: string;
  readonly actor: string;
  readonly occurredAt: string;
  readonly previousVersion?: string;
  readonly nextVersion?: string;
}

/**
 * Apply an explicit registry change and return a secret-free audit event.
 * The caller must persist the event and registry durably before claiming success.
 */
export function applyManifestChange(
  current: readonly SkillComponentManifest[],
  change: { readonly operation: "add" | "modify"; readonly manifest: unknown; readonly actor: string; readonly occurredAt: string }
    | { readonly operation: "remove"; readonly manifestId: string; readonly actor: string; readonly occurredAt: string },
): { readonly manifests: readonly SkillComponentManifest[]; readonly event: ManifestAuditEvent } {
  if (!change.actor.trim() || !Number.isFinite(Date.parse(change.occurredAt))) {
    throw new TypeError("A non-empty actor and valid occurredAt timestamp are required for manifest audit.");
  }
  if (change.operation === "remove") {
    if (!ID_PATTERN.test(change.manifestId)) throw new TypeError("Invalid manifest id for removal.");
    const existing = current.find((manifest) => manifest.id === change.manifestId);
    if (!existing) throw new Error(`Cannot remove unknown manifest "${change.manifestId}".`);
    return {
      manifests: current.filter((manifest) => manifest.id !== change.manifestId),
      event: { operation: "remove", manifestId: existing.id, actor: change.actor, occurredAt: change.occurredAt, previousVersion: existing.version },
    };
  }

  const result = validateManifest(change.manifest);
  if (!result.valid || !result.manifest) {
    throw new TypeError(`Invalid manifest: ${result.diagnostics.map((item) => item.message).join(" ")}`);
  }
  const existing = current.find((manifest) => manifest.id === result.manifest?.id);
  if (change.operation === "add" && existing) throw new Error(`Manifest "${result.manifest.id}" already exists; use modify explicitly.`);
  if (change.operation === "modify" && !existing) throw new Error(`Cannot modify unknown manifest "${result.manifest.id}".`);
  const next = change.operation === "add"
    ? [...current, result.manifest]
    : current.map((manifest) => manifest.id === result.manifest?.id ? result.manifest! : manifest);
  return {
    manifests: next,
    event: {
      operation: change.operation,
      manifestId: result.manifest.id,
      actor: change.actor,
      occurredAt: change.occurredAt,
      ...(existing ? { previousVersion: existing.version } : {}),
      nextVersion: result.manifest.version,
    },
  };
}
