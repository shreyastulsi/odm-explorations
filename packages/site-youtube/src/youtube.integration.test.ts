import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { BrowserSessionManager } from "@nigs/browser-playwright";
import { ArtifactStore, RunContext, TaskRequestSchema } from "@nigs/core";
import { YouTubeService } from "./service.js";

const describeIfYoutube = process.env.RUN_YOUTUBE_INTEGRATION === "1" ? describe : describe.skip;
const tempDirs: string[] = [];

afterAll(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describeIfYoutube("YouTubeService integration", () => {
  it("returns three organic YouTube video results", async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "nigs-youtube-integration-"));
    tempDirs.push(runtimeDir);

    const artifactStore = new ArtifactStore(runtimeDir);
    await artifactStore.initialize();
    const run = await artifactStore.createRun(
      TaskRequestSchema.parse({
        goal: "Integration YouTube search"
      })
    );
    const context = new RunContext({
      runId: run.runId,
      artifactStore
    });

    const browserManager = new BrowserSessionManager(runtimeDir);
    const youtubeService = new YouTubeService(browserManager);

    try {
      await browserManager.launch(run.runId, {
        headless: true,
        slowMoMs: 0,
        viewport: { width: 1440, height: 960 }
      });

      const results = await youtubeService.search(
        context,
        "LeBron James highlights",
        3
      );

      expect(results).toHaveLength(3);
      expect(results.every((result) => result.url.includes("/watch"))).toBe(true);
    } finally {
      await browserManager.closeAll();
    }
  });
});
