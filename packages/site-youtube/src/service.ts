import type { Page } from "playwright";
import { BrowserSessionManager } from "@nigs/browser-playwright";
import type { RunContext } from "@nigs/core";
import { filterOrganicYouTubeResults, type YoutubeSearchResult } from "./filter.js";

const LAST_SEARCH_RESULTS_KEY = "youtube:last-search-results";

export interface YoutubeVideoArtifact extends YoutubeSearchResult {
  transcriptText: string | null;
}

function formatDuration(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainingSeconds = wholeSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, remainingSeconds]
      .map((value, index) => (index === 0 ? String(value) : String(value).padStart(2, "0")))
      .join(":");
  }

  return [minutes, remainingSeconds]
    .map((value, index) => (index === 0 ? String(value) : String(value).padStart(2, "0")))
    .join(":");
}

async function tryClick(locators: Array<() => Promise<void>>): Promise<boolean> {
  for (const action of locators) {
    try {
      await action();
      return true;
    } catch {
      // Keep trying other locator strategies.
    }
  }

  return false;
}

async function acceptConsent(page: Page): Promise<void> {
  await tryClick([
    async () => {
      const button = page.getByRole("button", { name: /accept all/i }).first();
      await button.click({ timeout: 2_000 });
    },
    async () => {
      const button = page.getByRole("button", { name: /i agree/i }).first();
      await button.click({ timeout: 2_000 });
    },
    async () => {
      const button = page.getByRole("button", { name: /agree/i }).first();
      await button.click({ timeout: 2_000 });
    }
  ]);
}

async function extractSearchResults(page: Page): Promise<YoutubeSearchResult[]> {
  const rawResults = await page.locator("ytd-video-renderer").evaluateAll((cards) =>
    cards.map((card) => {
      const titleLink = card.querySelector<HTMLAnchorElement>("#video-title");
      const metadata = Array.from(card.querySelectorAll("#metadata-line span"))
        .map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "")
        .filter(Boolean);
      const description = Array.from(
        card.querySelectorAll(
          "#description-text, #description-text-inline-expander, yt-formatted-string.metadata-snippet-text"
        )
      )
        .map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "")
        .find(Boolean);
      const duration = card
        .querySelector("ytd-thumbnail-overlay-time-status-renderer span")
        ?.textContent?.replace(/\s+/g, " ")
        .trim();
      const href = titleLink?.href ?? titleLink?.getAttribute("href") ?? "";

      return {
        title: titleLink?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        url: href.startsWith("http") ? href : new URL(href, location.origin).toString(),
        channel:
          card
            .querySelector("#channel-name a, ytd-channel-name a")
            ?.textContent?.replace(/\s+/g, " ")
            .trim() ?? null,
        publishedText: metadata[1] ?? null,
        durationText: duration || null,
        descriptionText: description ?? null,
        viewsText: metadata[0] ?? null
      };
    })
  );

  return rawResults;
}

async function expandDescription(page: Page): Promise<void> {
  await tryClick([
    async () => {
      const button = page.locator("#expand").first();
      await button.click({ timeout: 2_000 });
    },
    async () => {
      const button = page.getByRole("button", { name: /more/i }).first();
      await button.click({ timeout: 2_000 });
    }
  ]);
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
        // Keep polling other candidates.
      }
    }

    await page.waitForTimeout(250);
  }

  return null;
}

async function waitForYouTubeWatchPageReady(page: Page): Promise<void> {
  await page.waitForURL(/\/watch\b/, { timeout: 20_000 });

  const visibleTitleSelector = await waitForAnyVisibleSelector(
    page,
    [
      "ytd-watch-metadata h1 yt-formatted-string",
      "ytd-watch-metadata h1",
      "#title h1 yt-formatted-string",
      "#title h1"
    ],
    30_000
  );

  if (visibleTitleSelector) {
    return;
  }

  const fallbackTitle = await page.evaluate(() => {
    const selectors = [
      "ytd-watch-metadata h1 yt-formatted-string",
      "ytd-watch-metadata h1",
      "#title h1 yt-formatted-string",
      "#title h1"
    ];

    for (const selector of selectors) {
      const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
      for (const element of elements) {
        const text = element.innerText?.replace(/\s+/g, " ").trim();
        const style = window.getComputedStyle(element);
        if (text && style.display !== "none" && style.visibility !== "hidden") {
          return text;
        }
      }
    }

    return null;
  });

  if (fallbackTitle) {
    return;
  }

  throw new Error("Timed out waiting for a visible YouTube watch-page title.");
}

