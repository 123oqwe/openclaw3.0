import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const telemetryUrl = pathToFileURL(
  path.resolve("extensions/outcomes/src/observability/telemetry.ts"),
).href;

describe("Outcome Gateway telemetry without a provider", () => {
  it("is a no-op with the real OpenTelemetry API and no registered provider", () => {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "--eval",
        `
          import { metrics } from "@opentelemetry/api";
          import { recordOutcomeTelemetry } from ${JSON.stringify(telemetryUrl)};
          if (metrics.getMeterProvider().constructor.name !== "NoopMeterProvider") {
            throw new Error("expected a fresh process without a registered meter provider");
          }
          recordOutcomeTelemetry("export", "success", Date.now());
        `,
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
    );

    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(0);
  });
});
