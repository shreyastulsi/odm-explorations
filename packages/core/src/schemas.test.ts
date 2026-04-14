import { describe, expect, it } from "vitest";
import { AutomationPlanSchema, TaskRequestSchema } from "./schemas.js";

describe("schemas", () => {
  it("applies defaults to task requests", () => {
    const parsed = TaskRequestSchema.parse({
      goal: "Search YouTube"
    });

    expect(parsed.mode).toBe("plan_and_execute");
    expect(parsed.maxSteps).toBe(12);
  });

  it("rejects plans with unknown tools", () => {
    expect(() =>
      AutomationPlanSchema.parse({
        steps: [{ tool: "unknown_tool", input: {} }]
      })
    ).toThrow();
  });
});
