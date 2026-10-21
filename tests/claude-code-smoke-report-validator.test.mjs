import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validator = path.join(root, "scripts", "validate-claude-code-smoke-report.mjs");
const templatePath = path.join(root, "docs", "claude-code-smoke-report-template.md");

async function reportFile(content) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "factory-smoke-report-"));
  const reportPath = path.join(directory, "report.md");
  await writeFile(reportPath, content, "utf8");
  return { reportPath, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function run(reportPath) {
  return spawnSync(process.execPath, [validator, reportPath], { encoding: "utf8" });
}

async function completedReport({ status = "PASS", overall = "PASS", missingEvidenceFor = -1 } = {}) {
  const template = await readFile(templatePath, "utf8");
  const sections = template.split(/(?=^### \d+\. )/m);
  let result = sections.map((section) => {
    const heading = /^### (\d+)\. /m.exec(section);
    if (!heading) return section;
    const number = Number(heading[1]);
    return section
      .replace(/^- Status: \*\*NOT RUN\*\*$/m, `- Status: **${status}**`)
      .replace(/^- Observed:.*$/m, "- Observed: The expected behavior was observed during this check.")
      .replace(/^- Evidence(?: \([^)]*\))?:.*$/m, missingEvidenceFor === number
        ? "- Evidence:"
        : `- Evidence: https://example.test/evidence/check-${number}`);
  }).join("");
  result = result.replace(/^- Overall: \*\*NOT RUN\*\*$/m, `- Overall: **${overall}**`);
  return result;
}

test("rejects the untouched template as completed evidence", async () => {
  const file = await reportFile(await readFile(templatePath, "utf8"));
  try {
    const result = run(file.reportPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /validation failed/i);
    assert.match(result.stderr, /Check 1/);
  } finally {
    await file.cleanup();
  }
});

test("accepts a complete report with evidence for all nine passing checks", async () => {
  const file = await reportFile(await completedReport());
  try {
    const result = run(file.reportPath);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /9 checks and overall assessment are consistent/);
    assert.match(result.stdout, /does not authenticate observations/);
  } finally {
    await file.cleanup();
  }
});

test("rejects a missing evidence reference", async () => {
  const file = await reportFile(await completedReport({ missingEvidenceFor: 4 }));
  try {
    const result = run(file.reportPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Check 4 .*add an evidence link\/reference/);
  } finally {
    await file.cleanup();
  }
});

test("rejects an unknown status", async () => {
  const report = (await completedReport()).replace("- Status: **PASS**", "- Status: **MAYBE**");
  const file = await reportFile(report);
  try {
    const result = run(file.reportPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid status/);
  } finally {
    await file.cleanup();
  }
});

test("rejects overall PASS when any check is not PASS", async () => {
  const report = (await completedReport()).replace("- Status: **PASS**", "- Status: **BLOCKED**");
  const file = await reportFile(report);
  try {
    const result = run(file.reportPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /overall PASS requires all 9 checks to be PASS/);
  } finally {
    await file.cleanup();
  }
});

test("reports missing arguments and unreadable report paths without throwing", () => {
  const missingArgument = spawnSync(process.execPath, [validator], { encoding: "utf8" });
  assert.equal(missingArgument.status, 2);
  assert.match(missingArgument.stderr, /Usage:/);

  const unreadable = run(path.join(os.tmpdir(), "missing-smoke-report.md"));
  assert.equal(unreadable.status, 2);
  assert.match(unreadable.stderr, /Cannot read smoke report/);
});
