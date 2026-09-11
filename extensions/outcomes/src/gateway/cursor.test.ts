import { describe, expect, it } from "vitest";
import { decodeOutcomeCursor, encodeOutcomeCursor } from "./cursor.js";

describe("Outcome list cursor", () => {
  it("round-trips the stable sort anchor only for its authenticated profile", () => {
    const cursor = encodeOutcomeCursor("manager-a", {
      updatedAt: 42,
      id: "123e4567-e89b-42d3-a456-426614174000",
    });
    expect(decodeOutcomeCursor("manager-a", cursor)).toEqual({
      updatedAt: 42,
      id: "123e4567-e89b-42d3-a456-426614174000",
    });
    expect(decodeOutcomeCursor("manager-b", cursor)).toBeUndefined();
  });

  it("rejects malformed and incompatible cursors without exposing their contents", () => {
    expect(decodeOutcomeCursor("manager-a", "not-a-cursor")).toBeUndefined();
    const incompatible = Buffer.from(
      JSON.stringify({ v: 2, updatedAt: 42, id: "id", profileDigest: "digest" }),
      "utf8",
    ).toString("base64url");
    expect(decodeOutcomeCursor("manager-a", incompatible)).toBeUndefined();
  });
});
