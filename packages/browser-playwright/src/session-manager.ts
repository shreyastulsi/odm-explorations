import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, BrowserContext, Page } from "playwright";
import type {
  BrowserClickInput,
  BrowserFillInput,
  BrowserGotoInput,
  BrowserLaunchInput,
  BrowserPressInput,
  BrowserReadPageInput,
  BrowserWaitForInput,
  ToolResult
} from "@nigs/core";
import { createRuntimePaths, ensureRuntimePaths, RuntimePaths } from "@nigs/core";
import { describeTarget, resolveLocator } from "./locator.js";

type LaunchPersistentContextOptions = NonNullable<
  Parameters<typeof chromium.launchPersistentContext>[1]
>;

interface BrowserSession {
  id: string;
  runId: string;
  context: BrowserContext;
  page: Page;
  artifactsDir: string;
}

export interface BrowserLaunchResult {
  sessionId: string;
  currentUrl: string;
  pageTitle: string;
}

export interface BrowserPageSnapshot {
  title: string;
  url: string;
  text: string;
  headings: string[];
  links: Array<{
    text: string;
    url: string;
  }>;
}

function isMissingChromeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Chromium distribution 'chrome' is not found") ||
    message.includes("/opt/google/chrome/chrome")
  );
}

export class BrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSession>();
  private activeSessionId: string | undefined;
  readonly runtimePaths: RuntimePaths;

  constructor(rootDir?: string) {
    this.runtimePaths = createRuntimePaths(rootDir);
  }

  async initialize(): Promise<void> {
    await ensureRuntimePaths(this.runtimePaths);
  }

  async closeAll(): Promise<void> {
    const sessions = Array.from(this.sessions.values());
    for (const session of sessions) {
      try {
        await session.context.close();
      } catch {
        // Ignore cleanup failures.
      }
    }
    this.sessions.clear();
    this.activeSessionId = undefined;
  }

  async launch(runId: string, input: BrowserLaunchInput): Promise<BrowserLaunchResult> {
    await this.initialize();

    if (this.activeSessionId) {
      const current = this.sessions.get(this.activeSessionId);
      if (current) {
        return {
          sessionId: current.id,
          currentUrl: current.page.url(),
          pageTitle: await current.page.title()
        };
      }
    }

    const sessionId = input.sessionName ?? randomUUID();
    const artifactsDir = path.join(this.runtimePaths.artifactsRoot, runId, "browser", sessionId);
    await mkdir(artifactsDir, { recursive: true });

    const context = await this.launchPersistentContext({
      headless: input.headless,
      slowMo: input.slowMoMs,
      viewport: input.viewport
    });

    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(15_000);
    context.setDefaultTimeout(15_000);

    try {
      await context.tracing.start({ screenshots: true, snapshots: true });
    } catch {
      // Tracing is best-effort for local runs.
    }

    const session: BrowserSession = {
      id: sessionId,
      runId,
      context,
      page,
      artifactsDir
    };

    this.sessions.set(sessionId, session);
    this.activeSessionId = sessionId;

    return {
      sessionId,
      currentUrl: page.url(),
      pageTitle: await page.title()
    };
  }

  async goto(runId: string, input: BrowserGotoInput): Promise<ToolResult> {
    const session = this.getSession(input.sessionId);
    await session.page.goto(input.url, { waitUntil: "domcontentloaded" });
    await this.waitForNetworkIdle(session.page);
    return this.captureResult(runId, session, "browser-goto", {
      ok: true,
      data: {
        url: session.page.url()
      }
    });
  }

  async click(runId: string, input: BrowserClickInput): Promise<ToolResult> {
    const session = this.getSession(input.sessionId);
    const locator = resolveLocator(session.page, input.target);
    await locator.click({ timeout: input.timeoutMs });
    await this.waitForNetworkIdle(session.page);
    return this.captureResult(runId, session, "browser-click", {
      ok: true,
      data: {
        target: describeTarget(input.target)
      }
    });
  }

  async fill(runId: string, input: BrowserFillInput): Promise<ToolResult> {
    const session = this.getSession(input.sessionId);
    const locator = resolveLocator(session.page, input.target);
    await locator.click({ timeout: input.timeoutMs });
    if (input.clearFirst) {
      await locator.fill("", { timeout: input.timeoutMs });
    }
    await locator.fill(input.value, { timeout: input.timeoutMs });
    return this.captureResult(runId, session, "browser-fill", {
      ok: true,
      data: {
        target: describeTarget(input.target)
      }
    });
  }

  async press(runId: string, input: BrowserPressInput): Promise<ToolResult> {
    const session = this.getSession(input.sessionId);

    if (input.target) {
      await resolveLocator(session.page, input.target).click();
    }

    await session.page.keyboard.press(input.key);
    await this.waitForNetworkIdle(session.page);

    return this.captureResult(runId, session, "browser-press", {
      ok: true,
      data: {
        key: input.key
      }
    });
  }

  async waitFor(runId: string, input: BrowserWaitForInput): Promise<ToolResult> {
    const session = this.getSession(input.sessionId);
    const timeout = input.timeoutMs;

    if (input.loadState) {
      await session.page.waitForLoadState(input.loadState, { timeout });
    }

    if (input.target) {
      await resolveLocator(session.page, input.target).waitFor({ state: "visible", timeout });
    }

    if (input.urlIncludes) {
      await session.page.waitForFunction(
        (needle) => window.location.href.includes(needle),
        input.urlIncludes,
        { timeout }
      );
    }

    if (input.textIncludes) {
      await session.page.getByText(input.textIncludes, { exact: false }).first().waitFor({
        state: "visible",
        timeout
      });
    }

    return this.captureResult(runId, session, "browser-wait-for", {
      ok: true,
      data: input
    });
  }

  async readPage(runId: string, input: BrowserReadPageInput): Promise<ToolResult<BrowserPageSnapshot>> {
    const session = this.getSession(input.sessionId);
    const snapshot = await session.page.evaluate((maxChars) => {
      const title = document.title;
      const url = window.location.href;
      const text = (document.body?.innerText ?? "").trim().slice(0, maxChars);
      const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
        .map((element) => element.textContent?.trim() ?? "")
        .filter(Boolean)
        .slice(0, 20);
      const links = Array.from(document.querySelectorAll("a[href]"))
        .map((element) => {
          const anchor = element as HTMLAnchorElement;
          return {
            text: anchor.textContent?.trim().replace(/\s+/g, " ") ?? "",
            url: anchor.href
          };
        })
        .filter((link) => link.url.startsWith("http"))
        .slice(0, 80);

      return {
        title,
        url,
        text,
        headings,
        links
      };
    }, input.maxChars);

    return this.captureResult<BrowserPageSnapshot>(runId, session, "browser-read-page", {
      ok: true,
      data: snapshot
    });
  }

  async snapshot(
    runId: string,
    label: string,
    sessionId?: string
  ): Promise<Pick<ToolResult, "screenshotPath" | "tracePath" | "currentUrl" | "pageTitle">> {
    const session = this.getSession(sessionId);
    const result = await this.captureResult(runId, session, label, { ok: true });
    return {
      screenshotPath: result.screenshotPath,
      tracePath: result.tracePath,
      currentUrl: result.currentUrl,
      pageTitle: result.pageTitle
    };
  }

  getActiveSessionId(): string | undefined {
    return this.activeSessionId;
  }

  getCurrentPageInfo(sessionId?: string): { currentUrl: string; pageTitle: Promise<string> } {
    const session = this.getSession(sessionId);
    return {
      currentUrl: session.page.url(),
      pageTitle: session.page.title()
    };
  }

  getPage(sessionId?: string): Page {
    return this.getSession(sessionId).page;
  }

  private async launchPersistentContext(
    options: LaunchPersistentContextOptions
  ): Promise<BrowserContext> {
    try {
      return await chromium.launchPersistentContext(this.runtimePaths.chromeProfileDir, {
        ...options,
        channel: "chrome"
      });
    } catch (error) {
      if (!isMissingChromeError(error)) {
        throw error;
      }

      return chromium.launchPersistentContext(this.runtimePaths.chromeProfileDir, options);
    }
  }

  private getSession(sessionId?: string): BrowserSession {
    const resolvedId = sessionId ?? this.activeSessionId;
    if (!resolvedId) {
      throw new Error("Browser session has not been launched.");
    }

    const session = this.sessions.get(resolvedId);
    if (!session) {
      throw new Error(`Browser session ${resolvedId} not found.`);
    }

    return session;
  }

  private async waitForNetworkIdle(page: Page): Promise<void> {
    try {
      await page.waitForLoadState("networkidle", { timeout: 5_000 });
    } catch {
      // Some pages keep long-lived connections open.
    }
  }

  private async captureResult<TData = unknown>(
    runId: string,
    session: BrowserSession,
    label: string,
    result: ToolResult<TData>
  ): Promise<ToolResult<TData>> {
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const screenshotPath = path.join(session.artifactsDir, `${timestamp}-${label}.png`);
    const tracePath = path.join(session.artifactsDir, `${timestamp}-${label}.zip`);

    await session.page.screenshot({ path: screenshotPath, fullPage: true });

    let finalTracePath: string | undefined;
    try {
      await session.context.tracing.stop({ path: tracePath });
      await session.context.tracing.start({ screenshots: true, snapshots: true });
      finalTracePath = tracePath;
    } catch {
      finalTracePath = undefined;
    }

    const pageTitle = await session.page.title();
    const { data, ...rest } = result;
    const enrichedData =
      data && typeof data === "object"
        ? ({
            ...(data as object),
            runId
          } as TData)
        : data;

    return {
      ...rest,
      screenshotPath,
      currentUrl: session.page.url(),
      pageTitle,
      ...(finalTracePath ? { tracePath: finalTracePath } : {}),
      ...(enrichedData !== undefined ? { data: enrichedData } : {})
    };
  }
}
