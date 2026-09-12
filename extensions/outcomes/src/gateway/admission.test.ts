import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { admitOutcomeOwner } from "./admission.js";

const schema = Type.Object({ id: Type.String() }, { additionalProperties: false });

describe("Outcome Gateway admission", () => {
  it("rejects malformed input before trying to resolve an authenticated owner", () => {
    const respond = vi.fn();
    expect(
      admitOutcomeOwner({
        client: null,
        missingOwnerCode: "NOT_FOUND",
        request: { extra: true },
        respond,
        schema,
      }),
    ).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "OUTCOME_INVALID_REQUEST" }),
    );
  });

  it("keeps the caller-selected non-disclosing missing-owner response", () => {
    const respond = vi.fn();
    expect(
      admitOutcomeOwner({
        client: null,
        missingOwnerCode: "NOT_FOUND",
        request: { id: "outcome" },
        respond,
        schema,
      }),
    ).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "OUTCOME_NOT_FOUND" }),
    );
  });

  it("returns the authenticated owner only after schema admission", () => {
    const respond = vi.fn();
    expect(
      admitOutcomeOwner({
        client: { authenticatedUserProfile: { profileId: " manager-a " } } as never,
        missingOwnerCode: "INVALID_REQUEST",
        request: { id: "outcome" },
        respond,
        schema,
      }),
    ).toBe("manager-a");
    expect(respond).not.toHaveBeenCalled();
  });
});
