import type {
  TikTokCollectVideosInput,
  ToolDefinition
} from "@nigs/core";
import {
  TikTokCollectVideosInputSchema
} from "@nigs/core";
import { BrowserSessionManager } from "@nigs/browser-playwright";
import { TikTokService } from "./service.js";

export function createTikTokTools(browserManager: BrowserSessionManager): ToolDefinition[] {
  const service = new TikTokService(browserManager);

  const collectVideosTool: ToolDefinition<TikTokCollectVideosInput> = {
    name: "tiktok_collect_videos",
    title: "Collect TikTok Videos",
    description:
      "Open TikTok For You or search results, scroll through videos, and record captions, hashtags, creator, URLs, and visible engagement counts.",
    inputSchema: TikTokCollectVideosInputSchema,
    execute: async (context, input) => {
      const videos = await service.collectVideos(context, {
        limit: input.limit,
        ...(input.query ? { query: input.query } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {})
      });
      const artifact = await context.writeArtifact({
        type: "tiktok-videos",
        content: {
          query: input.query ?? null,
          videos
        }
      });
      const snapshot = await browserManager.snapshot(context.runId, "tiktok-videos", input.sessionId);

      return {
        ok: true,
        data: {
          query: input.query ?? null,
          videos
        },
        artifactIds: [artifact.id],
        ...snapshot
      };
    }
  };

  return [collectVideosTool];
}
