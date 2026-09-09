import { describe, expect, it } from "vitest";
import {
  assertOutcomeArtifactAdmission,
  assertOutcomeArtifactPaths,
  stripOutcomeLockImporter,
} from "../../scripts/outcome-artifact-policy.mjs";

const TARGET_SHA = "a".repeat(40);

describe("outcome artifact policy", () => {
  it("admits only an exact same-workflow SHA in the private repository", () => {
    expect(() =>
      assertOutcomeArtifactAdmission({
        eventName: "workflow_dispatch",
        repository: "123oqwe/openclaw-private",
        targetRef: TARGET_SHA,
        workflowSha: TARGET_SHA,
      }),
    ).not.toThrow();

    for (const override of [
      { eventName: "pull_request" },
      { repository: "openclaw/openclaw" },
      { targetRef: "main" },
      { targetRef: "A".repeat(40) },
      { workflowSha: "b".repeat(40) },
    ]) {
      expect(() =>
        assertOutcomeArtifactAdmission({
          eventName: "workflow_dispatch",
          repository: "123oqwe/openclaw-private",
          targetRef: TARGET_SHA,
          workflowSha: TARGET_SHA,
          ...override,
        }),
      ).toThrow();
    }
  });

  it("accepts only the fixed P-00 generated-output allowlist", () => {
    expect(() =>
      assertOutcomeArtifactPaths([
        "docs/.generated/config-baseline.sha256",
        "docs/.generated/config-baseline.counts.json",
        "docs/plugins/plugin-inventory.md",
        "docs/plugins/reference.md",
        "docs/plugins/reference/outcomes.md",
        "extensions/outcomes/index.ts",
        "extensions/outcomes/src/gateway/health.ts",
        "pnpm-lock.yaml",
      ]),
    ).not.toThrow();
    expect(() => assertOutcomeArtifactPaths([".env"])).toThrow();
    expect(() => assertOutcomeArtifactPaths(["docs/plugins/reference/discord.md"])).toThrow();
    expect(() => assertOutcomeArtifactPaths(["extensions/outcomes/secret.txt"])).toThrow();
  });

  it("removes only the outcomes importer for lockfile invariant comparison", () => {
    const before = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  extensions/ollama:",
      "    dependencies: {}",
      "  extensions/outcomes:",
      "    devDependencies:",
      "      openclaw:",
      "        specifier: workspace:*",
      "  extensions/qa-lab:",
      "    dependencies: {}",
      "packages:",
      "  example@1.0.0: {}",
      "",
    ].join("\n");
    const changedImporter = before.replace("specifier: workspace:*", "specifier: workspace:^");
    const changedPackage = before.replace("example@1.0.0", "example@2.0.0");

    expect(stripOutcomeLockImporter(changedImporter)).toBe(stripOutcomeLockImporter(before));
    expect(stripOutcomeLockImporter(changedPackage)).not.toBe(stripOutcomeLockImporter(before));
  });
});
