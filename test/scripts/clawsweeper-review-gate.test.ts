import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const helper = join(process.cwd(), "scripts/pr-lib/clawsweeper-review-gate.mjs");
const head = "a".repeat(40);
const ago = (milliseconds: number) => new Date(Date.now() - milliseconds).toISOString();
const trustedBotEnvironmentKeys = [
  "OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_ID",
  "OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_LOGIN",
] as const;

function reviewComment({
  id = 1,
  reviewedAt = ago(60 * 60_000),
  sha = head,
  sourceRevision = "b".repeat(64),
  leaseOwner = "github-run-1",
  leaseCommentId = "1",
  attributes = "",
  suffix = "",
  user = { id: 274271284, login: "clawsweeper[bot]", type: "Bot" },
} = {}) {
  return {
    id,
    user,
    body: `Review text.

<!-- clawsweeper-review-version item=123 reviewed_at=${reviewedAt} sha=${sha} source_revision=${sourceRevision} lease_owner=${leaseOwner} lease_comment_id=${leaseCommentId} v=1${attributes} -->

<!-- clawsweeper-review item=123 -->${suffix}`,
  };
}

function run(comments: unknown[], trustedBot?: Record<string, string | undefined>) {
  const environment = { ...process.env };
  for (const key of trustedBotEnvironmentKeys) {
    delete environment[key];
  }
  return spawnSync(process.execPath, [helper, "123", head], {
    encoding: "utf8",
    env: { ...environment, ...trustedBot },
    input: JSON.stringify([comments]),
  });
}

describe("ClawSweeper review completion gate", () => {
  it("accepts the trusted trailing v1 marker pair", () => {
    const result = run([reviewComment()]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      commentId: 1,
      reviewedSha: head,
      sourceRevision: "b".repeat(64),
    });
  });

  it("accepts only the explicitly configured self-hosted bot login and numeric id", () => {
    const result = run(
      [reviewComment({ user: { id: 987654321, login: "openclaw-review[bot]", type: "Bot" } })],
      {
        OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_ID: "987654321",
        OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_LOGIN: "openclaw-review[bot]",
      },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    [
      "the default official bot after self-hosted replacement",
      reviewComment(),
      {
        OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_ID: "987654321",
        OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_LOGIN: "openclaw-review[bot]",
      },
    ],
    [
      "a matching self-hosted login with a different numeric id",
      reviewComment({ user: { id: 1, login: "openclaw-review[bot]", type: "Bot" } }),
      {
        OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_ID: "987654321",
        OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_LOGIN: "openclaw-review[bot]",
      },
    ],
    [
      "a matching self-hosted id with a different login",
      reviewComment({ user: { id: 987654321, login: "other-review[bot]", type: "Bot" } }),
      {
        OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_ID: "987654321",
        OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_LOGIN: "openclaw-review[bot]",
      },
    ],
    [
      "a non-Bot author with an otherwise matching pair",
      reviewComment({ user: { id: 987654321, login: "openclaw-review[bot]", type: "User" } }),
      {
        OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_ID: "987654321",
        OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_LOGIN: "openclaw-review[bot]",
      },
    ],
  ])("rejects %s", (_name, comment, trustedBot) => {
    const result = run([comment], trustedBot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("completed review is missing or expired");
  });

  it("rejects an unconfigured self-hosted bot even when its marker is otherwise valid", () => {
    const result = run([
      reviewComment({ user: { id: 987654321, login: "openclaw-review[bot]", type: "Bot" } }),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("completed review is missing or expired");
  });

  it.each([
    { OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_LOGIN: "openclaw-review[bot]" },
    { OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_ID: "987654321" },
    {
      OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_ID: "",
      OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_LOGIN: "openclaw-review[bot]",
    },
    {
      OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_ID: "987654321",
      OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_LOGIN: " ",
    },
    {
      OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_ID: "not-a-number",
      OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_LOGIN: "openclaw-review[bot]",
    },
    {
      OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_ID: "0",
      OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_LOGIN: "openclaw-review[bot]",
    },
    {
      OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_ID: "9007199254740992",
      OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_LOGIN: "openclaw-review[bot]",
    },
    {
      OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_ID: "987654321",
      OPENCLAW_CLAWSWEEPER_TRUSTED_BOT_LOGIN: "not a github app bot",
    },
  ])("fails closed for incomplete or malformed self-hosted trusted identity", (trustedBot) => {
    const result = run([reviewComment()], trustedBot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("trusted bot configuration");
  });

  it.each([
    [
      "ack-only",
      [{ id: 1, body: "<!-- clawsweeper-pr-ack:opened item=123 -->", user: reviewComment().user }],
    ],
    [
      "spoofed author",
      [reviewComment({ user: { id: 1, login: "clawsweeper[bot]", type: "Bot" } })],
    ],
    ["non-trailing marker", [reviewComment({ suffix: "\nmore text" })]],
    ["duplicate attribute", [reviewComment({ attributes: " sha=" + head })]],
    ["malformed source revision", [reviewComment({ sourceRevision: "not-a-revision" })]],
    ["missing lease", [reviewComment({ leaseOwner: "unknown" })]],
    ["expired boundary", [reviewComment({ reviewedAt: ago(12 * 60 * 60_000) })]],
    ["future dated", [reviewComment({ reviewedAt: ago(-6 * 60_000) })]],
  ])("rejects %s evidence", (_name, comments) => {
    const result = run(comments);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ClawSweeper review gate failed:");
  });

  it("selects the newest valid completion and ignores a queued refresh", () => {
    const newer = reviewComment({
      id: 2,
      reviewedAt: ago(30 * 60_000),
      sourceRevision: "c".repeat(64),
      leaseCommentId: "2",
    });
    const queued = {
      id: 3,
      body: "<!-- clawsweeper-command-status:123:re_review:queued -->\nRe-review queued.",
      user: reviewComment().user,
    };
    const result = run([reviewComment(), newer, queued]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      commentId: 2,
      sourceRevision: "c".repeat(64),
    });
  });

  it("rejects conflicting newest completion evidence", () => {
    const reviewedAt = ago(60 * 60_000);
    const result = run([
      reviewComment({ reviewedAt }),
      reviewComment({ id: 2, reviewedAt, sha: "c".repeat(40), leaseCommentId: "2" }),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("newest trusted completion markers conflict");
  });

  it("accepts a recent SHA mismatch with a warning", () => {
    const reviewedSha = "c".repeat(40);
    const result = run([reviewComment({ sha: reviewedSha })]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      `reviewed SHA ${reviewedSha} differs from current head ${head}`,
    );
    expect(JSON.parse(result.stdout).reviewedSha).toBe(reviewedSha);
  });

  it("accepts distinct lease and durable review comment identities", () => {
    const result = run([reviewComment({ id: 2, leaseCommentId: "1" })]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ commentId: 2, leaseCommentId: 1 });
  });
});
