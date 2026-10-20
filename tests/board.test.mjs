import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateFactoryBoard } from "../dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const validBoard = () => ({
  schemaVersion: 1,
  factory: {
    id: "factory-test",
    title: "Test run",
    request: "Validate board state.",
    orchestrator: "session-1",
    createdAt: "2026-10-20T00:00:00.000Z",
  },
  status: "awaiting_approval",
  updatedAt: "2026-10-20T00:00:00.000Z",
  tasks: [
    {
      id: "inspect",
      title: "Inspect",
      description: "Inspect repository.",
      status: "ready",
      dependsOn: [],
      acceptanceCriteria: ["Inspect repository guidance."],
      owner: "orchestrator",
      attempts: 0,
      maxAttempts: 2,
      evidence: [],
    },
    {
      id: "implement",
      title: "Implement",
      description: "Only after approval.",
      status: "needs_approval",
      dependsOn: ["inspect"],
      acceptanceCriteria: ["Change is tested."],
      owner: "worker",
      attempts: 0,
      maxAttempts: 2,
      evidence: [],
      approvalRequired: true,
    },
  ],
  decisions: [],
});

test("validates example board and preserves planned work as unstarted", async () => {
  const example = JSON.parse(await readFile(path.join(here, "../factory/board.example.json"), "utf8"));
  const result = validateFactoryBoard(example);
  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.equal(example.status, "awaiting_approval");
  assert.equal(example.tasks.every((task) => task.attempts === 0), true);
  assert.equal(example.decisions.length, 0);
});

test("rejects unknown dependencies and dependency cycles", () => {
  const unknown = validBoard();
  unknown.tasks[1].dependsOn = ["missing"];
  const unknownResult = validateFactoryBoard(unknown);
  assert.equal(unknownResult.valid, false);
  assert.ok(unknownResult.errors.some((error) => error.includes("unknown task missing")));

  const cycle = validBoard();
  cycle.tasks[0].dependsOn = ["implement"];
  const cycleResult = validateFactoryBoard(cycle);
  assert.equal(cycleResult.valid, false);
  assert.ok(cycleResult.errors.some((error) => error.includes("Dependency cycle")));
});

test("rejects duplicate task IDs, unsupported statuses, and invalid attempt bounds", () => {
  const board = validBoard();
  board.tasks[1].id = "inspect";
  board.tasks[1].status = "done";
  board.tasks[1].attempts = 3;
  board.tasks[1].maxAttempts = 2;
  const result = validateFactoryBoard(board);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("Duplicate task id")));
  assert.ok(result.errors.some((error) => error.includes("status is unsupported")));
  assert.ok(result.errors.some((error) => error.includes("cannot exceed maxAttempts")));
});

test("rejects malformed approvals and timestamps", () => {
  const board = validBoard();
  board.decisions.push({
    id: "decision-1",
    scope: "command.execute: exact payload",
    outcome: "approved",
    actor: "human",
    decidedAt: "not-a-date",
  });
  const result = validateFactoryBoard(board);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("decidedAt")));
});

test("board schema declares closed object shapes and explicit task status enum", async () => {
  const schema = JSON.parse(await readFile(path.join(here, "../factory/board.schema.json"), "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties.tasks.items.properties.status.enum.includes("needs_approval"));
  assert.ok(schema.properties.decisions.items.required.includes("scope"));
});
