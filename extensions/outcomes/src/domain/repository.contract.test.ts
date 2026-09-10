import { describe, it } from "vitest";

// P-01 contract cases are intentionally staged before the domain repository
// exists. They name the required observable behavior without treating a
// missing production module as a RED result.
describe("Outcome repository atomic contract", () => {
  it.todo("replays an idempotent mutation before checking expected revision");
  it.todo("commits the same mutation once when concurrent callers race");
  it.todo("returns a typed rejection without writing the record");
  it.todo("returns unchanged state without incrementing revision or writing");
});
