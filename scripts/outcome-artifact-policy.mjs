#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";

const PRIVATE_REPOSITORY = "123oqwe/openclaw-private";
const EXACT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const OUTCOME_LOCK_IMPORTER = "  extensions/outcomes:";
const ALLOWED_PATHS = new Set([
  "docs/.generated/config-baseline.counts.json",
  "docs/.generated/config-baseline.sha256",
  "docs/plugins/plugin-inventory.md",
  "docs/plugins/reference.md",
  "docs/plugins/reference/outcomes.md",
  "extensions/outcomes/api.ts",
  "extensions/outcomes/index.test.ts",
  "extensions/outcomes/index.ts",
  "extensions/outcomes/openclaw.plugin.json",
  "extensions/outcomes/package.json",
  "extensions/outcomes/runtime-api.ts",
  "extensions/outcomes/src/gateway/health.ts",
  "extensions/outcomes/src/runtime-capabilities.test.ts",
  "pnpm-lock.yaml",
  "scripts/outcome-artifact-policy.mjs",
  "src/plugins/contracts/plugin-sdk-runtime-api-guardrails.test.ts",
  "test/scripts/ci-workflow-guards.test.ts",
  "test/scripts/outcome-artifact-policy.test.ts",
]);

export function assertOutcomeArtifactAdmission({ eventName, repository, targetRef, workflowSha }) {
  if (eventName !== "workflow_dispatch") {
    throw new Error("Outcome artifact preparation requires workflow_dispatch");
  }
  if (repository !== PRIVATE_REPOSITORY) {
    throw new Error("Outcome artifact preparation is private-repository only");
  }
  if (!EXACT_SHA_PATTERN.test(targetRef)) {
    throw new Error("Outcome artifact target_ref must be a lowercase 40-character SHA");
  }
  if (targetRef !== workflowSha) {
    throw new Error("Outcome artifact target_ref must equal the workflow SHA");
  }
}

export function assertOutcomeArtifactPaths(paths) {
  const invalid = paths.filter((entry) => !ALLOWED_PATHS.has(entry));
  if (invalid.length > 0) {
    throw new Error(`Outcome artifact changed non-allowlisted paths: ${invalid.join(", ")}`);
  }
}

export function stripOutcomeLockImporter(lockfile) {
  const lines = lockfile.match(/.*(?:\r?\n|$)/gu) ?? [];
  const start = lines.findIndex((line) => line.trimEnd() === OUTCOME_LOCK_IMPORTER);
  if (start === -1) {
    return lockfile;
  }
  let end = start + 1;
  while (end < lines.length && !/^(?: {2}\S|\S)/u.test(lines[end] ?? "")) {
    end += 1;
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("");
}

function readRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function main() {
  const command = process.argv[2];
  if (command === "admission") {
    assertOutcomeArtifactAdmission({
      eventName: readRequiredEnv("GITHUB_EVENT_NAME"),
      repository: readRequiredEnv("GITHUB_REPOSITORY"),
      targetRef: readRequiredEnv("TARGET_REF"),
      workflowSha: readRequiredEnv("GITHUB_WORKFLOW_SHA"),
    });
    return;
  }
  if (command === "paths") {
    const paths = fs.readFileSync(0).toString("utf8").split("\0").filter(Boolean);
    assertOutcomeArtifactPaths(paths);
    return;
  }
  if (command === "strip-lock") {
    process.stdout.write(stripOutcomeLockImporter(fs.readFileSync(0, "utf8")));
    return;
  }
  throw new Error("Usage: outcome-artifact-policy.mjs admission|paths|strip-lock");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
