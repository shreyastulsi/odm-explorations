#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { loadEnvFile, stdin as input, stdout as output } from "node:process";
import { BrowserSessionManager, createBrowserTools } from "@nigs/browser-playwright";
import { createMessagesTools } from "@nigs/desktop-macos";
import {
  ArtifactStore,
  AutomationPlanSchema,
  createRuntimePaths,
  ensureRuntimePaths,
  PlanExecutor,
  TaskRequestSchema,
  ToolRegistry,
  createArtifactTools,
  summaryToText
} from "@nigs/core";
import { createInstagramTools } from "@nigs/site-instagram";
import { createPornhubTools } from "@nigs/site-pornhub";
import { createTikTokTools } from "@nigs/site-tiktok";
import { createYouTubeTools } from "@nigs/site-youtube";
import { createPlannerFromEnv } from "./openai-planner.js";

try {
  loadEnvFile();
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code !== "ENOENT") {
    throw error;
  }
}

interface CliArgs {
  prompt: string | undefined;
  authSetup: boolean;
  authBrowser: string | undefined;
  authPlatforms: AuthPlatform[];
  dryRun: boolean;
  maxSteps: number | undefined;
  model: string | undefined;
  planFile: string | undefined;
  runtimeDir: string | undefined;
  help: boolean;
}

type AuthPlatform = "youtube" | "instagram" | "tiktok";

const AUTH_PLATFORMS = ["youtube", "instagram", "tiktok"] as const satisfies readonly AuthPlatform[];
const AUTH_PLATFORM_URLS: Record<AuthPlatform, string> = {
  youtube: "https://www.youtube.com/",
  instagram: "https://www.instagram.com/",
  tiktok: "https://www.tiktok.com/"
};

function printUsage(): void {
  console.log(`Usage:
  npm run dev:runner -- --prompt "Go to YouTube and collect the top 3 LeBron James videos"
  npm run dev:runner -- --plan-file ./plan.json --dry-run
  npm run dev:runner -- --auth-setup
  npm run dev:runner -- --auth-setup --auth-browser /path/to/google-chrome
  npm run dev:runner -- --auth-setup --auth-platforms youtube,instagram,tiktok

Options:
  --prompt <text>       Natural-language task prompt
  --plan-file <path>    Execute a prebuilt plan JSON file
  --auth-setup          Open the persistent browser profile for manual sign-in
  --auth-browser <path> Browser executable to use for manual sign-in
  --auth-platforms <csv> Platforms to sign in to: youtube, instagram, tiktok
  --max-steps <number>  Override max steps for planner output
  --dry-run             Create the run and plan without executing tools
  --runtime-dir <path>  Override runtime storage directory
  --help                Print usage`);
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    prompt: undefined,
    authSetup: false,
    authBrowser: undefined,
    authPlatforms: [...AUTH_PLATFORMS],
    dryRun: false,
    maxSteps: undefined,
    model: undefined,
    planFile: undefined,
    runtimeDir: undefined,
    help: false
  };
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) {
      continue;
    }

    switch (value) {
      case "--prompt":
        args.prompt = argv[index + 1];
        index += 1;
        break;
      case "--plan-file":
        args.planFile = argv[index + 1];
        index += 1;
        break;
      case "--auth-setup":
        args.authSetup = true;
        break;
      case "--auth-browser":
        args.authBrowser = argv[index + 1];
        index += 1;
        break;
      case "--auth-platforms":
        args.authPlatforms = parseAuthPlatforms(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--max-steps":
        args.maxSteps = Number(argv[index + 1]);
        index += 1;
        break;
      case "--model":
        args.model = argv[index + 1];
        index += 1;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--runtime-dir":
        args.runtimeDir = argv[index + 1];
        index += 1;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        positional.push(value);
        break;
    }
  }

  if (!args.prompt && positional.length > 0) {
    args.prompt = positional.join(" ");
  }

  return args;
}

function parseAuthPlatforms(value: string): AuthPlatform[] {
  const platforms = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  if (platforms.length === 0) {
    return [...AUTH_PLATFORMS];
  }

  for (const platform of platforms) {
    if (!AUTH_PLATFORMS.includes(platform as AuthPlatform)) {
      throw new Error(`Unsupported auth platform "${platform}". Use: ${AUTH_PLATFORMS.join(", ")}.`);
    }
  }

  return platforms as AuthPlatform[];
}

