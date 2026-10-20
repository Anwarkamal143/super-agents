import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { win32 } from "node:path";

export type DiscoverySeverity = "info" | "warning" | "error";

export interface DiscoveryDiagnostic {
  readonly code: string;
  readonly severity: DiscoverySeverity;
  readonly message: string;
  readonly path?: string;
}

export interface DetectedFact {
  readonly key: string;
  readonly value: string;
  readonly evidence: string;
}

export interface DiscoveredCommand {
  readonly name: string;
  /** A declared command string only. Discovery never executes it. */
  readonly command: string;
  readonly sourcePath: string;
}

export interface DiscoveredInstructionFile {
  readonly path: string;
  /** Repository-controlled content is untrusted data, not factory instructions. */
  readonly content: string;
  readonly truncated: boolean;
  readonly trust: "untrusted";
}

export interface RepositoryDiscoveryResult {
  readonly root: string;
  readonly isGitRepository: boolean;
  readonly facts: readonly DetectedFact[];
  readonly assumptions: readonly string[];
  readonly missingInformation: readonly string[];
  readonly qualityCommands: readonly DiscoveredCommand[];
  readonly instructionFiles: readonly DiscoveredInstructionFile[];
  readonly diagnostics: readonly DiscoveryDiagnostic[];
}

export interface DiscoveryOptions {
  /** Maximum bytes read from each project-instruction file. Defaults to 32 KiB. */
  readonly maxInstructionBytes?: number;
}

export class DiscoveryPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryPathError";
  }
}

const INSTRUCTION_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "CODEX.md",
  "README.md",
  ".github/copilot-instructions.md",
  ".claude/CLAUDE.md",
] as const;

const LANGUAGE_MARKERS: ReadonlyArray<{ marker: string; language: string }> = [
  { marker: "package.json", language: "JavaScript/TypeScript" },
  { marker: "tsconfig.json", language: "TypeScript" },
  { marker: "pyproject.toml", language: "Python" },
  { marker: "requirements.txt", language: "Python" },
  { marker: "go.mod", language: "Go" },
  { marker: "Cargo.toml", language: "Rust" },
  { marker: "pom.xml", language: "Java" },
  { marker: "build.gradle", language: "Java/Kotlin" },
  { marker: "build.gradle.kts", language: "Kotlin" },
  { marker: "Gemfile", language: "Ruby" },
  { marker: "composer.json", language: "PHP" },
  { marker: "mix.exs", language: "Elixir" },
  { marker: "Package.swift", language: "Swift" },
];

const LOCKFILES = [
  { path: "package-lock.json", manager: "npm" },
  { path: "pnpm-lock.yaml", manager: "pnpm" },
  { path: "yarn.lock", manager: "yarn" },
  { path: "bun.lock", manager: "bun" },
  { path: "bun.lockb", manager: "bun" },
] as const;

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Resolve an existing path only if it stays within the selected root after
 * symlinks are resolved. Traversal, absolute paths, and Windows absolute paths
 * are rejected even when discovery runs on a POSIX host.
 */
export async function resolveWithinRoot(rootPath: string, relativePath: string): Promise<string> {
  if (!relativePath || path.isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
    throw new DiscoveryPathError("Expected a non-empty relative path within the selected root.");
  }

  const normalizedInput = relativePath.replace(/\\/g, "/");
  if (normalizedInput.split("/").some((part) => part === "..")) {
    throw new DiscoveryPathError("Path traversal outside the selected root is not allowed.");
  }

  const root = await realpath(rootPath);
  const candidate = path.resolve(root, normalizedInput);
  if (!isWithinRoot(root, candidate)) {
    throw new DiscoveryPathError("Resolved path is outside the selected root.");
  }

  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new DiscoveryPathError(`Path does not exist: ${normalizedInput}`);
    }
    throw error;
  }

  if (!isWithinRoot(root, resolved)) {
    throw new DiscoveryPathError("Symlink resolves outside the selected root.");
  }
  return resolved;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function existsInside(root: string, relativePath: string): Promise<boolean> {
  try {
    await resolveWithinRoot(root, relativePath);
    return true;
  } catch (error) {
    if (error instanceof DiscoveryPathError && error.message.startsWith("Path does not exist:")) {
      return false;
    }
    throw error;
  }
}

