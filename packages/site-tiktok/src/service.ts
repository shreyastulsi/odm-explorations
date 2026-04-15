import type { Page } from "playwright";
import { BrowserSessionManager } from "@nigs/browser-playwright";
import type { RunContext } from "@nigs/core";

export interface TikTokVideoArtifact {
  platform: "tiktok";
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
  shareCountText: string | null;
  viewCountText: string | null;
  collectedAt: string;
}

function dedupeVideos(videos: TikTokVideoArtifact[]): TikTokVideoArtifact[] {
  const seen = new Set<string>();
  const deduped: TikTokVideoArtifact[] = [];

  for (const video of videos) {
    const key = video.videoId ?? video.url ?? `${video.caption}:${video.creatorHandle}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(video);
  }

  return deduped;
}

async function openTikTokStart(page: Page, query?: string): Promise<void> {
  if (query) {
    await page.goto(`https://www.tiktok.com/search/video?q=${encodeURIComponent(query)}`, {
      waitUntil: "domcontentloaded"
    });
    const videoLink = page.locator('a[href*="/video/"]').first();
    await videoLink.waitFor({ state: "visible", timeout: 30_000 });
    await videoLink.click();
    await page.waitForURL(/\/video\//, { timeout: 20_000 });
    return;
  }

  await page.goto("https://www.tiktok.com/foryou", { waitUntil: "domcontentloaded" });
}

async function waitForTikTokReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      Boolean(
        document.querySelector("video") ||
          document.querySelector('[data-e2e*="video"]') ||
          document.querySelector('a[href*="/video/"]')
      ),
    { timeout: 30_000 }
  );
}

async function waitForTikTokMetadata(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () =>
        Boolean(
          window.location.pathname.match(/\/video\/\d+/) ||
            document.querySelector('[data-e2e*="share"], [aria-label*="Share" i]') ||
            Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"]')).some((anchor) => {
              const rect = anchor.getBoundingClientRect();
              return rect.top < window.innerHeight * 0.8 && rect.bottom > window.innerHeight * 0.2;
            })
        ),
      { timeout: 1_000 }
    );
  } catch {
    await page.waitForTimeout(300);
  }
}

function normalizeTikTokShareUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.replace(/^www\./, "");
    const isTikTokHost = hostname === "tiktok.com" || hostname.endsWith(".tiktok.com");
    const hasVideoPath = /\/video\/\d+/.test(url.pathname);
    const hasShortSharePath =
      (hostname === "tiktok.com" && /^\/t\/[\w-]+\/?$/.test(url.pathname)) ||
      (["vm.tiktok.com", "vt.tiktok.com"].includes(hostname) && url.pathname.length > 1);

    if (!isTikTokHost || (!hasVideoPath && !hasShortSharePath)) {
      return null;
    }

    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function readTikTokUrlFromShareSurface(page: Page): Promise<string | null> {
  const candidates = await page.evaluate(() => {
    const normalizeText = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const values: string[] = [];
    const urlPattern = /https?:\/\/(?:[\w.-]+\.)?tiktok\.com\/[^\s"'<>)]*/gi;
    const roots = Array.from(
      document.querySelectorAll<HTMLElement>('[role="dialog"], [data-e2e*="share"], [aria-label*="share" i]')
    ).filter((element) => {
      const text = normalizeText(element.textContent);
      return visible(element) && /copy link|copied|share/i.test(text);
    });

    for (const root of roots) {
      for (const element of Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"))) {
        const value = normalizeText(element.value);
        if (value.includes("tiktok.com")) {
          values.push(value);
        }
      }

      for (const anchor of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="tiktok.com"]'))) {
        values.push(anchor.href);
      }

      const visibleText = normalizeText(root.innerText);
      for (const match of visibleText.matchAll(urlPattern)) {
        values.push(match[0]);
      }
    }

    return values;
  });

  for (const candidate of candidates) {
    const normalized = normalizeTikTokShareUrl(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

async function markActiveTikTokShareTarget(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const markerAttribute = "data-nigs-tiktok-share-target";
    const rootAttribute = "data-nigs-active-tiktok-root";
    for (const element of Array.from(document.querySelectorAll(`[${markerAttribute}], [${rootAttribute}]`))) {
      element.removeAttribute(markerAttribute);
      element.removeAttribute(rootAttribute);
    }

    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const normalizeText = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();
    const activeVideo = Array.from(document.querySelectorAll<HTMLVideoElement>("video")).find((video) => {
      const rect = video.getBoundingClientRect();
      return rect.top < window.innerHeight * 0.75 && rect.bottom > window.innerHeight * 0.25;
    });

    if (!activeVideo) {
      return false;
    }

    const activeAncestors = Array.from(
      document.querySelectorAll<HTMLElement>('[data-e2e*="recommend-list-item"], article, main div, section')
    ).filter((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return candidate.contains(activeVideo) && rect.height > 100 && rect.height <= window.innerHeight * 1.75;
    });
    const sortedAncestors = activeAncestors.sort(
      (left, right) => left.getBoundingClientRect().height - right.getBoundingClientRect().height
    );
    const active =
      sortedAncestors.find((candidate) => {
        const text = normalizeText(candidate.textContent);
        return text.length > 20 && candidate.querySelector("a[href], [data-e2e]");
      }) ??
      sortedAncestors[0] ??
      activeVideo.parentElement;

    if (!active) {
      return false;
    }

    active.setAttribute(rootAttribute, "true");

    const candidates = Array.from(
      active.querySelectorAll<HTMLElement>(
        'button[data-e2e*="share"], [role="button"][data-e2e*="share"], [data-e2e*="share"], [aria-label*="Share" i]'
      )
    )
      .map((candidate) => candidate.closest<HTMLElement>('button, [role="button"], a') ?? candidate)
      .filter((candidate, index, all) => all.indexOf(candidate) === index)
      .filter((candidate) => {
        const label = [
          candidate.getAttribute("aria-label"),
          candidate.getAttribute("data-e2e"),
          candidate.getAttribute("title"),
          candidate.textContent
        ].join(" ");
        return visible(candidate) && /share/i.test(label);
      })
      .sort((left, right) => {
        const center = window.innerHeight / 2;
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        const leftDistance = Math.abs(leftRect.top + leftRect.height / 2 - center);
        const rightDistance = Math.abs(rightRect.top + rightRect.height / 2 - center);
        return leftDistance - rightDistance;
      });

    const target = candidates[0];
    if (!target) {
      return false;
    }

    target.setAttribute(markerAttribute, "true");
    return true;
  });
}

async function readClipboardTikTokUrl(page: Page): Promise<string | null> {
  try {
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    return normalizeTikTokShareUrl(clipboardText);
  } catch {
    return null;
  }
}

async function copyActiveTikTokShareUrl(page: Page): Promise<string | null> {
  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(page.url()).origin
    });
  } catch {
    // Clipboard permissions are best-effort; the visible share surface can still contain the URL.
  }

  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(100).catch(() => undefined);
  try {
    await page.evaluate(() => navigator.clipboard.writeText(""));
  } catch {
    // Clipboard writes can be blocked before a user-like click; the read fallback below is still useful.
  }

  const hasShareTarget = await markActiveTikTokShareTarget(page);
  if (!hasShareTarget) {
    return null;
  }

  try {
    await page.locator('[data-nigs-tiktok-share-target="true"]').first().click({ timeout: 2_500, force: true });
    await page.waitForTimeout(250);
    await page.waitForFunction(
      () =>
        Boolean(
          document.querySelector('[data-e2e*="copy"], [aria-label*="Copy" i]') ||
            document.body?.innerText.match(/copy link|copied/i)
        ),
      { timeout: 2_000 }
    ).catch(() => undefined);

    try {
      await page.evaluate(() => navigator.clipboard.writeText(""));
    } catch {
      // The copy click below may still replace the clipboard even if clearing it is blocked.
    }

    const copySelectors = [
      'button:has-text("Copy link")',
      '[role="button"]:has-text("Copy link")',
      '[data-e2e*="copy"]',
      '[aria-label*="Copy" i]',
      'text=/Copy link/i'
    ];
    for (const selector of copySelectors) {
      const targets = page.locator(selector);
      const count = await targets.count();
      if (count === 0) {
        continue;
      }

      for (let index = 0; index < Math.min(count, 5); index += 1) {
        const target = targets.nth(index);
        const isVisible = await target.isVisible().catch(() => false);
        if (!isVisible) {
          continue;
        }

        try {
          await target.click({ timeout: 2_000 });
          for (let readAttempt = 0; readAttempt < 10; readAttempt += 1) {
            const normalized = await readClipboardTikTokUrl(page);
            if (normalized) {
              return normalized;
            }
            await page.waitForTimeout(100);
          }
        } catch {
          // Try the next copy target shape; TikTok changes this UI often.
        }
      }
    }

    return await readTikTokUrlFromShareSurface(page);
  } finally {
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(100).catch(() => undefined);
  }
}

