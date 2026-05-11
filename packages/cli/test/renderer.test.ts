import { describe, expect, it } from "vitest";
import { renderStepReportToString } from "../src/renderer.js";

describe("CLI step renderer", () => {
  it("renders step report events", () => {
    const output = renderStepReportToString({
      title: "Buildr Run",
      summary: "1 check completed.",
      events: [
        {
          id: "event:1",
          title: "Create plan",
          status: "completed",
          summary: "Created a plan.",
          warnings: []
        }
      ]
    });

    expect(output).toContain("Buildr Run");
    expect(output).toContain("[ok] Create plan");
  });
});
