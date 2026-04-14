import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { BrowserSessionManager } from "./session-manager.js";

const describeIfBrowser = process.env.RUN_BROWSER_INTEGRATION === "1" ? describe : describe.skip;
const tempDirs: string[] = [];

afterAll(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describeIfBrowser("BrowserSessionManager integration", () => {
  it("launches Chrome and reads example.com", async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "nigs-browser-integration-"));
    tempDirs.push(runtimeDir);

    const manager = new BrowserSessionManager(runtimeDir);
    try {
      await manager.launch("integration-run", {
        headless: true,
        slowMoMs: 0,
        viewport: { width: 1280, height: 900 }
      });
      await manager.goto("integration-run", {
        url: "https://example.com"
      });
      const result = await manager.readPage("integration-run", {
        maxChars: 2_000
      });

      expect(result.pageTitle?.toLowerCase()).toContain("example");
      expect(result.currentUrl).toContain("example.com");
    } finally {
      await manager.closeAll();
    }
  });
});