async function loadPlan(planFile: string) {
  const raw = await readFile(planFile, "utf8");
  return AutomationPlanSchema.parse(JSON.parse(raw));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveBrowserExecutable(requestedPath?: string): Promise<string | null> {
  if (requestedPath) {
    return (await pathExists(requestedPath)) ? requestedPath : null;
  }

  const candidateNames = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "brave-browser"
  ];
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);

  for (const name of candidateNames) {
    for (const entry of pathEntries) {
      const candidate = path.join(entry, name);
      if (await pathExists(candidate)) {
        return candidate;
      }
    }
  }

  const fixedCandidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
  ];

  for (const candidate of fixedCandidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function runAuthSetup(args: CliArgs): Promise<void> {
  const runtimePaths = createRuntimePaths(args.runtimeDir);
  await ensureRuntimePaths(runtimePaths);
  const terminal = createInterface({ input, output });

  try {
    const browserExecutable = await resolveBrowserExecutable(args.authBrowser);
    if (!browserExecutable) {
      throw new Error(
        [
          "Could not find a normal Chrome/Chromium browser for auth setup.",
          "Google often blocks sign-in inside Playwright's automation browser.",
          "Install Google Chrome or Chromium, then rerun with --auth-browser /path/to/browser.",
          `Persistent profile to use: ${runtimePaths.chromeProfileDir}`
        ].join("\n")
      );
    }

    const urls = args.authPlatforms.map((platform) => AUTH_PLATFORM_URLS[platform]);
    const browserProcess = spawn(
      browserExecutable,
      [
        `--user-data-dir=${runtimePaths.chromeProfileDir}`,
        "--no-first-run",
        "--new-window",
        ...urls
      ],
      {
        stdio: "ignore",
        detached: true
      }
    );
    browserProcess.unref();

    console.error(`Using browser: ${browserExecutable}`);
    console.error(`Using persistent profile: ${runtimePaths.chromeProfileDir}`);
    console.error(`Opened: ${args.authPlatforms.join(", ")}`);
    console.error("Sign in manually in the opened browser window.");
    console.error("When finished, close that browser window so cookies are flushed to disk.");
    await terminal.question("After closing the auth browser window, press Enter here to finish... ");
    console.error("\nAuth setup complete. Future runs with the same --runtime-dir will reuse this profile.");
  } finally {
    terminal.close();
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help || (!args.authSetup && !args.prompt && !args.planFile)) {
    printUsage();
    return;
  }

  if (args.authSetup) {
    await runAuthSetup(args);
    return;
  }

  const artifactStore = new ArtifactStore(args.runtimeDir);
  await artifactStore.initialize();

  const browserManager = new BrowserSessionManager(args.runtimeDir);
  const registry = new ToolRegistry();
  registry.registerMany(createBrowserTools(browserManager));
  registry.registerMany(createMessagesTools());
  registry.registerMany(createYouTubeTools(browserManager));
  registry.registerMany(createInstagramTools(browserManager));
  registry.registerMany(createTikTokTools(browserManager));
  registry.registerMany(createPornhubTools(browserManager));
  registry.registerMany(createArtifactTools());

  const taskRequest = TaskRequestSchema.parse({
    goal: args.prompt ?? `Execute plan from ${args.planFile}`,
    maxSteps: args.maxSteps,
    dryRun: args.dryRun
  });

  if (process.env.OPENAI_MODEL === undefined && args.model) {
    process.env.OPENAI_MODEL = args.model;
  }

  const plan = args.planFile
    ? await loadPlan(args.planFile)
    : await createPlannerFromEnv().createPlan(taskRequest, registry.listCatalog());

  const executor = new PlanExecutor(artifactStore, registry, (message, details) => {
    if (details) {
      console.error(message, details);
      return;
    }
    console.error(message);
  });

  try {
    const result = await executor.execute(taskRequest, plan);
    const summaryPath = artifactStore.getRunSummaryPath(result.runId);
    console.log(
      JSON.stringify(
        {
          runId: result.runId,
          summaryPath,
          plan,
          summary: result.summary
        },
        null,
        2
      )
    );
    console.error(summaryToText({ runId: result.runId, summaryPath }));
  } finally {
    await browserManager.closeAll();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
