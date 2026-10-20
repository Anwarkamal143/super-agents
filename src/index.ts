export const FACTORY_NAME = "super-agents" as const;
export const FACTORY_VERSION = "0.1.0" as const;
export const MINIMUM_NODE_MAJOR = 22 as const;

export * from "./domain.js";
export * from "./workflow.js";
export * from "./discovery.js";
export * from "./orchestrator.js";
export * from "./harness.js";
export * from "./claude-code.js";
export * from "./approval.js";
export * from "./verification.js";
export * from "./review.js";
export * from "./manifests.js";
export * from "./board.js";
export * from "./factory-run.js";

export * from "./claude-code-mcp.js";