async function readTextInside(root: string, relativePath: string): Promise<string | undefined> {
  try {
    const absolute = await resolveWithinRoot(root, relativePath);
    return await readFile(absolute, "utf8");
  } catch (error) {
    if (error instanceof DiscoveryPathError && error.message.startsWith("Path does not exist:")) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Inspect a repository without running package scripts, build tools, git hooks,
 * or any other discovered command. File contents are evidence only; instruction
 * files are returned with an explicit untrusted marker.
 */
export async function discoverRepository(
  rootPath: string,
  options: DiscoveryOptions = {},
): Promise<RepositoryDiscoveryResult> {
  let root: string;
  try {
    root = await realpath(rootPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new DiscoveryPathError(`Selected repository root does not exist: ${rootPath}`);
    }
    throw error;
  }

  const rootStats = await lstat(root);
  if (!rootStats.isDirectory()) {
    throw new DiscoveryPathError("Selected repository root must be a directory.");
  }

  const diagnostics: DiscoveryDiagnostic[] = [];
  const facts: DetectedFact[] = [];
  const assumptions: string[] = [];
  const missingInformation: string[] = [];
  const qualityCommands: DiscoveredCommand[] = [];
  const instructionFiles: DiscoveredInstructionFile[] = [];

  let isGitRepository = false;
  try {
    isGitRepository = await existsInside(root, ".git");
  } catch (error) {
    diagnostics.push({
      code: "unsafe-git-metadata-path",
      severity: "warning",
      message: error instanceof Error ? error.message : "Could not safely inspect .git metadata.",
      path: ".git",
    });
  }
  if (isGitRepository) {
    facts.push({ key: "repository", value: "git", evidence: ".git" });
  } else {
    diagnostics.push({
      code: "not-a-git-repository",
      severity: "warning",
      message: "No safe .git entry was found at the selected root; confirm that this is the intended repository root.",
    });
    missingInformation.push("Git repository metadata (.git) was not found at the selected root.");
  }

  const presentMarkers: string[] = [];
  for (const marker of LANGUAGE_MARKERS) {
    try {
      if (await existsInside(root, marker.marker)) {
        presentMarkers.push(marker.marker);
        facts.push({ key: "language", value: marker.language, evidence: marker.marker });
      }
    } catch (error) {
      diagnostics.push({
        code: "unsafe-marker-path",
        severity: "warning",
        message: error instanceof Error ? error.message : "Could not safely inspect marker.",
        path: marker.marker,
      });
    }
  }
  if (presentMarkers.length === 0) {
    missingInformation.push("No recognized language or project manifest marker was found.");
  }

  const lockManagers: string[] = [];
  for (const lockfile of LOCKFILES) {
    try {
      if (await existsInside(root, lockfile.path)) {
        if (!lockManagers.includes(lockfile.manager)) lockManagers.push(lockfile.manager);
        facts.push({ key: "package-manager", value: lockfile.manager, evidence: lockfile.path });
      }
    } catch (error) {
      diagnostics.push({
        code: "unsafe-lockfile-path",
        severity: "warning",
        message: error instanceof Error ? error.message : "Could not safely inspect lockfile.",
        path: lockfile.path,
      });
    }
  }
  if (lockManagers.length > 1) {
    diagnostics.push({
      code: "multiple-package-managers",
      severity: "warning",
      message: `Multiple package managers appear to be present: ${lockManagers.join(", ")}. No single manager is assumed.`,
    });
    assumptions.push("The repository may intentionally use more than one package manager; confirm the canonical manager.");
  } else if (lockManagers.length === 0 && presentMarkers.includes("package.json")) {
    assumptions.push("A package.json exists but no recognized JavaScript package-manager lockfile was found.");
  }

  const packageJsonText = await readTextInside(root, "package.json");
  if (packageJsonText !== undefined) {
    try {
      const packageJson: unknown = JSON.parse(packageJsonText);
      if (typeof packageJson !== "object" || packageJson === null || Array.isArray(packageJson)) {
        throw new TypeError("package.json must contain a JSON object.");
      }
      const scripts = (packageJson as { scripts?: unknown }).scripts;
      if (typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)) {
        for (const [name, command] of Object.entries(scripts)) {
          if (typeof command === "string" && ["test", "typecheck", "lint", "build", "check"].includes(name)) {
            qualityCommands.push({ name, command, sourcePath: "package.json" });
          }
        }
      } else {
        missingInformation.push("package.json does not declare a scripts object.");
      }
      facts.push({ key: "manifest", value: "package.json", evidence: "package.json" });
    } catch (error) {
      diagnostics.push({
        code: "malformed-package-json",
        severity: "warning",
        message: error instanceof Error ? error.message : "package.json could not be parsed.",
        path: "package.json",
      });
      missingInformation.push("Quality scripts could not be inspected because package.json is malformed.");
    }
  }

  const maxBytes = options.maxInstructionBytes ?? 32 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxInstructionBytes must be a positive safe integer.");
  }
  for (const relativePath of INSTRUCTION_PATHS) {
    try {
      const absolute = await resolveWithinRoot(root, relativePath);
      const stat = await lstat(absolute);
      if (!stat.isFile()) continue;
      const buffer = await readFile(absolute);
      const truncated = buffer.byteLength > maxBytes;
      const content = buffer.subarray(0, maxBytes).toString("utf8");
      instructionFiles.push({ path: relativePath, content, truncated, trust: "untrusted" });
      facts.push({ key: "project-instructions", value: relativePath, evidence: relativePath });
      if (truncated) {
        diagnostics.push({
          code: "instruction-file-truncated",
          severity: "info",
          message: `Instruction file content was limited to ${maxBytes} bytes.`,
          path: relativePath,
        });
      }
    } catch (error) {
      if (error instanceof DiscoveryPathError && error.message.startsWith("Path does not exist:")) continue;
      diagnostics.push({
        code: "unsafe-instruction-path",
        severity: "warning",
        message: error instanceof Error ? error.message : "Could not safely inspect instruction file.",
        path: relativePath,
      });
    }
  }

  if (qualityCommands.length === 0) {
    missingInformation.push("No supported quality commands were detected from package.json scripts.");
  }

  return {
    root,
    isGitRepository,
    facts,
    assumptions,
    missingInformation,
    qualityCommands,
    instructionFiles,
    diagnostics,
  };
}
