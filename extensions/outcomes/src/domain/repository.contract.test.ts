import { describe, expect, it } from "vitest";
import { createOutcomeRepository } from "../store/plugin-state-repository.js";
import type { OutcomeRecord } from "../store/outcome-repository.js";
import { reduceOutcomeTitle } from "./reducer.js";

// P-01 contract cases are intentionally staged before the domain repository
// exists. They name the required observable behavior without treating a
// missing production module as a RED result.
describe("Outcome repository atomic contract", () => {
  function fixture() {
    const records = new Map<string, OutcomeRecord>();
    let writes = 0;
    const repository = createOutcomeRepository({
      registerIfAbsent: async (id, value) => {
        if (records.has(id)) {
          return false;
        }
        records.set(id, value);
        writes += 1;
        return true;
      },
      lookup: async (id) => records.get(id),
    });
    return { repository, records, writes: () => writes };
  }

  it("creates once and reads the persisted record", async () => {
    const { repository, writes } = fixture();
    const record = { id: "o-1", revision: 1 };
    await expect(repository.create(record)).resolves.toEqual({ created: true });
    await expect(repository.get(record.id)).resolves.toEqual(record);
    expect(writes()).toBe(1);
  });

  it("rejects a duplicate create without a second write", async () => {
    const { repository, writes } = fixture();
    const record = { id: "o-1", revision: 1 };
    await repository.create(record);
    await expect(repository.create(record)).resolves.toEqual({ created: false });
    expect(writes()).toBe(1);
  });

  it("replays before checking an obsolete revision", () => {
    const record = { id: "o-1", revision: 2, title: "old", lastRequestHash: "r-1" };
    expect(reduceOutcomeTitle(record, { requestHash: "r-1", expectedRevision: 1, title: "new" })).toEqual({
      kind: "replay",
      record,
    });
  });

  it("returns no-op without incrementing revision for unchanged title", () => {
    const record = { id: "o-1", revision: 2, title: "same" };
    expect(reduceOutcomeTitle(record, { requestHash: "r-2", expectedRevision: 2, title: "same" })).toEqual({
      kind: "noop",
      record,
    });
  });

  it.todo("replays an idempotent mutation before checking expected revision");
  it.todo("commits the same mutation once when concurrent callers race");
  it.todo("returns a typed rejection without writing the record");
  it.todo("returns unchanged state without incrementing revision or writing");
});
