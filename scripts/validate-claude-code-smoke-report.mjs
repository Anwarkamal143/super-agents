#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_CHECKS = 9;
const VALID_STATUSES = new Set(["PASS", "FAIL", "BLOCKED", "NOT RUN"]);

async function main() {
  const reportPath = process.argv[2];
  if (!reportPath) {
    process.stderr.write("Usage: node scripts/validate-claude-code-smoke-report.mjs <completed-report.md>\n");
    process.exitCode = 2;
    return;
  }

  let report;
  try {
    report = await readFile(path.resolve(process.cwd(), reportPath), "utf8");
  } catch (error) {
    process.stderr.write(`Cannot read smoke report "${reportPath}": ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 2;
    return;
  }

  const errors = validateReport(report);
  if (errors.length) {
    process.stderr.write(`Smoke report validation failed (${errors.length} issue${errors.length === 1 ? "" : "s"}):\n`);
    for (const error of errors) process.stderr.write(`- ${error}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Smoke report structure is complete: ${REQUIRED_CHECKS} checks and overall assessment are consistent. This validates report completeness only; it does not authenticate observations.\n`);
}

function validateReport(report) {
  const errors = [];
  const lines = report.split(/\r?\n/);
  const headings = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^###\s+(\d+)\.\s+(.+?)\s*$/.exec(lines[index]);
    if (match) headings.push({ number: Number(match[1]), title: match[2], index });
  }

  if (headings.length !== REQUIRED_CHECKS) {
    errors.push(`Expected exactly ${REQUIRED_CHECKS} numbered check sections; found ${headings.length}.`);
  }

  for (let index = 0; index < REQUIRED_CHECKS; index += 1) {
    const expectedNumber = index + 1;
    const heading = headings[index];
    if (!heading || heading.number !== expectedNumber) {
      errors.push(`Check ${expectedNumber}: missing or out-of-order "### ${expectedNumber}." section.`);
      continue;
    }

    const nextHeading = headings[index + 1];
    const finalAssessmentIndex = lines.findIndex((line, lineIndex) => lineIndex > heading.index && /^##\s+Final assessment\s*$/.test(line));
    const endIndex = nextHeading?.index ?? (finalAssessmentIndex === -1 ? lines.length : finalAssessmentIndex);
    const sectionLines = lines.slice(heading.index + 1, endIndex);
    const prefix = `Check ${expectedNumber} (${heading.title}) at line ${heading.index + 1}:`;
    const statusLines = sectionLines
      .map((line, offset) => ({ line, lineNumber: heading.index + offset + 2 }))
      .filter(({ line }) => /^- Status:/.test(line));

    if (statusLines.length !== 1) {
      errors.push(`${prefix} expected exactly one "- Status: **PASS|FAIL|BLOCKED|NOT RUN**" field.`);
      continue;
    }

    const statusMatch = /^- Status:\s+\*\*(PASS|FAIL|BLOCKED|NOT RUN)\*\*\s*$/.exec(statusLines[0].line);
    if (!statusMatch || !VALID_STATUSES.has(statusMatch[1])) {
      errors.push(`${prefix} invalid status at line ${statusLines[0].lineNumber}; use PASS, FAIL, BLOCKED, or NOT RUN.`);
      continue;
    }

    const observed = findField(sectionLines, /^- Observed:\s*(.*)$/);
    if (!observed || isPlaceholder(observed.value)) {
      errors.push(`${prefix} add a concrete observation after "- Observed:"; do not leave it blank or as a placeholder.`);
    }

    const evidence = findField(sectionLines, /^- Evidence(?:\s+\([^)]*\))?:\s*(.*)$/);
    if (!evidence || isPlaceholder(evidence.value)) {
      errors.push(`${prefix} add an evidence link/reference after "- Evidence:"; do not leave it blank or as a placeholder.`);
    }
  }

  const overallLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^- Overall:/.test(line));
  if (overallLines.length !== 1) {
    errors.push('Final assessment: expected exactly one "- Overall: **STATUS**" field.');
    return errors;
  }

  const overallMatch = /^- Overall:\s+\*\*(PASS|FAIL|BLOCKED|NOT RUN)\*\*\s*$/.exec(overallLines[0].line);
  if (!overallMatch) {
    errors.push(`Final assessment at line ${overallLines[0].index + 1}: invalid overall status; use PASS, FAIL, BLOCKED, or NOT RUN.`);
    return errors;
  }

  if (overallMatch[1] === "PASS") {
    const checkStatuses = headings.map((heading, index) => {
      const endIndex = headings[index + 1]?.index ?? overallLines[0].index;
      const statusLine = lines.slice(heading.index + 1, endIndex).find((line) => /^- Status:/.test(line));
      return statusLine && /^- Status:\s+\*\*(PASS|FAIL|BLOCKED|NOT RUN)\*\*\s*$/.exec(statusLine)?.[1];
    });
    if (checkStatuses.length !== REQUIRED_CHECKS || checkStatuses.some((status) => status !== "PASS")) {
      errors.push(`Final assessment at line ${overallLines[0].index + 1}: overall PASS requires all ${REQUIRED_CHECKS} checks to be PASS.`);
    }
  }

  return errors;
}

function findField(lines, pattern) {
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) return { value: match[1].trim() };
  }
  return undefined;
}

function isPlaceholder(value) {
  if (!value) return true;
  return /^(?:[-–—]|<[^>]+>|\[[^\]]+\]|todo\b.*|tbd\b.*|not run\b.*|not yet\b.*|fill(?: in)?\b.*|placeholder\b.*)$/i.test(value.trim());
}

export { validateReport };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