async function extractActiveVideo(
  page: Page,
  position: number,
  canonicalShareUrl?: string | null
): Promise<TikTokVideoArtifact | null> {
  return page.evaluate((input) => {
    const { itemPosition, shareUrl } = input;
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
    const findVisibleText = (root: ParentNode, selectors: string[]): string | null => {
      for (const selector of selectors) {
        const element = Array.from(root.querySelectorAll<HTMLElement>(selector)).find(visible);
        const text = normalizeText(element?.innerText || element?.textContent);
        if (text) {
          return text;
        }
      }
      return null;
    };
    const activeVideo = Array.from(document.querySelectorAll<HTMLVideoElement>("video")).find((video) => {
      const rect = video.getBoundingClientRect();
      return rect.top < window.innerHeight * 0.75 && rect.bottom > window.innerHeight * 0.25;
    });
    const activeAncestors = activeVideo
      ? Array.from(document.querySelectorAll<HTMLElement>('[data-e2e*="recommend-list-item"], article, main div, section')).filter(
          (candidate) => {
            const rect = candidate.getBoundingClientRect();
            return candidate.contains(activeVideo) && rect.height > 100 && rect.height <= window.innerHeight * 1.75;
          }
        )
      : [];
    const sortedAncestors = activeAncestors.sort(
      (left, right) => left.getBoundingClientRect().height - right.getBoundingClientRect().height
    );
    const active =
      sortedAncestors.find((candidate) => {
        const text = normalizeText(candidate.textContent);
        return text.length > 20 && candidate.querySelector("a[href], [data-e2e]");
      }) ??
      sortedAncestors[0] ??
      activeVideo?.parentElement ??
      document.body;
    const byE2E = (name: string): string | null =>
      findVisibleText(active, [
        `[data-e2e="${name}"]`,
        `[data-e2e*="${name}"]`
      ]);
    const currentUrl = shareUrl ?? (window.location.pathname.match(/\/video\/\d+/)
      ? window.location.href
      : null);

    if (!currentUrl) {
      return null;
    }

    const url = new URL(currentUrl, window.location.origin).toString();
    const videoId = url.match(/\/video\/(\d+)/)?.[1] ?? null;
    const metaTitle = normalizeText(document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content);
    const metaDescription = normalizeText(document.querySelector<HTMLMetaElement>('meta[property="og:description"]')?.content);
    const desc =
      byE2E("video-desc") ??
      findVisibleText(active, ["[data-e2e='browse-video-desc']", "h1", "h2"]) ??
      (metaDescription || metaTitle || null);
    const visibleText = normalizeText(active.textContent);
    const hashtags = hashtagsFrom(`${desc ?? ""} ${visibleText}`);
    const creatorLink =
      active.querySelector<HTMLAnchorElement>('a[href^="/@"]') ??
      document.querySelector<HTMLAnchorElement>('a[href^="/@"]') ??
      document.querySelector<HTMLAnchorElement>('a[href*="tiktok.com/@"]');
    const creatorUrl = creatorLink ? new URL(creatorLink.href, window.location.origin).toString() : null;
    const creatorHandle = creatorUrl?.match(/@([^/?#]+)/)?.[1] ? `@${creatorUrl.match(/@([^/?#]+)/)?.[1]}` : null;
    const creatorName =
      byE2E("video-author-uniqueid") ??
      (normalizeText(creatorLink?.innerText || creatorLink?.textContent) || creatorHandle);

    if (!url.includes("tiktok.com") || (!desc && hashtags.length === 0)) {
      return null;
    }

    return {
      platform: "tiktok",
      position: itemPosition,
      url,
      videoId,
      title: desc ? stripHashtags(desc).slice(0, 160) || desc : metaTitle || null,
      caption: desc,
      hashtags,
      creatorName: creatorName || null,
      creatorHandle,
      creatorUrl,
      likeCountText: byE2E("like-count"),
      commentCountText: byE2E("comment-count"),
      shareCountText: byE2E("share-count"),
      viewCountText: byE2E("video-views") ?? findVisibleText(active, ["strong[data-e2e*='view']"]),
      collectedAt: new Date().toISOString()
    };
  }, { itemPosition: position, shareUrl: canonicalShareUrl ?? null });
}

export class TikTokService {
  constructor(private readonly browserManager: BrowserSessionManager) {}

  async collectVideos(
    _runContext: RunContext,
    input: { query?: string; limit: number; sessionId?: string }
  ): Promise<TikTokVideoArtifact[]> {
    const page = this.browserManager.getPage(input.sessionId);
    await openTikTokStart(page, input.query);
    await waitForTikTokReady(page);
    if (!/\/video\/\d+/.test(page.url())) {
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(750);
    }

    const videos: TikTokVideoArtifact[] = [];
    const maxAttempts = input.limit * 3;

    try {
      for (let attempt = 0; attempt < maxAttempts && dedupeVideos(videos).length < input.limit; attempt += 1) {
        await waitForTikTokMetadata(page);
        const shareUrl = await copyActiveTikTokShareUrl(page);
        const current = await extractActiveVideo(page, dedupeVideos(videos).length + 1, shareUrl);
        if (current) {
          videos.push(current);
        }

        if (dedupeVideos(videos).length >= input.limit) {
          break;
        }

        const previousUrl = page.url();
        await page.keyboard.press("ArrowDown");
        try {
          await page.waitForFunction((url) => window.location.href !== url, previousUrl, { timeout: 1_000 });
        } catch {
          await page.mouse.wheel(0, 900);
          await page.waitForTimeout(500);
        }
      }
    } catch (error) {
      if (dedupeVideos(videos).length === 0 || !String(error).toLowerCase().includes("closed")) {
        throw error;
      }
    }

    return dedupeVideos(videos).slice(0, input.limit);
  }
}
