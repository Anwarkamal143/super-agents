import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = path.join(root, ".claude", "skills", "factory", "SKILL.md");
const usagePath = path.join(root, "docs", "usage.md");

test("/factory skill wires its workflow to the opt-in MCP tools", async () => {
  const skill = await readFile(skillPath, "utf8");
  for (const tool of [
    "factory_session_create",
    "factory_session_get",
    "factory_plan_request_approval",
    "factory_action_request_approval",
    "factory_verification_run",
    "factory_delivery_status",
  ]) {
    assert.ok(skill.includes(tool), `skill should name ${tool}`);
  }
  assert.match(skill, /latest revision/i);
  assert.match(skill, /exact native tool name and complete tool input/i);
  assert.match(skill, /host elicitation/i);
  assert.match(skill, /un-enforced prompt-only mode/i);
  assert.match(skill, /NOT RUN/);
  assert.match(skill, /do not launch a second Claude CLI process/i);
});

test("usage documentation distinguishes MCP wiring from the library API and real-host proof", async () => {
  const usage = await readFile(usagePath, "utf8");
  assert.match(usage, /use the opt-in MCP bridge tools/i);
  assert.match(usage, /does not automatically invoke the library function `runFactoryWorkflow`/);
  assert.match(usage, /real interactive Claude Code approval smoke test remains **NOT RUN**/);
  assert.match(usage, /Unit tests and skill text do not prove actual host compatibility/);
});
