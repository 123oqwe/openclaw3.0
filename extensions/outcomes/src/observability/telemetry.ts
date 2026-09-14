import { metrics } from "@opentelemetry/api";

export type OutcomeTelemetryMethod = "create" | "delete" | "export";
export type OutcomeTelemetryResult = "deny" | "failure" | "success";

function isOutcomeTelemetryMethod(value: unknown): value is OutcomeTelemetryMethod {
  return value === "create" || value === "delete" || value === "export";
}

function isOutcomeTelemetryResult(value: unknown): value is OutcomeTelemetryResult {
  return value === "deny" || value === "failure" || value === "success";
}

function telemetryLatencyMs(startedAt: number): number {
  const elapsed = typeof startedAt === "number" ? Date.now() - startedAt : Number.NaN;
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

/** Emits bounded Outcome Gateway telemetry without affecting a request result. */
export function recordOutcomeTelemetry(
  method: OutcomeTelemetryMethod,
  result: OutcomeTelemetryResult,
  startedAt: number,
): void {
  if (!isOutcomeTelemetryMethod(method) || !isOutcomeTelemetryResult(result)) {
    return;
  }
  try {
    const attributes = { method, result };
    const meter = metrics.getMeter("openclaw.outcomes");
    meter.createCounter("openclaw.outcomes.requests").add(1, attributes);
    meter
      .createHistogram("openclaw.outcomes.request.duration_ms", { unit: "ms" })
      .record(telemetryLatencyMs(startedAt), attributes);
  } catch {
    // Observability is best-effort; providers must not change Gateway behavior.
  }
}
