import { z } from "zod";

export const BrowserToolNames = [
  "browser_launch",
  "browser_goto",
  "browser_click",
  "browser_fill",
  "browser_press",
  "browser_wait_for",
  "browser_read_page"
] as const;

export const YouTubeToolNames = [
  "youtube_search_videos",
  "youtube_open_result",
  "youtube_collect_shorts",
  "youtube_collect_short_transcripts"
] as const;

export const PornhubToolNames = [
  "pornhub_accept_age_gate",
  "pornhub_search_videos",
  "pornhub_capture_screenshot"
] as const;

export const InstagramToolNames = [
  "instagram_collect_reels"
] as const;

export const TikTokToolNames = [
  "tiktok_collect_videos"
] as const;

export const MessagesToolNames = [
  "messages_open_app",
  "messages_send_text"
] as const;

export const ArtifactToolNames = [
  "artifact_list",
  "artifact_read"
] as const;

export const ToolNames = [
  ...BrowserToolNames,
  ...YouTubeToolNames,
  ...PornhubToolNames,
  ...InstagramToolNames,
  ...TikTokToolNames,
  ...MessagesToolNames,
  ...ArtifactToolNames
] as const;

export type ToolName = (typeof ToolNames)[number];

export const TaskModeSchema = z.enum(["plan_and_execute", "plan_only"]);
export const OutputFormatSchema = z.enum(["summary", "json"]);

export const TaskRequestSchema = z.object({
  goal: z.string().min(1, "Goal is required."),
  mode: TaskModeSchema.default("plan_and_execute"),
  outputFormat: OutputFormatSchema.default("summary"),
  maxSteps: z.number().int().min(1).max(20).default(12),
  dryRun: z.boolean().default(false)
});

export const RetryErrorCodeSchema = z.enum([
  "timeout",
  "navigation",
  "network",
  "rate_limit",
  "unknown"
]);

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(5).default(1),
  backoffMs: z.number().int().min(0).max(30_000).default(500),
  retryOn: z.array(RetryErrorCodeSchema).default(["timeout", "navigation", "network"])
});

export const AutomationStepSchema = z.object({
  tool: z.enum(ToolNames),
  input: z.record(z.string(), z.unknown()).default({}),
  successCriteria: z.string().min(1).optional(),
  retryPolicy: RetryPolicySchema.optional()
});

export const AutomationPlanSchema = z.object({
  rationale: z.string().min(1).optional(),
  steps: z.array(AutomationStepSchema).min(1).max(20)
});

export const UiTargetSchema = z
  .object({
    role: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    placeholder: z.string().min(1).optional(),
    css: z.string().min(1).optional(),
    nth: z.number().int().min(0).default(0)
  })
  .refine(
    (value) =>
      Boolean(value.role || value.label || value.text || value.placeholder || value.css),
    "Target requires one of role, label, text, placeholder, or css."
  );

export const BrowserLaunchInputSchema = z.object({
  sessionName: z.string().min(1).optional(),
  headless: z.boolean().default(false),
  slowMoMs: z.number().int().min(0).max(2_000).default(0),
  viewport: z
    .object({
      width: z.number().int().min(800).max(3840),
      height: z.number().int().min(600).max(2160)
    })
    .default({ width: 1440, height: 960 })
});

export const BrowserGotoInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  url: z.string().url()
});

export const BrowserClickInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  target: UiTargetSchema,
  timeoutMs: z.number().int().min(1).max(60_000).default(10_000)
});

export const BrowserFillInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  target: UiTargetSchema,
  value: z.string(),
  clearFirst: z.boolean().default(true),
  timeoutMs: z.number().int().min(1).max(60_000).default(10_000)
});

export const BrowserPressInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  key: z.string().min(1),
  target: UiTargetSchema.optional()
});

export const BrowserWaitForInputSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    target: UiTargetSchema.optional(),
    urlIncludes: z.string().min(1).optional(),
    textIncludes: z.string().min(1).optional(),
    loadState: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
    timeoutMs: z.number().int().min(1).max(60_000).default(15_000)
  })
  .refine(
    (value) =>
      Boolean(value.target || value.urlIncludes || value.textIncludes || value.loadState),
    "Wait input requires target, urlIncludes, textIncludes, or loadState."
  );

export const BrowserReadPageInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  maxChars: z.number().int().min(500).max(100_000).default(10_000)
});

export const YoutubeSearchVideosInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  query: z.string().min(1),
  limit: z.number().int().min(1).max(10).default(3)
});

export const YoutubeOpenResultInputSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    resultIndex: z.number().int().min(1).max(10).optional(),
    videoUrl: z.string().url().optional(),
    includeTranscript: z.boolean().default(true)
  })
  .refine(
    (value) => Boolean(value.resultIndex || value.videoUrl),
    "Provide resultIndex or videoUrl."
  );

export const YoutubeCollectShortsInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).default(20)
});

export const YoutubeCollectShortTranscriptsInputSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    shortUrls: z.array(z.string().url()).min(1).max(50).optional(),
    limit: z.number().int().min(1).max(50).default(20)
  })
  .refine(
    (value) => !(value.query && value.shortUrls),
    "Provide either query or shortUrls, not both."
  );

export const PornhubAcceptAgeGateInputSchema = z.object({
  sessionId: z.string().min(1).optional()
});

export const PornhubSearchVideosInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  query: z.string().min(1),
  limit: z.number().int().min(1).max(10).default(3)
});

export const PornhubCaptureScreenshotInputSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    resultIndex: z.number().int().min(1).max(10).optional(),
    videoUrl: z.string().url().optional(),
    fullPage: z.boolean().default(true)
  })
  .refine(
    (value) => Boolean(value.resultIndex || value.videoUrl),
    "Provide resultIndex or videoUrl."
  );

export const InstagramCollectReelsInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).default(20)
});

export const TikTokCollectVideosInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).default(20)
});

export const MessagesOpenAppInputSchema = z.object({});

export const MessagesSendTextInputSchema = z.object({
  recipientName: z.string().min(1),
  messageText: z.string().min(1),
  serviceType: z.enum(["iMessage", "SMS", "RCS"]).default("iMessage")
});

export const ArtifactListInputSchema = z.object({
  runId: z.string().min(1).optional(),
  type: z.string().min(1).optional()
});

export const ArtifactReadInputSchema = z.object({
  runId: z.string().min(1).optional(),
  artifactId: z.string().min(1)
});

export const ToolResultErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional()
});

export const ToolResultSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  screenshotPath: z.string().min(1).optional(),
  tracePath: z.string().min(1).optional(),
  currentUrl: z.string().min(1).optional(),
  pageTitle: z.string().min(1).optional(),
  artifactIds: z.array(z.string().min(1)).optional(),
  error: ToolResultErrorSchema.optional()
});

export const RunStatusSchema = z.enum(["running", "completed", "failed"]);

export const RunArtifactMetaSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  path: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  mimeType: z.string().min(1),
  createdAt: z.string().datetime(),
  sizeBytes: z.number().int().min(0)
});

export const RunStepRecordSchema = z.object({
  index: z.number().int().min(0),
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  status: z.enum(["running", "completed", "failed"]),
  attemptCount: z.number().int().min(1),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  result: ToolResultSchema.optional(),
  error: ToolResultErrorSchema.optional()
});

export const RunSummarySchema = z.object({
  runId: z.string().min(1),
  taskRequest: TaskRequestSchema,
  plan: AutomationPlanSchema.optional(),
  status: RunStatusSchema,
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  artifacts: z.array(RunArtifactMetaSchema).default([]),
  steps: z.array(RunStepRecordSchema).default([]),
  error: ToolResultErrorSchema.optional()
});

export type TaskRequest = z.infer<typeof TaskRequestSchema>;
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;
export type RetryErrorCode = z.infer<typeof RetryErrorCodeSchema>;
export type AutomationStep = z.infer<typeof AutomationStepSchema>;
export type AutomationPlan = z.infer<typeof AutomationPlanSchema>;
export type UiTarget = z.infer<typeof UiTargetSchema>;
export type BrowserLaunchInput = z.infer<typeof BrowserLaunchInputSchema>;
export type BrowserGotoInput = z.infer<typeof BrowserGotoInputSchema>;
export type BrowserClickInput = z.infer<typeof BrowserClickInputSchema>;
export type BrowserFillInput = z.infer<typeof BrowserFillInputSchema>;
export type BrowserPressInput = z.infer<typeof BrowserPressInputSchema>;
export type BrowserWaitForInput = z.infer<typeof BrowserWaitForInputSchema>;
export type BrowserReadPageInput = z.infer<typeof BrowserReadPageInputSchema>;
export type YoutubeSearchVideosInput = z.infer<typeof YoutubeSearchVideosInputSchema>;
export type YoutubeOpenResultInput = z.infer<typeof YoutubeOpenResultInputSchema>;
export type YoutubeCollectShortsInput = z.infer<typeof YoutubeCollectShortsInputSchema>;
export type YoutubeCollectShortTranscriptsInput = z.infer<typeof YoutubeCollectShortTranscriptsInputSchema>;
export type PornhubAcceptAgeGateInput = z.infer<typeof PornhubAcceptAgeGateInputSchema>;
export type PornhubSearchVideosInput = z.infer<typeof PornhubSearchVideosInputSchema>;
export type PornhubCaptureScreenshotInput = z.infer<typeof PornhubCaptureScreenshotInputSchema>;
export type InstagramCollectReelsInput = z.infer<typeof InstagramCollectReelsInputSchema>;
export type TikTokCollectVideosInput = z.infer<typeof TikTokCollectVideosInputSchema>;
export type MessagesOpenAppInput = z.infer<typeof MessagesOpenAppInputSchema>;
export type MessagesSendTextInput = z.infer<typeof MessagesSendTextInputSchema>;
export type ArtifactListInput = z.infer<typeof ArtifactListInputSchema>;
export type ArtifactReadInput = z.infer<typeof ArtifactReadInputSchema>;
export type ToolResultError = z.infer<typeof ToolResultErrorSchema>;
export type ToolResult<TData = unknown> = Omit<z.infer<typeof ToolResultSchema>, "data"> & {
  data?: TData;
};
export type RunArtifactMeta = z.infer<typeof RunArtifactMetaSchema>;
export type RunStepRecord = z.infer<typeof RunStepRecordSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;

export interface RunArtifact<TContent = unknown> extends RunArtifactMeta {
  content: TContent;
}

export interface LlmProvider {
  createPlan(
    request: TaskRequest,
    toolCatalog: ToolCatalogEntry[]
  ): Promise<AutomationPlan>;
}

export interface ToolCatalogEntry {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
