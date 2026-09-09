import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("Outcome runtime capabilities", () => {
  it("proves atomic update, conditional delete, reject-new, and fresh-process durability", async () => {
    await withOpenClawTestState(
      { label: "outcomes-runtime-capability", applyEnv: false },
      async (state) => {
        const runId = randomUUID();
        const namespace = "outcomes-capability-v1";
        const firstKey = `${runId}:first`;
        const secondKey = `${runId}:second`;
        const rejectedKey = `${runId}:rejected`;
        const options = {
          namespace,
          maxEntries: 2,
          overflowPolicy: "reject-new" as const,
          env: state.env,
        };
        const store = createPluginStateKeyedStoreForTests<{ runId: string; revision: number }>(
          "outcomes",
          options,
        );

        expect(store.update).toBeTypeOf("function");
        expect(store.deleteIf).toBeTypeOf("function");
        await store.register(firstKey, { runId, revision: 0 });
        await store.register(secondKey, { runId, revision: 1 });
        await expect(store.register(rejectedKey, { runId, revision: 1 })).rejects.toMatchObject({
          code: "PLUGIN_STATE_LIMIT_EXCEEDED",
        });
        await expect(store.lookup(rejectedKey)).resolves.toBeUndefined();

        const updateCount = 20;
        await expect(
          Promise.all(
            Array.from({ length: updateCount }, () =>
              store.update?.(firstKey, (current) =>
                current ? { ...current, revision: current.revision + 1 } : undefined,
              ),
            ),
          ),
        ).resolves.toEqual(Array.from({ length: updateCount }, () => true));
        await expect(store.lookup(firstKey)).resolves.toEqual({ runId, revision: updateCount });

        resetPluginStateStoreForTests();
        const child = spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "--eval",
            `
              import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
              const store = createPluginStateKeyedStoreForTests("outcomes", {
                namespace: ${JSON.stringify(namespace)},
                maxEntries: 2,
                overflowPolicy: "reject-new",
              });
              const value = await store.lookup(${JSON.stringify(firstKey)});
              const rejectedDelete = await store.deleteIf?.(
                ${JSON.stringify(firstKey)},
                (current) => current.revision === -1,
              );
              const afterRejectedDelete = await store.lookup(${JSON.stringify(firstKey)});
              const deleted = await store.deleteIf?.(
                ${JSON.stringify(firstKey)},
                (current) => current.runId === ${JSON.stringify(runId)} && current.revision === 20,
              );
              process.stdout.write(JSON.stringify({ value, rejectedDelete, afterRejectedDelete, deleted }));
            `,
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env: { ...process.env, ...state.env },
          },
        );

        expect(child.status, child.stderr).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual({
          value: { runId, revision: updateCount },
          rejectedDelete: false,
          afterRejectedDelete: { runId, revision: updateCount },
          deleted: true,
        });

        const reopened = createPluginStateKeyedStoreForTests<{ runId: string; revision: number }>(
          "outcomes",
          options,
        );
        await expect(reopened.lookup(firstKey)).resolves.toBeUndefined();
        await expect(
          reopened.deleteIf?.(secondKey, (current) => current.runId === runId),
        ).resolves.toBe(true);
      },
    );
  });
});
