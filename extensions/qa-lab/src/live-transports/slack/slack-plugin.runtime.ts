// QA Lab resolves Slack operations from the owning plugin's isolated dependency scope.
import { loadQaRunnerBundledPluginTestApiAsync } from "openclaw/plugin-sdk/qa-runner-runtime";

type SlackQaRuntime = typeof import("@openclaw/slack/test-api.js");

let cachedSlackQaRuntime: Promise<SlackQaRuntime> | undefined;

export function loadSlackQaRuntime(): Promise<SlackQaRuntime> {
  cachedSlackQaRuntime ??= loadQaRunnerBundledPluginTestApiAsync<SlackQaRuntime>("slack").catch(
    (error: unknown) => {
      cachedSlackQaRuntime = undefined;
      throw error;
    },
  );
  return cachedSlackQaRuntime;
}
