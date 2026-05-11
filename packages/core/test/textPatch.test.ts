import { describe, expect, it } from "vitest";
import { applyTextPatch, createTextPatch } from "../src/diff/textPatch.js";

describe("text patch safety", () => {
  it("applies a patch when the original hash still matches", () => {
    const patch = createTextPatch("file.ts", "before", "after");

    expect(applyTextPatch("before", patch)).toBe("after");
  });

  it("rejects stale patches", () => {
    const patch = createTextPatch("file.ts", "before", "after");

    expect(() => applyTextPatch("changed", patch)).toThrow("Patch conflict");
  });
});
