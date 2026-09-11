import { createHash } from "node:crypto";
import { stableStringify } from "openclaw/plugin-sdk/normalization-runtime";

type OutcomeCursor = {
  v: 1;
  updatedAt: number;
  id: string;
  profileDigest: string;
};

function profileDigest(profileId: string): string {
  return createHash("sha256")
    .update(`openclaw:outcome-profile:v1\0${profileId}`, "utf8")
    .digest("hex");
}

/** Opaque pagination token; it is profile-bound but deliberately not a signature. */
export function encodeOutcomeCursor(profileId: string, anchor: Pick<OutcomeCursor, "updatedAt" | "id">): string {
  return Buffer.from(
    stableStringify({ v: 1, updatedAt: anchor.updatedAt, id: anchor.id, profileDigest: profileDigest(profileId) }),
    "utf8",
  ).toString("base64url");
}

/** Returns undefined rather than exposing malformed or cross-profile cursor details. */
export function decodeOutcomeCursor(profileId: string, cursor: string): Pick<OutcomeCursor, "updatedAt" | "id"> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as Partial<OutcomeCursor>).v !== 1 ||
      !Number.isFinite((parsed as Partial<OutcomeCursor>).updatedAt) ||
      typeof (parsed as Partial<OutcomeCursor>).id !== "string" ||
      (parsed as Partial<OutcomeCursor>).profileDigest !== profileDigest(profileId)
    ) {
      return undefined;
    }
    return { updatedAt: (parsed as OutcomeCursor).updatedAt, id: (parsed as OutcomeCursor).id };
  } catch {
    return undefined;
  }
}
