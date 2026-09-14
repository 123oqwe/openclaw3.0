import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, createParams, outcomeIds } from "../gateway/methods.test-support.js";
import { recordOutcomeTelemetry } from "./telemetry.js";

const telemetry = vi.hoisted(() => {
  const counter = { add: vi.fn() };
  const histogram = { record: vi.fn() };
  const meter = {
    createCounter: vi.fn(() => counter),
    createHistogram: vi.fn(() => histogram),
  };
  const getMeter = vi.fn(() => meter);
  return { counter, getMeter, histogram, meter };
});

vi.mock("@opentelemetry/api", () => ({
  metrics: { getMeter: telemetry.getMeter },
}));

function recordUntrustedTelemetry(method: string, result: string, startedAt: number): void {
  Reflect.apply(recordOutcomeTelemetry, undefined, [method, result, startedAt]);
}

function expectTelemetryCalls(
  method: "create" | "delete" | "export",
  result: "deny" | "failure" | "success",
): void {
  expect(telemetry.counter.add.mock.calls).toEqual([[1, { method, result }]]);
  expect(telemetry.histogram.record.mock.calls).toEqual([
    [expect.any(Number), { method, result }],
  ]);
}

describe("Outcome Gateway telemetry", () => {
  beforeEach(() => {
    telemetry.counter.add.mockReset();
    telemetry.histogram.record.mockReset();
    telemetry.meter.createCounter.mockReset().mockReturnValue(telemetry.counter);
    telemetry.meter.createHistogram.mockReset().mockReturnValue(telemetry.histogram);
    telemetry.getMeter.mockReset().mockReturnValue(telemetry.meter);
  });

  it("records a successful mutation using only low-cardinality labels", async () => {
    const harness = createHarness();
    const id = outcomeIds[0]!;

    expect(await harness.call("outcomes.create", createParams(id, "Private objective"))).toEqual([
      true,
      expect.objectContaining({ outcome: expect.objectContaining({ id }) }),
    ]);

    expect(telemetry.getMeter).toHaveBeenCalledWith("openclaw.outcomes");
    expectTelemetryCalls("create", "success");
  });

  it("records a successful lossless export without exporting record content to telemetry", async () => {
    const harness = createHarness();
    const id = outcomeIds[2]!;

    expect(await harness.call("outcomes.create", createParams(id, "Private objective"))).toEqual([
      true,
      expect.objectContaining({ outcome: expect.objectContaining({ id }) }),
    ]);
    telemetry.counter.add.mockClear();
    telemetry.histogram.record.mockClear();

    expect(await harness.call("outcomes.export", { id })).toEqual([
      true,
      expect.objectContaining({ schemaVersion: 1, record: expect.objectContaining({ id }) }),
    ]);

    expectTelemetryCalls("export", "success");
  });

  it("records a denied export without putting the request identity in telemetry", async () => {
    const harness = createHarness();
    const id = outcomeIds[2]!;

    expect(await harness.call("outcomes.export", { id })).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_NOT_FOUND" },
    ]);

    expectTelemetryCalls("export", "deny");
  });

  it("records a successful confirmed delete without including its Outcome identity", async () => {
    const harness = createHarness();
    const id = outcomeIds[1]!;

    expect(await harness.call("outcomes.create", createParams(id, "Private objective"))).toEqual([
      true,
      expect.objectContaining({ outcome: expect.objectContaining({ id }) }),
    ]);
    telemetry.counter.add.mockClear();
    telemetry.histogram.record.mockClear();

    expect(await harness.call("outcomes.delete", { id, expectedRevision: 1 })).toEqual([
      true,
      { deleted: true, id },
    ]);

    expectTelemetryCalls("delete", "success");
  });

  it("rejects an unbounded operation label instead of leaking it to telemetry", () => {
    recordUntrustedTelemetry("Private objective: replace credentials", "success", Date.now());

    expect(telemetry.getMeter).not.toHaveBeenCalled();
    expect(telemetry.counter.add).not.toHaveBeenCalled();
    expect(telemetry.histogram.record).not.toHaveBeenCalled();
  });

  it("drops invalid runtime results", () => {
    recordUntrustedTelemetry("export", "Private result: credentials", Date.now());

    expect(telemetry.getMeter).not.toHaveBeenCalled();
    expect(telemetry.counter.add).not.toHaveBeenCalled();
    expect(telemetry.histogram.record).not.toHaveBeenCalled();
  });

  it("records finite latency when the start time is invalid", () => {
    recordOutcomeTelemetry("export", "success", Number.NaN);

    expect(telemetry.histogram.record).toHaveBeenCalledWith(0, {
      method: "export",
      result: "success",
    });
  });

  it.each([
    [
      "meter lookup",
      () =>
        telemetry.getMeter.mockImplementationOnce(() => {
          throw new Error("provider unavailable");
        }),
    ],
    [
      "counter creation",
      () =>
        telemetry.meter.createCounter.mockImplementationOnce(() => {
          throw new Error("counter unavailable");
        }),
    ],
    [
      "counter write",
      () =>
        telemetry.counter.add.mockImplementationOnce(() => {
          throw new Error("counter unavailable");
        }),
    ],
    [
      "histogram creation",
      () =>
        telemetry.meter.createHistogram.mockImplementationOnce(() => {
          throw new Error("histogram unavailable");
        }),
    ],
    [
      "histogram write",
      () =>
        telemetry.histogram.record.mockImplementationOnce(() => {
          throw new Error("histogram unavailable");
        }),
    ],
  ])("does not throw when %s fails", (_name, makeTelemetryFail) => {
    makeTelemetryFail();

    expect(() => recordOutcomeTelemetry("export", "failure", Date.now())).not.toThrow();
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
