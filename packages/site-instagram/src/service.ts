import type { Page } from "playwright";
import { BrowserSessionManager } from "@nigs/browser-playwright";
import type { RunContext } from "@nigs/core";

export interface InstagramReelArtifact {
  platform: "instagram";
  position: number;
  url: string;
  videoId: string | null;
  title: string | null;
  caption: string | null;
  hashtags: string[];
  creatorName: string | null;
  creatorHandle: string | null;
  creatorUrl: string | null;
  likeCountText: string | null;
  commentCountText: string | null;
  viewCountText: string | null;
  collectedAt: string;
}

function normalizeQueryForTag(query: string): string {
  return query.replace(/^#/, "").trim().replace(/\s+/g, "").toLowerCase();
}

function dedupeReels(reels: InstagramReelArtifact[]): InstagramReelArtifact[] {
  const seen = new Set<string>();
  const deduped: InstagramReelArtifact[] = [];

  for (const reel of reels) {
    const key = reel.videoId ?? reel.url ?? `${reel.caption}:${reel.creatorHandle}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(reel);
  }

  return deduped;
}

async function openReelsStart(page: Page, query?: string): Promise<void> {
  if (query) {
    const tag = normalizeQueryForTag(query);
    await page.goto(`https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`, {
      waitUntil: "domcontentloaded"
    });
    const reelLink = page.locator('a[href*="/reel/"], a[href*="/p/"]').first();
    await reelLink.waitFor({ state: "visible", timeout: 30_000 });
    await reelLink.click();
    await page.waitForURL(/\/(reel|p)\//, { timeout: 20_000 });
    return;
  }

  await page.goto("https://www.instagram.com/reels/", { waitUntil: "domcontentloaded" });
}

async function waitForInstagramReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      Boolean(
        document.querySelector("video") ||
          document.querySelector('a[href*="/reel/"]') ||
          document.querySelector("article")
      ),
    { timeout: 30_000 }
  );
}

async function waitForInstagramMetadata(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const pathId = window.location.pathname.match(/\/(?:reel|reels|p)\/([^/?#]+)/)?.[1];
        const activeVideo = Array.from(document.querySelectorAll<HTMLVideoElement>("video")).find((video) => {
          const rect = video.getBoundingClientRect();
          return rect.top < window.innerHeight * 0.75 && rect.bottom > window.innerHeight * 0.25;
        });
        return Boolean(pathId || activeVideo);
      },
      { timeout: 3_000 }
    );
  } catch {
    await page.waitForTimeout(750);
  }
}

async function extractActiveReel(page: Page, position: number): Promise<InstagramReelArtifact | null> {
  return page.evaluate((itemPosition) => {
    const normalizeText = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();
    const hashtagsFrom = (value: string): string[] =>
      Array.from(new Set(value.match(/#[\p{L}\p{N}_]+/gu) ?? []));
    const stripHashtags = (value: string): string =>
      value.replace(/#[\p{L}\p{N}_]+/gu, "").replace(/\s+/g, " ").trim();
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const textMatches = (root: ParentNode, pattern: RegExp): string | null => {
      const elements = Array.from(root.querySelectorAll<HTMLElement>("span, div, a, button"));
      for (const element of elements) {
        if (!visible(element)) {
          continue;
        }
        const text = normalizeText(element.innerText || element.textContent);
        if (pattern.test(text)) {
          return text;
        }
      }
      return null;
    };
    const activeVideo = Array.from(document.querySelectorAll<HTMLVideoElement>("video")).find((video) => {
      const rect = video.getBoundingClientRect();
      return rect.top < window.innerHeight * 0.75 && rect.bottom > window.innerHeight * 0.25;
    });
    const ancestors = activeVideo
      ? Array.from(document.querySelectorAll<HTMLElement>("article, section, div")).filter((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return candidate.contains(activeVideo) && rect.height > 100 && rect.height <= window.innerHeight * 1.5;
        })
      : [];
    const sortedAncestors = ancestors.sort(
      (left, right) => left.getBoundingClientRect().height - right.getBoundingClientRect().height
    );

    const active =
      sortedAncestors.find((candidate) => {
        const text = normalizeText(candidate.textContent);
        return text.length > 20 && candidate.querySelector("a[href]");
      }) ??
      sortedAncestors[0] ??
      activeVideo?.parentElement ??
      document.body;
    const link =
      active.querySelector<HTMLAnchorElement>('a[href*="/reel/"]') ??
      active.querySelector<HTMLAnchorElement>('a[href*="/reels/"]') ??
      document.querySelector<HTMLAnchorElement>('a[href*="/p/"]');
    const currentUrl = window.location.pathname.match(/\/(?:reel|reels|p)\//)
      ? window.location.href
      : link?.href;
    const url = new URL(currentUrl ?? window.location.href, window.location.origin).toString();
    const videoId = url.match(/\/(?:reel|reels|p)\/([^/?#]+)/)?.[1] ?? null;
    const visibleText = normalizeText(active.textContent);
    const caption = visibleText || null;
    const hashtags = hashtagsFrom(`${caption ?? ""} ${visibleText}`);
    const creatorLink =
      active.querySelector<HTMLAnchorElement>('a[href^="/"]:not([href*="/reel/"]):not([href*="/p/"])') ??
      active.querySelector<HTMLAnchorElement>('a[href*="instagram.com/"]:not([href*="/reel/"]):not([href*="/p/"])');
    const creatorUrl = creatorLink ? new URL(creatorLink.href, window.location.origin).toString() : null;
    const creatorHandle = creatorUrl?.match(/instagram\.com\/([^/?#]+)/)?.[1] ?? null;
    const creatorName = normalizeText(creatorLink?.innerText || creatorLink?.textContent) || creatorHandle;
    const likeCountText = textMatches(active, /\blikes?\b/i);
    const commentCountText = textMatches(active, /\bcomments?\b/i);
    const viewCountText = textMatches(active, /\bviews?\b|\bplays?\b/i);
    const title = caption ? stripHashtags(caption).slice(0, 160) : null;

    if (!videoId || (!caption && hashtags.length === 0)) {
      return null;
    }

    return {
      platform: "instagram",
      position: itemPosition,
      url,
      videoId,
      title: title || null,
      caption,
      hashtags,
      creatorName: creatorName || null,
      creatorHandle,
      creatorUrl,
      likeCountText,
      commentCountText,
      viewCountText,
      collectedAt: new Date().toISOString()
    };
  }, position);
}

export class InstagramService {
  constructor(private readonly browserManager: BrowserSessionManager) {}

  async collectReels(
    _runContext: RunContext,
    input: { query?: string; limit: number; sessionId?: string }
  ): Promise<InstagramReelArtifact[]> {
    const page = this.browserManager.getPage(input.sessionId);
    await openReelsStart(page, input.query);
    await waitForInstagramReady(page);

    const reels: InstagramReelArtifact[] = [];
    const maxAttempts = input.limit * 4;

    for (let attempt = 0; attempt < maxAttempts && dedupeReels(reels).length < input.limit; attempt += 1) {
      await waitForInstagramMetadata(page);
      const current = await extractActiveReel(page, dedupeReels(reels).length + 1);
      if (current) {
        reels.push(current);
      }

      if (dedupeReels(reels).length >= input.limit) {
        break;
      }

      const previousUrl = page.url();
      await page.keyboard.press("ArrowDown");
      try {
        await page.waitForFunction((url) => window.location.href !== url, previousUrl, { timeout: 2_000 });
      } catch {
        await page.mouse.wheel(0, 900);
        await page.waitForTimeout(1_000);
      }
    }

    return dedupeReels(reels).slice(0, input.limit);
  }
}
