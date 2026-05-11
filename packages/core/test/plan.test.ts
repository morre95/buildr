import { describe, expect, it } from "vitest";
import { createDefaultPlan, validatePlan } from "../src/plans/schema.js";

describe("Buildr plan schema", () => {
  it("creates a valid vertical-slice plan", () => {
    const plan = createDefaultPlan("Add a command");

    expect(validatePlan(plan).goal).toBe("Add a command");
    expect(plan.steps.map((step) => step.id)).toEqual(["inspect", "propose", "verify"]);
  });

  it("rejects empty goals", () => {
    expect(() => createDefaultPlan("   ")).toThrow("A plan goal is required.");
  });
});
