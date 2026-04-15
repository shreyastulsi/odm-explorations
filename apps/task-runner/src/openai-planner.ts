import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import {
  AutomationPlanSchema,
  ToolNames,
  type AutomationPlan,
  type LlmProvider,
  type RetryPolicy,
  type TaskRequest,
  type ToolCatalogEntry
} from "@nigs/core";
import { z } from "zod";

interface OpenAIResponsesClientLike {
  responses: {
    create(...args: unknown[]): Promise<{ output_text: string }>;
  };
}

const PlannerRetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(5),
  backoffMs: z.number().int().min(0).max(30_000),
  retryOn: z.array(z.string())
});

const PlannerAutomationPlanSchema = z.object({
  rationale: z.string().nullable(),
  steps: z
    .array(
      z.object({
        tool: z.enum(ToolNames),
        inputJson: z.string(),
        successCriteria: z.string().nullable(),
        retryPolicy: PlannerRetryPolicySchema.nullable()
      })
    )
    .min(1)
    .max(20)
});

const RETRY_ERROR_CODES = [
  "timeout",
  "navigation",
  "network",
  "rate_limit",
  "unknown"
] as const satisfies RetryPolicy["retryOn"];

const RETRY_ERROR_ALIASES: Record<string, RetryPolicy["retryOn"][number]> = {
  connectionerror: "network",
  networkerror: "network",
  neterror: "network",
  transientnetworkerror: "network",
  noresults: "unknown",
  noresult: "unknown",
  emptyresults: "unknown",
  blocked: "unknown",
  captcha: "unknown",
  loginrequired: "unknown",
  ratelimit: "rate_limit",
  rateerror: "rate_limit"
};

function normalizeRetryErrorCode(value: string): RetryPolicy["retryOn"][number] {
  const compact = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const canonical = RETRY_ERROR_CODES.find(
    (code) => code.replace(/[\s_-]+/g, "") === compact
  );

  return canonical ?? RETRY_ERROR_ALIASES[compact] ?? "unknown";
}

function normalizePlannerRetryPolicy(
  retryPolicy: z.infer<typeof PlannerRetryPolicySchema> | null
): RetryPolicy | undefined {
  if (!retryPolicy) {
    return undefined;
  }

  const retryOn = Array.from(new Set(retryPolicy.retryOn.map(normalizeRetryErrorCode)));

  return {
    maxAttempts: retryPolicy.maxAttempts,
    backoffMs: retryPolicy.backoffMs,
    retryOn: retryOn.length > 0 ? retryOn : ["unknown"]
  };
}

function buildDeveloperInstructions(toolCatalog: ToolCatalogEntry[], maxSteps: number): string {
  return [
    "You create execution plans for a deterministic local automation runtime.",
    "Return JSON only, matching the provided schema exactly.",
    "Use only the listed tools. Never invent tools.",
    "Each step must provide inputJson as a JSON object encoded as a string, for example: {\"url\":\"https://example.com\"}.",
    "If the task uses a browser, start with browser_launch.",
    "Use youtube_search_videos for YouTube search, then youtube_open_result for each selected video.",
    "Use youtube_collect_shorts for tasks that ask to scroll through YouTube Shorts or collect Shorts titles/hashtags.",
    "Use youtube_collect_short_transcripts for tasks that ask for transcripts, captions, speech text, or spoken words from YouTube Shorts.",
    "For youtube_collect_shorts, include query only when the user asks for a specific topic or search term.",
    "For youtube_collect_short_transcripts, include shortUrls only when the user provides explicit YouTube Shorts URLs; otherwise use query only for a specific topic/search term.",
    "Use instagram_collect_reels for tasks that ask to collect Instagram Reels captions, hashtags, creators, or engagement.",
    "Use tiktok_collect_videos for tasks that ask to collect TikTok videos captions, hashtags, creators, or engagement.",
    "For Instagram and TikTok collection, include query only when the user asks for a specific topic or search term.",
    "Use messages_open_app and messages_send_text for macOS Messages tasks.",
    "youtube_open_result.resultIndex is 1-based.",
    "If you include retryPolicy.retryOn, use only these values: timeout, navigation, network, rate_limit, unknown.",
    `Keep the plan to at most ${maxSteps} steps.`,
    "Prefer the smallest correct plan that can complete the goal.",
    "",
    "Available tools:",
    JSON.stringify(toolCatalog, null, 2)
  ].join("\n");
}

