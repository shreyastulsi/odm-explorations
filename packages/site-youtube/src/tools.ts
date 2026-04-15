import type {
  ToolDefinition,
  YoutubeCollectShortTranscriptsInput,
  YoutubeCollectShortsInput,
  YoutubeOpenResultInput,
  YoutubeSearchVideosInput
} from "@nigs/core";
import {
  YoutubeCollectShortTranscriptsInputSchema,
  YoutubeCollectShortsInputSchema,
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

  const collectShortsTool: ToolDefinition<YoutubeCollectShortsInput> = {
    name: "youtube_collect_shorts",
    title: "Collect YouTube Shorts",
    description:
      "Open YouTube Shorts, optionally search for a topic, scroll through Shorts, and record titles, captions, hashtags, creator details, URLs, and visible engagement counts.",
    inputSchema: YoutubeCollectShortsInputSchema,
    execute: async (context, input) => {
      const shorts = await youtubeService.collectShorts(context, {
        limit: input.limit,
        ...(input.query ? { query: input.query } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {})
      });
      const artifact = await context.writeArtifact({
        type: "youtube-shorts",
        content: {
          query: input.query ?? null,
          shorts
        }
      });
      const snapshot = await browserManager.snapshot(context.runId, "youtube-shorts", input.sessionId);

      return {
        ok: true,
        data: {
          query: input.query ?? null,
          shorts
        },
        artifactIds: [artifact.id],
        ...snapshot
      };
    }
  };

  const collectShortTranscriptsTool: ToolDefinition<YoutubeCollectShortTranscriptsInput> = {
    name: "youtube_collect_short_transcripts",
    title: "Collect YouTube Short Transcripts",
    description:
      "Open YouTube Shorts from a feed, search, or explicit Shorts URLs and save metadata plus available caption/transcript text and timestamped transcript segments.",
    inputSchema: YoutubeCollectShortTranscriptsInputSchema,
    execute: async (context, input) => {
      const shorts = await youtubeService.collectShortTranscripts(context, {
        limit: input.limit,
        ...(input.query ? { query: input.query } : {}),
        ...(input.shortUrls ? { shortUrls: input.shortUrls } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {})
      });
      const artifact = await context.writeArtifact({
        type: "youtube-short-transcripts",
        content: {
          query: input.query ?? null,
          shortUrls: input.shortUrls ?? null,
          shorts
        }
      });
      const snapshot = await browserManager.snapshot(context.runId, "youtube-short-transcripts", input.sessionId);

      return {
        ok: true,
        data: {
          query: input.query ?? null,
          shortUrls: input.shortUrls ?? null,
          shorts
        },
        artifactIds: [artifact.id],
        ...snapshot
      };
    }
  };

  return [searchTool, openResultTool, collectShortsTool, collectShortTranscriptsTool];
}
