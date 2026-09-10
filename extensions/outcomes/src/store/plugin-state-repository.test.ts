import { randomUUID } from "node:crypto";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it } from "vitest";
import { reduceOutcomeTitle, type OutcomeMutationResult } from "../domain/reducer.js";
import type { OutcomeRecord } from "../domain/types.js";
import { createOutcomeRepository } from "./plugin-state-repository.js";

afterEach(() => resetPluginStateStoreForTests());

describe("Outcome repository host adapter", () => {
  it("serializes concurrent CAS and persists only the winning title", async () => {
    await withOpenClawTestState({ label: "outcome-repository-cas", applyEnv: false }, async (state) => {
      const namespace = `outcomes-v1-${randomUUID()}`;
      const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
        namespace,
        maxEntries: 500,
        overflowPolicy: "reject-new",
        env: state.env,
      });
      const updates: unknown[] = [];
      const repository = createOutcomeRepository({
        ...store,
        update: async (id, callback) => store.update!(id, (current) => {
          const next = callback(current);
          updates.push(next);
          return next;
        }),
      });
      const initial = { id: "o-1", revision: 2, title: "old", phase: "active" as const, planGeneration: 1 };
      await expect(repository.create(initial)).resolves.toEqual({ created: true });
      const mutate = (title: string) => repository.transact<OutcomeMutationResult>(initial.id, (current) => {
        const decision = reduceOutcomeTitle(current!, { expectedRevision: 2, title });
        return decision.kind === "updated" ? { result: decision, next: decision.record } : { result: decision };
      });
      const results = await Promise.all([mutate("left"), mutate("right")]);
      expect(results.map((result) => result.kind).toSorted()).toEqual(["conflict", "updated"]);
      const winner = results.find((result) => result.kind === "updated");
      expect(winner?.kind).toBe("updated");
      await expect(repository.get(initial.id)).resolves.toEqual(winner?.record);
      expect(updates.filter((next) => next !== undefined)).toHaveLength(1);
      expect(winner?.record.phase).toBe("active");
      expect(winner?.record.planGeneration).toBe(1);
    });
  });

  it("keeps cancelled records unchanged for rejected and no-op decisions", async () => {
    await withOpenClawTestState({ label: "outcome-repository-zero-write", applyEnv: false }, async (state) => {
      const namespace = `outcomes-v1-${randomUUID()}`;
      const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
        namespace,
        maxEntries: 500,
        overflowPolicy: "reject-new",
        env: state.env,
      });
      const updates: unknown[] = [];
      const repository = createOutcomeRepository({
        ...store,
        update: async (id, callback) => store.update!(id, (current) => {
          const next = callback(current);
          updates.push(next);
          return next;
        }),
      });
      const record = { id: "o-1", revision: 2, title: "same", phase: "cancelled" as const, planGeneration: 1 };
      await repository.create(record);
      const result = await repository.transact<OutcomeMutationResult>(record.id, (current) => {
        const decision = reduceOutcomeTitle(current!, { expectedRevision: 2, title: "same" });
        return decision.kind === "updated" ? { result: decision, next: decision.record } : { result: decision };
      });
      expect(result.kind).toBe("rejected");
      await expect(repository.get(record.id)).resolves.toEqual(record);
      expect(updates).toEqual([undefined]);

      const active = { ...record, id: "o-2", phase: "active" as const, title: "same" };
      await repository.create(active);
      const noop = await repository.transact<OutcomeMutationResult>(active.id, (current) => {
        const decision = reduceOutcomeTitle(current!, { expectedRevision: 2, title: "same" });
        return decision.kind === "updated" ? { result: decision, next: decision.record } : { result: decision };
      });
      expect(noop.kind).toBe("noop");
      expect(updates).toEqual([undefined, undefined]);
      await expect(repository.get(active.id)).resolves.toEqual(active);

      resetPluginStateStoreForTests();
      const reopened = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
        namespace,
        maxEntries: 500,
        overflowPolicy: "reject-new",
        env: state.env,
      });
      await expect(reopened.lookup(record.id)).resolves.toBeUndefined();
    });
  });
});
