import { describe, expect, it } from "vitest";
import {
  AutomationPlanSchema,
  InstagramCollectReelsInputSchema,
  TaskRequestSchema,
  TikTokCollectVideosInputSchema,
  YoutubeCollectShortTranscriptsInputSchema,
  YoutubeCollectShortsInputSchema
} from "./schemas.js";

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

  it("defaults YouTube Shorts collection to 20 items", () => {
    const parsed = YoutubeCollectShortsInputSchema.parse({
      query: "Tiger Woods"
    });

    expect(parsed.limit).toBe(20);
  });

  it("defaults YouTube Shorts transcript collection to 20 items", () => {
    const parsed = YoutubeCollectShortTranscriptsInputSchema.parse({});

    expect(parsed.limit).toBe(20);
  });

  it("defaults Instagram Reels collection to 20 items", () => {
    const parsed = InstagramCollectReelsInputSchema.parse({});

    expect(parsed.limit).toBe(20);
  });

  it("defaults TikTok collection to 20 items", () => {
    const parsed = TikTokCollectVideosInputSchema.parse({});

    expect(parsed.limit).toBe(20);
  });
});