async function extractTranscript(page: Page): Promise<string | null> {
  const opened = await tryClick([
    async () => {
      const button = page.getByText("Show transcript", { exact: false }).first();
      await button.click({ timeout: 2_000 });
    },
    async () => {
      const menuButton = page.locator('button[aria-label*="More actions"]').first();
      await menuButton.click({ timeout: 2_000 });
      const transcriptButton = page.getByText("Show transcript", { exact: false }).first();
      await transcriptButton.click({ timeout: 2_000 });
    }
  ]);

  if (!opened) {
    return null;
  }

  try {
    await page.locator("ytd-transcript-segment-renderer").first().waitFor({
      state: "visible",
      timeout: 5_000
    });
  } catch {
    return null;
  }

  const transcript = await page.locator("ytd-transcript-segment-renderer").evaluateAll((segments) =>
    segments
      .map((segment) => {
        const timestamp =
          segment
            .querySelector('[class*="timestamp"], [id*="timestamp"]')
            ?.textContent?.replace(/\s+/g, " ")
            .trim() ?? "";
        const text =
          segment
            .querySelector('[class*="segment-text"], [id*="segment-text"]')
            ?.textContent?.replace(/\s+/g, " ")
            .trim() ?? "";
        return [timestamp, text].filter(Boolean).join(" ");
      })
      .filter(Boolean)
      .join("\n")
  );

  return transcript || null;
}

export class YouTubeService {
  constructor(private readonly browserManager: BrowserSessionManager) {}

  async search(runContext: RunContext, query: string, limit: number, sessionId?: string) {
    const page = this.browserManager.getPage(sessionId);
    await page.goto("https://www.youtube.com", { waitUntil: "domcontentloaded" });
    await acceptConsent(page);

    const searchBox = page.locator('input[name="search_query"]').first();
    await searchBox.waitFor({ state: "visible", timeout: 15_000 });
    await searchBox.fill(query);
    await searchBox.press("Enter");

    await page.waitForURL(/results\?search_query=/, { timeout: 15_000 });
    await page.locator("ytd-video-renderer").first().waitFor({ state: "visible", timeout: 15_000 });

    const results = filterOrganicYouTubeResults(await extractSearchResults(page), limit);
    runContext.setState(LAST_SEARCH_RESULTS_KEY, results);

    return results;
  }

  async openResult(
    runContext: RunContext,
    input: { resultIndex?: number; videoUrl?: string; includeTranscript: boolean; sessionId?: string }
  ): Promise<YoutubeVideoArtifact> {
    const page = this.browserManager.getPage(input.sessionId);
    const lastResults = runContext.getState<YoutubeSearchResult[]>(LAST_SEARCH_RESULTS_KEY) ?? [];
    const fallback =
      input.resultIndex !== undefined ? lastResults[input.resultIndex - 1] : undefined;
    const targetUrl = input.videoUrl ?? fallback?.url;

    if (!targetUrl) {
      throw new Error("No YouTube result available for the requested index.");
    }

    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await waitForYouTubeWatchPageReady(page);
    await expandDescription(page);

    const raw = await page.evaluate((fallbackResult) => {
      const pickText = (selectors: string[]): string | null => {
        for (const selector of selectors) {
          const value = document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim();
          if (value) {
            return value;
          }
        }
        return null;
      };

      const descriptionCandidates = Array.from(
        document.querySelectorAll("#description-inline-expander, ytd-text-inline-expander, #description")
      )
        .map((element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "")
        .filter(Boolean);
      const publishedCandidates = Array.from(
        document.querySelectorAll("#info-strings yt-formatted-string, #date yt-formatted-string")
      )
        .map((element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "")
        .filter(Boolean);
      const video = document.querySelector("video") as HTMLVideoElement | null;

      return {
        title:
          pickText([
            "ytd-watch-metadata h1 yt-formatted-string",
            "h1.ytd-watch-metadata yt-formatted-string",
            "h1 yt-formatted-string"
          ]) ?? fallbackResult?.title ?? "",
        channel:
          pickText(["ytd-watch-metadata #channel-name a", "#channel-name a", "ytd-video-owner-renderer a"]) ??
          fallbackResult?.channel ??
          null,
        publishedText: publishedCandidates[0] ?? fallbackResult?.publishedText ?? null,
        descriptionText: descriptionCandidates[0] ?? fallbackResult?.descriptionText ?? null,
        durationSeconds:
          video && Number.isFinite(video.duration) ? Math.floor(video.duration) : null
      };
    }, fallback);

    const transcriptText = input.includeTranscript ? await extractTranscript(page) : null;

    return {
      title: raw.title,
      url: page.url(),
      channel: raw.channel,
      publishedText: raw.publishedText,
      durationText:
        raw.durationSeconds !== null
          ? formatDuration(raw.durationSeconds)
          : fallback?.durationText ?? null,
      descriptionText: raw.descriptionText,
      viewsText: fallback?.viewsText ?? null,
      transcriptText
    };
  }
}