function buildUserPrompt(request: TaskRequest): string {
  return [
    `Goal: ${request.goal}`,
    `Maximum steps: ${request.maxSteps}`,
    "Create a complete execution plan using only the available tools."
  ].join("\n");
}

export class OpenAIResponsesPlanner implements LlmProvider {
  constructor(
    private readonly client: OpenAIResponsesClientLike,
    private readonly model: string
  ) {}

  async createPlan(
    request: TaskRequest,
    toolCatalog: ToolCatalogEntry[]
  ): Promise<AutomationPlan> {
    const response = await this.client.responses.create({
      model: this.model,
      input: [
        {
          role: "developer",
          content: buildDeveloperInstructions(toolCatalog, request.maxSteps)
        },
        {
          role: "user",
          content: buildUserPrompt(request)
        }
      ],
      text: {
        format: zodTextFormat(PlannerAutomationPlanSchema, "automation_plan")
      }
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.output_text);
    } catch (error) {
      throw new Error(
        `OpenAI planner returned invalid JSON: ${
          error instanceof Error ? error.message : "Unknown parse failure."
        }`
      );
    }

    const parsedPlan = PlannerAutomationPlanSchema.parse({
      rationale:
        parsed && typeof parsed === "object" && "rationale" in parsed
          ? (parsed as { rationale?: string | null }).rationale ?? null
          : null,
      steps:
        parsed && typeof parsed === "object" && "steps" in parsed && Array.isArray((parsed as { steps?: unknown[] }).steps)
          ? (parsed as { steps: Array<Record<string, unknown>> }).steps.map((step) => ({
              tool: step.tool,
              inputJson:
                typeof step.inputJson === "string"
                  ? step.inputJson
                  : JSON.stringify(step.input ?? {}),
              successCriteria: (step.successCriteria as string | null | undefined) ?? null,
              retryPolicy:
                (step.retryPolicy as {
                  maxAttempts: number;
                  backoffMs: number;
                  retryOn: string[];
                } | null | undefined) ?? null
            }))
          : []
    });

    const plan = AutomationPlanSchema.parse({
      rationale: parsedPlan.rationale ?? undefined,
      steps: parsedPlan.steps.map((step) => ({
        tool: step.tool,
        input: parsePlannerInputJson(step.inputJson, step.tool),
        ...(step.successCriteria ? { successCriteria: step.successCriteria } : {}),
        ...(step.retryPolicy ? { retryPolicy: normalizePlannerRetryPolicy(step.retryPolicy) } : {})
      }))
    });
    if (plan.steps.length > request.maxSteps) {
      throw new Error(
        `Planner returned ${plan.steps.length} steps, exceeding the maxSteps limit of ${request.maxSteps}.`
      );
    }

    return plan;
  }
}

function parsePlannerInputJson(inputJson: string, tool: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(inputJson);
  } catch (error) {
    throw new Error(
      `Planner produced invalid inputJson for ${tool}: ${
        error instanceof Error ? error.message : "Unknown JSON parse failure."
      }`
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Planner inputJson for ${tool} must decode to a JSON object.`);
  }

  return parsed as Record<string, unknown>;
}

export function createPlannerFromEnv(): OpenAIResponsesPlanner {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required when no plan file is provided.");
  }

  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";
  const client = new OpenAI({
    apiKey
  });

  return new OpenAIResponsesPlanner(client, model);
}
