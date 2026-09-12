import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readWorkboardCards } from "./workboard-adapter.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/workboard-list.v1.json", import.meta.url), "utf8"),
);

describe("Workboard adapter", () => {
  it("uses public identity fields and defaults an absent board id", () => {
    expect(readWorkboardCards(fixture)).toMatchObject([
      { id: "card-proof-artifact", createdAt: 1700000000000, boardId: "release-board" },
      { id: "card-default-board", createdAt: 1700000200000, boardId: "default" },
    ]);
  });
  it("accepts owner automation metadata without a board id while validating one when supplied", () => {
    const cardWithWorkspaceAccess = {
      ...fixture.cards[0],
      metadata: {
        ...fixture.cards[0].metadata,
        automation: {
          workspaceAccess: { roots: ["/tmp/outcomes"], unrestricted: false, writable: true },
        },
      },
    };
    expect(readWorkboardCards({ cards: [cardWithWorkspaceAccess] })).toMatchObject([
      { id: fixture.cards[0].id, boardId: "default" },
    ]);
    expect(
      readWorkboardCards({
        cards: [
          {
            ...cardWithWorkspaceAccess,
            metadata: {
              ...cardWithWorkspaceAccess.metadata,
              automation: { ...cardWithWorkspaceAccess.metadata.automation, boardId: "owner-board" },
            },
          },
        ],
      }),
    ).toMatchObject([{ boardId: "owner-board" }]);
    expect(() =>
      readWorkboardCards({
        cards: [
          {
            ...cardWithWorkspaceAccess,
            metadata: {
              ...cardWithWorkspaceAccess.metadata,
              automation: { ...cardWithWorkspaceAccess.metadata.automation, boardId: "" },
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      readWorkboardCards({
        cards: [
          {
            ...cardWithWorkspaceAccess,
            metadata: {
              ...cardWithWorkspaceAccess.metadata,
              automation: { ...cardWithWorkspaceAccess.metadata.automation, boardId: 1 },
            },
          },
        ],
      }),
    ).toThrow();
  });
  it("treats a declared stale state as structured public source metadata", () => {
    const cards = readWorkboardCards({
      cards: [
        {
          ...fixture.cards[0],
          metadata: {
            ...fixture.cards[0].metadata,
            stale: { detectedAt: 1700000101000, reason: "owner sync paused" },
          },
        },
      ],
    });
    expect(cards[0]).toMatchObject({ upstreamStale: true });
    expect(() =>
      readWorkboardCards({
        cards: [
          {
            ...fixture.cards[0],
            metadata: { ...fixture.cards[0].metadata, stale: { detectedAt: true, reason: "bad" } },
          },
        ],
      }),
    ).toThrow();
  });
  it("fails closed for a malformed owner identity or ambiguous card identity", () => {
    expect(() => readWorkboardCards({ cards: [{ ...fixture.cards[0], id: "" }] })).toThrow();
    expect(() => readWorkboardCards({ cards: [fixture.cards[0], fixture.cards[0]] })).toThrow();
    expect(() =>
      readWorkboardCards({ cards: [{ ...fixture.cards[0], status: "unrecognized" }] }),
    ).toThrow();
    expect(() =>
      readWorkboardCards({
        cards: [
          {
            ...fixture.cards[0],
            metadata: {
              ...fixture.cards[0].metadata,
              proof: [fixture.cards[0].metadata.proof[0], fixture.cards[0].metadata.proof[0]],
            },
          },
        ],
      }),
    ).toThrow(/duplicate/i);
  });

  it("fails closed when one card id is reused with a different creation identity", () => {
    expect(() =>
      readWorkboardCards({
        cards: [
          fixture.cards[0],
          { ...fixture.cards[0], createdAt: fixture.cards[0].createdAt + 1 },
        ],
      }),
    ).toThrow(/identity|ambiguous|collision/i);
  });
});
