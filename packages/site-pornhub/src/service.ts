import path from "node:path";
import type { Page } from "playwright";
import { BrowserSessionManager } from "@nigs/browser-playwright";
import type { RunContext } from "@nigs/core";
import { filterPornhubResults, type PornhubSearchResult } from "./filter.js";

const LAST_PORNHUB_RESULTS_KEY = "pornhub:last-search-results";

async function tryClick(actions: Array<() => Promise<void>>): Promise<boolean> {
  for (const action of actions) {
    try {
      await action();
      return true;
    } catch {
      // Try other selectors.
    }
  }

  return false;
}

async function waitForAnyVisibleSelector(
  page: Page,
  selectors: string[],
  timeoutMs: number
): Promise<string | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        if (await locator.isVisible({ timeout: 500 })) {
          return selector;
        }
      } catch {
        // Try the next selector.
      }
    }

    await page.waitForTimeout(250);
  }

  return null;
}

export class PornhubService {
  constructor(private readonly browserManager: BrowserSessionManager) {}

  async acceptAgeGate(sessionId?: string): Promise<boolean> {
    const page = this.browserManager.getPage(sessionId);

    return tryClick([
      async () => {
        await page.getByRole("button", { name: /i am 18 or older/i }).click({ timeout: 2_500 });
      },
      async () => {
        await page.locator("#age-verification-container button").filter({ hasText: /18 or older/i }).first().click({ timeout: 2_500 });
      },
      async () => {
        await page.locator(".gtm-event-age").filter({ hasText: /18 or older/i }).first().click({ timeout: 2_500 });
      },
      async () => {
        await page.getByRole("button", { name: /accept all cookies/i }).click({ timeout: 2_500 });
      },
      async () => {
        await page.getByRole("button", { name: /accept only essential cookies/i }).click({ timeout: 2_500 });
      }
    ]);
  }

  async search(runContext: RunContext, query: string, limit: number, sessionId?: string): Promise<PornhubSearchResult[]> {
    const page = this.browserManager.getPage(sessionId);
    await page.goto("https://www.pornhub.com", { waitUntil: "domcontentloaded" });
    await this.acceptAgeGate(sessionId);

    const searchBox = page.locator("#searchInput, input[name='search']").first();
    await searchBox.waitFor({ state: "visible", timeout: 15_000 });
    await searchBox.fill(query);
    await searchBox.press("Enter");

    await page.waitForURL(/\/video\/search\?search=/, { timeout: 20_000 });
    const visibleSelector = await waitForAnyVisibleSelector(
      page,
      [
        "li.pcVideoListItem:has(a[href*='/view_video.php?viewkey='])",
        "li.videoBox:has(a[href*='/view_video.php?viewkey='])"
      ],
      20_000
    );

    if (!visibleSelector) {
      throw new Error("Timed out waiting for a visible Pornhub search result.");
    }

    const results = filterPornhubResults(
      await page.locator("li.pcVideoListItem, li.videoBox").evaluateAll((cards) =>
        cards
          .filter((card) => {
            const element = card as HTMLElement;
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 0 &&
              rect.height > 0
            );
          })
          .map((card) => {
          const titleLink =
            card.querySelector<HTMLAnchorElement>('a[href*="/view_video.php?viewkey="]') ??
            card.querySelector<HTMLAnchorElement>("a.linkVideoThumb");
          const duration =
            card
              .querySelector(".duration, .marker-overlays .time, .videoDuration")
              ?.textContent?.replace(/\s+/g, " ")
              .trim() ?? null;
          const views =
            card
              .querySelector(".views, .viewing, .videoDetailsBlock .views")
              ?.textContent?.replace(/\s+/g, " ")
              .trim() ?? null;
          const uploader =
            card
              .querySelector(".usernameWrap a, .userLink, .modelName a")
              ?.textContent?.replace(/\s+/g, " ")
              .trim() ?? null;
          const href = titleLink?.href ?? titleLink?.getAttribute("href") ?? "";
          const title =
            titleLink?.getAttribute("title")?.replace(/\s+/g, " ").trim() ??
            titleLink?.textContent?.replace(/\s+/g, " ").trim() ??
            "";

          return {
            title,
            url: href.startsWith("http") ? href : new URL(href, location.origin).toString(),
            viewsText: views,
            durationText: duration,
            uploader
          };
          })
      ),
      limit
    );

    runContext.setState(LAST_PORNHUB_RESULTS_KEY, results);
    return results;
  }

  async captureScreenshot(
    runContext: RunContext,
    input: { resultIndex?: number; videoUrl?: string; sessionId?: string; fullPage: boolean }
  ): Promise<{ title: string; url: string; screenshotPath: string }> {
    const page = this.browserManager.getPage(input.sessionId);
    const results = runContext.getState<PornhubSearchResult[]>(LAST_PORNHUB_RESULTS_KEY) ?? [];
    const fallback = input.resultIndex !== undefined ? results[input.resultIndex - 1] : undefined;
    const targetUrl = input.videoUrl ?? fallback?.url;

    if (!targetUrl) {
      throw new Error("No Pornhub result available for the requested index.");
    }

    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await this.acceptAgeGate(input.sessionId);
    await page.waitForURL(/\/view_video\.php\?viewkey=/, { timeout: 20_000 });

    const titleLocator = page.locator("h1, .title, .video-title").filter({ hasText: /\S/ }).first();
    try {
      await titleLocator.waitFor({ state: "visible", timeout: 20_000 });
    } catch {
      // Allow screenshot even if title selector is unstable.
    }

    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const screenshotPath = path.join(
      this.browserManager.runtimePaths.artifactsRoot,
      runContext.runId,
      "files",
      `${timestamp}-pornhub-screenshot.png`
    );

    await page.screenshot({ path: screenshotPath, fullPage: input.fullPage });

    const title =
      (await titleLocator.textContent())?.replace(/\s+/g, " ").trim() ||
      fallback?.title ||
      (await page.title());

    return {
      title,
      url: page.url(),
      screenshotPath
    };
  }
}
