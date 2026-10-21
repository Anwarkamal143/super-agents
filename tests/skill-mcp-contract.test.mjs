import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = path.join(root, ".claude", "skills", "factory", "SKILL.md");
const usagePath = path.join(root, "docs", "usage.md");
const mcpPath = path.join(root, "src", "claude-code-mcp.ts");

test("/factory skill wires its workflow to the opt-in MCP tools", async () => {
  const skill = await readFile(skillPath, "utf8");
  for (const tool of [
    "factory_session_create",
    "factory_session_get",
    "factory_plan_request_approval",
    "factory_action_request_approval",
    "factory_verification_run",
    "factory_review_run",
    "factory_delivery_status",
  ]) {
    assert.ok(skill.includes(tool), `skill should name ${tool}`);
  }
  assert.match(skill, /latest revision/i);
  assert.match(skill, /exact native tool name and complete tool input/i);
  assert.match(skill, /host elicitation/i);
  assert.match(skill, /review_engine.*evidence/i);
  assert.match(skill, /provider is unavailable/i);
  assert.match(skill, /model-led Standards and Spec reviews/i);
  assert.match(skill, /un-enforced prompt-only mode/i);
  assert.match(skill, /NOT RUN/);
  assert.match(skill, /do not launch a second Claude CLI process/i);
});

test("usage documentation distinguishes MCP wiring from the library API and real-host proof", async () => {
  const usage = await readFile(usagePath, "utf8");
  assert.match(usage, /use the opt-in MCP bridge tools/i);
  assert.match(usage, /does not automatically invoke the library function `runFactoryWorkflow`/);
  assert.ok(usage.includes("real interactive Claude Code approval smoke test remains **NOT RUN**"));
  assert.match(usage, /Unit tests and skill text do not prove actual host compatibility/);
});


test("/factory skill names only real bridge tools and documents trusted-review capability boundaries", async () => {
  const skill = await readFile(skillPath, "utf8");
  const source = await readFile(mcpPath, "utf8");
  const listedToolNames = [...source.matchAll(/name: "(factory_[a-z_]+)"/g)].map((match) => match[1]);
  const skillToolNames = [...skill.matchAll(/`(factory_[a-z_]+)`/g)].map((match) => match[1]);
  assert.ok(listedToolNames.includes("factory_review_run"));
  assert.ok(skillToolNames.includes("factory_review_run"));
  for (const name of skillToolNames) {
    assert.ok(listedToolNames.includes(name), `skill references MCP tool not advertised by server source: ${name}`);
  }
  assert.match(source, /UNAVAILABLE: no trusted review provider is configured/i);
  assert.match(source, /model-authored review cannot substitute for review_engine evidence/i);
});
