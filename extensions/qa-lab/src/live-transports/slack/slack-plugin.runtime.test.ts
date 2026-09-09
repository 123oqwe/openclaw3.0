// QA Lab tests cover the Slack plugin runtime facade.
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadQaRunnerBundledPluginTestApiAsync = vi.hoisted(() => vi.fn());
const loadQaRunnerBundledPluginTestApi = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/qa-runner-runtime", () => ({
  loadQaRunnerBundledPluginTestApi,
  loadQaRunnerBundledPluginTestApiAsync,
}));

describe("Slack plugin runtime facade", () => {
  beforeEach(() => {
    vi.resetModules();
    loadQaRunnerBundledPluginTestApi.mockReset();
    loadQaRunnerBundledPluginTestApiAsync.mockReset();
  });

  it("loads the Slack test API asynchronously once and shares the pending runtime", async () => {
    const slackQaRuntime = {
      createSlackWebClient: vi.fn(),
      createSlackWriteClient: vi.fn(),
      listSlackReactions: vi.fn(),
      resolveSlackWebClientOptions: vi.fn(),
      sendSlackMessage: vi.fn(),
    };
    loadQaRunnerBundledPluginTestApi.mockReturnValue(slackQaRuntime);
    loadQaRunnerBundledPluginTestApiAsync.mockResolvedValue(slackQaRuntime);

    const { loadSlackQaRuntime } = await import("./slack-plugin.runtime.js");
    const firstLoad = loadSlackQaRuntime();
    const secondLoad = loadSlackQaRuntime();

    expect(firstLoad).toBe(secondLoad);
    await expect(firstLoad).resolves.toBe(slackQaRuntime);
    expect(loadQaRunnerBundledPluginTestApiAsync).toHaveBeenCalledExactlyOnceWith("slack");
  });

  it("retries the asynchronous Slack test API load after a failure", async () => {
    const slackQaRuntime = { sendSlackMessage: vi.fn() };
    loadQaRunnerBundledPluginTestApiAsync
      .mockRejectedValueOnce(new Error("transient load failure"))
      .mockResolvedValueOnce(slackQaRuntime);

    const { loadSlackQaRuntime } = await import("./slack-plugin.runtime.js");

    await expect(loadSlackQaRuntime()).rejects.toThrow("transient load failure");
    await expect(loadSlackQaRuntime()).resolves.toBe(slackQaRuntime);
    expect(loadQaRunnerBundledPluginTestApiAsync).toHaveBeenCalledTimes(2);
  });
});
