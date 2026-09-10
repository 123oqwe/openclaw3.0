import { describe, expect, it } from "vitest";
import { stableStringify } from "./normalization-runtime.js";

describe("normalization runtime facade", () => {
  it("forwards canonical stringify without a bundled-plugin direct import", () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });
});
