import { metrics } from "@opentelemetry/api";

export type OutcomeTelemetryMethod = "create" | "delete" | "export";
export type OutcomeTelemetryResult = "deny" | "failure" | "success";

/** Emits bounded Outcome Gateway telemetry without affecting a request result. */
export function recordOutcomeTelemetry(
  method: OutcomeTelemetryMethod,
  result: OutcomeTelemetryResult,
  startedAt: number,
): void {
  try {
    const attributes = { method, result };
    const meter = metrics.getMeter("openclaw.outcomes");
    meter.createCounter("openclaw.outcomes.requests").add(1, attributes);
    meter
      .createHistogram("openclaw.outcomes.request.duration_ms", { unit: "ms" })
      .record(Math.max(0, Date.now() - startedAt), attributes);
  } catch {
    // Observability is best-effort; providers must not change Gateway behavior.
  }
}
