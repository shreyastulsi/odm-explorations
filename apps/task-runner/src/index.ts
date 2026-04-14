#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { BrowserSessionManager, createBrowserTools } from "@nigs/browser-playwright";
import { createMessagesTools } from "@nigs/desktop-macos";
import {
  ArtifactStore,
  AutomationPlanSchema,
  PlanExecutor,
  TaskRequestSchema,
  ToolRegistry,
  createArtifactTools,
  summaryToText
} from "@nigs/core";
import { createPornhubTools } from "@nigs/site-pornhub";
import { createYouTubeTools } from "@nigs/site-youtube";
import { createPlannerFromEnv } from "./openai-planner.js";

interface CliArgs {
  prompt: string | undefined;
  dryRun: boolean;
  maxSteps: number | undefined;
  model: string | undefined;
  planFile: string | undefined;
  runtimeDir: string | undefined;
  help: boolean;
}

function printUsage(): void {
  console.log(`Usage:
  npm run dev:runner -- --prompt "Go to YouTube and collect the top 3 LeBron James videos"
  npm run dev:runner -- --plan-file ./plan.json --dry-run

Options:
  --prompt <text>       Natural-language task prompt
  --plan-file <path>    Execute a prebuilt plan JSON file
  --max-steps <number>  Override max steps for planner output
  --dry-run             Create the run and plan without executing tools
  --runtime-dir <path>  Override runtime storage directory
  --help                Print usage`);
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    prompt: undefined,
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

async function loadPlan(planFile: string) {
  const raw = await readFile(planFile, "utf8");
  return AutomationPlanSchema.parse(JSON.parse(raw));
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help || (!args.prompt && !args.planFile)) {
    printUsage();
    return;
  }

  const artifactStore = new ArtifactStore(args.runtimeDir);
  await artifactStore.initialize();

  const browserManager = new BrowserSessionManager(args.runtimeDir);
  const registry = new ToolRegistry();
  registry.registerMany(createBrowserTools(browserManager));
  registry.registerMany(createMessagesTools());
  registry.registerMany(createYouTubeTools(browserManager));
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
  console.error(error);
  process.exitCode = 1;
});
