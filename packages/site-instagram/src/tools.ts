import type {
  InstagramCollectReelsInput,
  ToolDefinition
} from "@nigs/core";
import {
  InstagramCollectReelsInputSchema
} from "@nigs/core";
import { BrowserSessionManager } from "@nigs/browser-playwright";
import { InstagramService } from "./service.js";

export function createInstagramTools(browserManager: BrowserSessionManager): ToolDefinition[] {
  const service = new InstagramService(browserManager);

  const collectReelsTool: ToolDefinition<InstagramCollectReelsInput> = {
    name: "instagram_collect_reels",
    title: "Collect Instagram Reels",
    description:
      "Open Instagram Reels or a hashtag page, scroll through reels, and record captions, hashtags, creator, URLs, and visible engagement counts.",
    inputSchema: InstagramCollectReelsInputSchema,
    execute: async (context, input) => {
      const reels = await service.collectReels(context, {
        limit: input.limit,
        ...(input.query ? { query: input.query } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {})
      });
      const artifact = await context.writeArtifact({
        type: "instagram-reels",
        content: {
          query: input.query ?? null,
          reels
        }
      });
      const snapshot = await browserManager.snapshot(context.runId, "instagram-reels", input.sessionId);

      return {
        ok: true,
        data: {
          query: input.query ?? null,
          reels
        },
        artifactIds: [artifact.id],
        ...snapshot
      };
    }
  };

  return [collectReelsTool];
}
