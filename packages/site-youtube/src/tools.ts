import type {
  ToolDefinition,
  YoutubeOpenResultInput,
  YoutubeSearchVideosInput
} from "@nigs/core";
import {
  YoutubeOpenResultInputSchema,
  YoutubeSearchVideosInputSchema
} from "@nigs/core";
import { BrowserSessionManager } from "@nigs/browser-playwright";
import { YouTubeService } from "./service.js";

export function createYouTubeTools(
  browserManager: BrowserSessionManager
): ToolDefinition[] {
  const youtubeService = new YouTubeService(browserManager);

  const searchTool: ToolDefinition<YoutubeSearchVideosInput> = {
    name: "youtube_search_videos",
    title: "Search YouTube Videos",
    description: "Search YouTube and return organic video results only.",
    inputSchema: YoutubeSearchVideosInputSchema,
    execute: async (context, input) => {
      const results = await youtubeService.search(
        context,
        input.query,
        input.limit,
        input.sessionId
      );
      const artifact = await context.writeArtifact({
        type: "youtube-search-results",
        content: {
          query: input.query,
          results
        }
      });
      const snapshot = await browserManager.snapshot(context.runId, "youtube-search", input.sessionId);

      return {
        ok: true,
        data: {
          query: input.query,
          results
        },
        artifactIds: [artifact.id],
        ...snapshot
      };
    }
  };

  const openResultTool: ToolDefinition<YoutubeOpenResultInput> = {
    name: "youtube_open_result",
    title: "Open YouTube Result",
    description: "Open a prior YouTube search result and extract video details.",
    inputSchema: YoutubeOpenResultInputSchema,
    execute: async (context, input) => {
      const result = await youtubeService.openResult(context, {
        includeTranscript: input.includeTranscript,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.resultIndex !== undefined ? { resultIndex: input.resultIndex } : {}),
        ...(input.videoUrl ? { videoUrl: input.videoUrl } : {})
      });
      const artifact = await context.writeArtifact({
        type: "youtube-video",
        sourceUrl: result.url,
        content: result
      });
      const snapshot = await browserManager.snapshot(context.runId, "youtube-video", input.sessionId);

      return {
        ok: true,
        data: result,
        artifactIds: [artifact.id],
        ...snapshot
      };
    }
  };

  return [searchTool, openResultTool];
}
