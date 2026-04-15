import { describe, expect, it } from "vitest";
import { TaskRequestSchema } from "@nigs/core";
import { OpenAIResponsesPlanner } from "./openai-planner.js";

describe("OpenAIResponsesPlanner", () => {
  it("parses valid structured plans", async () => {
    const planner = new OpenAIResponsesPlanner(
      {
        responses: {
          create: async () => ({
            output_text: JSON.stringify({
              steps: [
                {
                  tool: "browser_launch",
                  input: {}
                }
              ]
            })
          })
        }
      },
      "test-model"
    );

    const plan = await planner.createPlan(
      TaskRequestSchema.parse({
        goal: "Launch Chrome"
      }),
      []
    );

    expect(plan.steps[0]?.tool).toBe("browser_launch");
  });

  it("rejects invalid planner output", async () => {
    const planner = new OpenAIResponsesPlanner(
      {
        responses: {
          create: async () => ({
            output_text: JSON.stringify({
              steps: [
                {
                  tool: "not_a_tool",
                  input: {}
                }
              ]
            })
          })
        }
      },
      "test-model"
    );

    await expect(
      planner.createPlan(
        TaskRequestSchema.parse({
          goal: "Launch Chrome"
        }),
        []
      )
    ).rejects.toThrow();
  });

  it("normalizes planner retry aliases", async () => {
    const planner = new OpenAIResponsesPlanner(
      {
        responses: {
          create: async () => ({
            output_text: JSON.stringify({
              steps: [
                {
                  tool: "youtube_collect_shorts",
                  input: {
                    limit: 3
                  },
                  retryPolicy: {
                    maxAttempts: 2,
                    backoffMs: 500,
                    retryOn: ["timeout", "noResults", "transientNetworkError"]
                  }
                }
              ]
            })
          })
        }
      },
      "test-model"
    );

    const plan = await planner.createPlan(
      TaskRequestSchema.parse({
        goal: "Collect Shorts"
      }),
      []
    );

    expect(plan.steps[0]?.retryPolicy?.retryOn).toEqual(["timeout", "unknown", "network"]);
  });
});
