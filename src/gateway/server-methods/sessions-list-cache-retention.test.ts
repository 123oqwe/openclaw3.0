import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { sessionListCacheRetentionEntrypoint } from "./sessions-list-cache-retention-entrypoint.test-support.js";

it("releases retired pages while their generation still has a pending caller", async ({
  signal,
}) => {
  const result = await runNodeScript(
    [
      "--expose-gc",
      ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(sessionListCacheRetentionEntrypoint)),
    ],
    { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1" },
    30_000,
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      signal,
      maxBuffer: 64 * 1024,
      requireProcessTreeExit: process.platform !== "win32",
      onReady: (child) => {
        // Forward bounded phase markers while the child is alive so a hosted
        // outer timeout still leaves actionable progress evidence.
        process.stderr.write("[sessions-list-cache-retention] parent:child-ready\n");
        let carry = "";
        let forwarded = 0;
        child.stderr?.on("data", (chunk: Buffer) => {
          carry += chunk.toString("utf8");
          const lines = carry.split("\n");
          carry = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("[sessions-list-cache-retention]") && forwarded < 64) {
              process.stderr.write(`${line}\n`);
              forwarded += 1;
            }
          }
        });
        child.stderr?.on("end", () => {
          if (carry.startsWith("[sessions-list-cache-retention]") && forwarded < 64) {
            process.stderr.write(`${carry}\n`);
          }
        });
      },
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    fence: { whileRefreshing: [], afterActiveResult: [] },
    config: { whileRefreshing: [], afterActiveResult: [] },
    catalog: { whileRefreshing: [], afterActiveResult: [] },
    expiry: { whileRefreshing: [], afterActiveResult: [] },
  });
}, 45_000);
