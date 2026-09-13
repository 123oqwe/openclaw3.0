import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, createParams, outcomeIds } from "../gateway/methods.test-support.js";
import {
  recordOutcomeTelemetry,
  type OutcomeTelemetryMethod,
  type OutcomeTelemetryResult,
} from "./telemetry.js";

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

describe("Outcome Gateway telemetry", () => {
  beforeEach(() => {
    telemetry.counter.add.mockClear();
    telemetry.histogram.record.mockClear();
    telemetry.meter.createCounter.mockClear();
    telemetry.meter.createHistogram.mockClear();
    telemetry.getMeter.mockClear();
  });

  it("records a successful mutation using only low-cardinality labels", async () => {
    const harness = createHarness();
    const id = outcomeIds[0]!;

    expect(await harness.call("outcomes.create", createParams(id, "Private objective"))).toEqual([
      true,
      expect.objectContaining({ outcome: expect.objectContaining({ id }) }),
    ]);

    expect(telemetry.getMeter).toHaveBeenCalledWith("openclaw.outcomes");
    expect(telemetry.counter.add).toHaveBeenCalledWith(1, {
      method: "create",
      result: "success",
    });
    expect(telemetry.histogram.record).toHaveBeenCalledWith(expect.any(Number), {
      method: "create",
      result: "success",
    });
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

    expect(telemetry.counter.add).toHaveBeenCalledWith(1, {
      method: "export",
      result: "success",
    });
    expect(telemetry.histogram.record).toHaveBeenCalledWith(expect.any(Number), {
      method: "export",
      result: "success",
    });
  });

  it("records a denied export without putting the request identity in telemetry", async () => {
    const harness = createHarness();
    const id = outcomeIds[2]!;

    expect(await harness.call("outcomes.export", { id })).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_NOT_FOUND" },
    ]);

    expect(telemetry.counter.add).toHaveBeenCalledWith(1, {
      method: "export",
      result: "deny",
    });
    expect(telemetry.histogram.record).toHaveBeenCalledWith(expect.any(Number), {
      method: "export",
      result: "deny",
    });
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

    expect(telemetry.counter.add).toHaveBeenCalledWith(1, {
      method: "delete",
      result: "success",
    });
    expect(telemetry.histogram.record).toHaveBeenCalledWith(expect.any(Number), {
      method: "delete",
      result: "success",
    });
  });

  it("rejects an unbounded operation label instead of leaking it to telemetry", () => {
    const untrustedMethod: unknown = "Private objective: replace credentials";
    recordOutcomeTelemetry(untrustedMethod as OutcomeTelemetryMethod, "success", Date.now());

    expect(telemetry.getMeter).not.toHaveBeenCalled();
    expect(telemetry.counter.add).not.toHaveBeenCalled();
    expect(telemetry.histogram.record).not.toHaveBeenCalled();
  });

  it("drops invalid runtime results and records finite latency", () => {
    const untrustedResult: unknown = "Private result: credentials";
    recordOutcomeTelemetry("export", untrustedResult as OutcomeTelemetryResult, Date.now());

    expect(telemetry.getMeter).not.toHaveBeenCalled();
    expect(telemetry.counter.add).not.toHaveBeenCalled();
    expect(telemetry.histogram.record).not.toHaveBeenCalled();

    recordOutcomeTelemetry("export", "success", Number.NaN);

    expect(telemetry.histogram.record).toHaveBeenCalledWith(0, {
      method: "export",
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
