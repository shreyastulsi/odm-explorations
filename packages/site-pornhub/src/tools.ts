import type {
  PornhubAcceptAgeGateInput,
  PornhubCaptureScreenshotInput,
  PornhubSearchVideosInput,
  ToolDefinition
} from "@nigs/core";
import {
  PornhubAcceptAgeGateInputSchema,
  PornhubCaptureScreenshotInputSchema,
  PornhubSearchVideosInputSchema
} from "@nigs/core";
import { BrowserSessionManager } from "@nigs/browser-playwright";
import { PornhubService } from "./service.js";

export function createPornhubTools(browserManager: BrowserSessionManager): ToolDefinition[] {
  const service = new PornhubService(browserManager);

  const acceptTool: ToolDefinition<PornhubAcceptAgeGateInput> = {
    name: "pornhub_accept_age_gate",
    title: "Accept Pornhub Age Gate",
    description: "Dismiss the Pornhub age-verification or cookie gate when present.",
    inputSchema: PornhubAcceptAgeGateInputSchema,
    execute: async (context, input) => {
      const accepted = await service.acceptAgeGate(input.sessionId);
      const snapshot = await browserManager.snapshot(context.runId, "pornhub-age-gate", input.sessionId);

      return {
        ok: true,
        data: { accepted },
        ...snapshot
      };
    }
  };

  const searchTool: ToolDefinition<PornhubSearchVideosInput> = {
    name: "pornhub_search_videos",
    title: "Search Pornhub Videos",
    description: "Search Pornhub and return video results.",
    inputSchema: PornhubSearchVideosInputSchema,
    execute: async (context, input) => {
      const results = await service.search(context, input.query, input.limit, input.sessionId);
      const artifact = await context.writeArtifact({
        type: "pornhub-search-results",
        content: {
          query: input.query,
          results
        }
      });
      const snapshot = await browserManager.snapshot(context.runId, "pornhub-search", input.sessionId);

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

  const screenshotTool: ToolDefinition<PornhubCaptureScreenshotInput> = {
    name: "pornhub_capture_screenshot",
    title: "Capture Pornhub Screenshot",
    description: "Open a Pornhub result and capture a screenshot.",
    inputSchema: PornhubCaptureScreenshotInputSchema,
    execute: async (context, input) => {
      const result = await service.captureScreenshot(context, {
        fullPage: input.fullPage,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.resultIndex !== undefined ? { resultIndex: input.resultIndex } : {}),
        ...(input.videoUrl ? { videoUrl: input.videoUrl } : {})
      });

      const artifact = await context.writeArtifact({
        type: "pornhub-screenshot",
        sourceUrl: result.url,
        content: {
          title: result.title,
          url: result.url,
          screenshotPath: result.screenshotPath
        }
      });
      const snapshot = await browserManager.snapshot(context.runId, "pornhub-video", input.sessionId);

      return {
        ok: true,
        data: result,
        artifactIds: [artifact.id],
        screenshotPath: result.screenshotPath,
        tracePath: snapshot.tracePath,
        currentUrl: snapshot.currentUrl,
        pageTitle: snapshot.pageTitle
      };
    }
  };

  return [acceptTool, searchTool, screenshotTool];
}

