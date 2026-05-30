import { describe, expect, it } from "vitest";
import {
  extractExplicitFilename,
  inferFastAgentNewFileTarget
} from "../src/fastAgentTarget.js";

describe("Fast Agent new-file target inference", () => {
  it("does not infer a target when the task is not a create request", () => {
    expect(inferFastAgentNewFileTarget("fix the bug in the parser")).toBeUndefined();
  });

  it("honors an explicit filename in the request", () => {
    expect(inferFastAgentNewFileTarget("create a snake game in snake.py")).toBe("snake.py");
    expect(inferFastAgentNewFileTarget("build game/board.js with the grid")).toBe("game/board.js");
  });

  it("picks a language-appropriate name instead of always index.html", () => {
    // Regression: a Python game request previously produced index.html.
    expect(inferFastAgentNewFileTarget("create a snake game in python")).toBe("main.py");
    expect(inferFastAgentNewFileTarget("build a rust CLI tool")).toBe("main.rs");
    expect(inferFastAgentNewFileTarget("generate a go web server")).toBe("main.go");
  });

  it("still defaults to index.html for web/canvas requests", () => {
    expect(inferFastAgentNewFileTarget("create a snake game on a canvas")).toBe("index.html");
    expect(inferFastAgentNewFileTarget("build a landing page")).toBe("index.html");
  });

  it("extracts only filenames with editable extensions", () => {
    expect(extractExplicitFilename("update version to 1.2 and edit app.ts")).toBe("app.ts");
    expect(extractExplicitFilename("the score is 9.99 with no file")).toBeUndefined();
  });
});
