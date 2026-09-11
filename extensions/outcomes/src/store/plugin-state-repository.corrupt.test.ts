import { randomUUID } from "node:crypto";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it } from "vitest";
import { OUTCOME_MAX_ENTRIES } from "../domain/constants.js";
import type { OutcomeRecord } from "../domain/types.js";
import { createOutcomeRepository } from "./plugin-state-repository.js";

afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("Outcome repository corruption boundary", () => {
  it("fails closed on corrupt persisted records without mutation or deletion", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-corrupt", applyEnv: false },
      async (state) => {
        const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
          namespace: `outcomes-v1-${randomUUID()}`,
          maxEntries: OUTCOME_MAX_ENTRIES,
          overflowPolicy: "reject-new",
          env: state.env,
        });
        // Deliberately malformed persisted value: unknown version and missing fields.
        const corrupt = {
          id: "corrupt",
          managerProfileId: "alice",
          schemaVersion: 99,
        } as unknown as OutcomeRecord;
        await store.registerIfAbsent(corrupt.id, corrupt);
        const repository = createOutcomeRepository(store);
        await expect(repository.get(corrupt.id)).rejects.toThrow();
        let called = false;
        await expect(
          repository.transact(corrupt.id, () => {
            called = true;
            return { result: "unexpected" };
          }),
        ).rejects.toMatchObject({ code: "PLUGIN_STATE_WRITE_FAILED" });
        expect(called).toBe(false);
        await expect(
          repository.transactOwned("alice", corrupt.id, () => {
            called = true;
            return { result: "unexpected" };
          }),
        ).rejects.toMatchObject({ code: "PLUGIN_STATE_WRITE_FAILED" });
        expect(called).toBe(false);
        await expect(
          repository.deleteIf(corrupt.id, () => {
            called = true;
            return true;
          }),
        ).rejects.toThrow();
        expect(called).toBe(false);
        await expect(store.lookup(corrupt.id)).resolves.toEqual(corrupt);
      },
    );
  });
});
