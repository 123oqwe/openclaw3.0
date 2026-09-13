import { metrics } from "@opentelemetry/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, createParams, outcomeIds } from "../gateway/methods.test-support.js";

const telemetry = vi.hoisted(() => {
  const counter = { add: vi.fn() };
  const histogram = { record: vi.fn() };
  const meter = {
    createCounter: vi.fn(() => counter),
    createHistogram: vi.fn(() => histogram),
  };
  return { counter, histogram, meter };
});

vi.mock("@opentelemetry/api", () => ({
  metrics: { getMeter: vi.fn(() => telemetry.meter) },
}));

describe("Outcome Gateway telemetry", () => {
  beforeEach(() => {
    telemetry.counter.add.mockClear();
    telemetry.histogram.record.mockClear();
    telemetry.meter.createCounter.mockClear();
    telemetry.meter.createHistogram.mockClear();
    vi.mocked(metrics.getMeter).mockClear();
  });

  it("records a successful mutation using only low-cardinality labels", async () => {
    const harness = createHarness();
    const id = outcomeIds[0]!;

    expect(await harness.call("outcomes.create", createParams(id, "Private objective"))).toEqual([
      true,
      expect.objectContaining({ outcome: expect.objectContaining({ id }) }),
    ]);

    expect(metrics.getMeter).toHaveBeenCalledWith("openclaw.outcomes");
    expect(telemetry.counter.add).toHaveBeenCalledWith(1, {
      method: "create",
      result: "success",
    });
    expect(telemetry.histogram.record).toHaveBeenCalledWith(expect.any(Number), {
      method: "create",
      result: "success",
    });
  });

  it("preserves the Gateway response when the telemetry provider throws", async () => {
    telemetry.counter.add.mockImplementation(() => {
      throw new Error("exporter unavailable");
    });
    const harness = createHarness();
    const id = outcomeIds[1]!;

    expect(await harness.call("outcomes.create", createParams(id))).toEqual([
      true,
      expect.objectContaining({ outcome: expect.objectContaining({ id }) }),
    ]);
  });
});
