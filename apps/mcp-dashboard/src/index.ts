#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import OpenAI from "openai";
import { BrowserSessionManager, createBrowserTools } from "@nigs/browser-playwright";
import { createMessagesTools } from "@nigs/desktop-macos";
import {
  ArtifactStore,
  AutomationPlanSchema,
  createArtifactTools,
  createRuntimePaths,
  RunSummarySchema,
  ToolRegistry,
  type RunSummary,
  type ToolCatalogEntry,
  type ToolName
} from "@nigs/core";
import { createInstagramTools } from "@nigs/site-instagram";
import { createPornhubTools } from "@nigs/site-pornhub";
import { createTikTokTools } from "@nigs/site-tiktok";
import { createYouTubeTools } from "@nigs/site-youtube";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");
const projectRoot = path.resolve(__dirname, "../../..");
const execFileAsync = promisify(execFile);

try {
  loadEnvFile(path.join(projectRoot, ".env"));
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code !== "ENOENT") {
    throw error;
  }
}

interface DashboardRun {
  runId: string;
  status: RunSummary["status"];
  goal: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  stepCount: number;
  completedStepCount: number;
  failedStepCount: number;
  artifactCount: number;
  artifactTypes: string[];
  latestScreenshotUrl: string | null;
}

interface PrimitiveGroup {
  group: string;
  tools: Array<{
    name: string;
    title: string;
    description: string;
  }>;
}

interface AgentJobEvent {
  at: string;
  level: "info" | "error";
  message: string;
  details?: unknown;
}

type AgentValidationStatus = "passed" | "warning" | "failed" | "recovered" | "skipped";
type AgentValidationKind = "tool_result" | "source_discovery" | "semantic_page" | "recovery";

interface AgentValidationRecord {
  id: string;
  at: string;
  kind: AgentValidationKind;
  status: AgentValidationStatus;
  title: string;
  summary: string;
  tool?: ToolName;
  sourceUrl?: string;
  confidence?: number;
  evidence?: string[];
  details?: unknown;
}

interface AgentJob {
  id: string;
  prompt: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  runId: string | null;
  sessionId: string;
  plan: AgentPlan | null;
  plannerMode: "llm" | "deterministic_fallback" | null;
  finalAnswer: string | null;
  validations: AgentValidationRecord[];
  events: AgentJobEvent[];
  error: string | null;
}

interface AgentPlanStep {
  tool: ToolName;
  input: Record<string, unknown>;
  purpose: string;
  successCriteria: string;
}

interface AgentPlan {
  mode: "direct_tool" | "composed_tools" | "generic_browser" | "cannot_complete";
  planner: "llm" | "deterministic_fallback";
  rationale: string;
  confidence: number;
  warnings: string[];
  assumptions: string[];
  missingCapabilities: string[];
  finalizer: "none" | "summarize_transcripts" | "summarize_artifacts";
  steps: AgentPlanStep[];
}

interface StepValidation {
  ok: boolean;
  warnings: string[];
}

interface ToolCallRecord {
  step: AgentPlanStep;
  structured: Record<string, unknown> | null;
  excludeFromFinal?: boolean;
}

interface CallStepOptions {
  skipAdvancedValidation?: boolean;
  excludeFromFinal?: boolean;
  validationContext?: string;
}

const jobs = new Map<string, AgentJob>();

const mimeTypes = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".zip", "application/zip"]
]);

function getPort(): number {
  const value = process.env.PORT;
  if (!value) {
    return 4173;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 4173;
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function now(): string {
  return new Date().toISOString();
}

function addJobEvent(job: AgentJob, level: AgentJobEvent["level"], message: string, details?: unknown): void {
  const event: AgentJobEvent = {
    at: now(),
    level,
    message,
    ...(details !== undefined ? { details } : {})
  };
  job.events.push(event);
  job.updatedAt = event.at;
}

function addJobValidation(
  job: AgentJob,
  validation: Omit<AgentValidationRecord, "id" | "at">
): AgentValidationRecord {
  const record: AgentValidationRecord = {
    id: randomId("validation"),
    at: now(),
    ...validation
  };
  job.validations.push(record);
  job.updatedAt = record.at;
  addJobEvent(job, record.status === "failed" ? "error" : "info", `${record.title}: ${record.status}.`, record);
  return record;
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function parseCount(prompt: string, patterns: RegExp[], fallback: number): number {
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    const value = Number(match?.[1]);
    if (Number.isInteger(value) && value > 0 && value <= 50) {
      return value;
    }
  }
  return fallback;
}

function parseRequestedCount(prompt: string): number {
  const normalized = prompt.toLowerCase();
  const wordCounts = new Map([
    ["one", 1],
    ["two", 2],
    ["three", 3],
    ["four", 4],
    ["five", 5]
  ]);
  for (const [word, count] of wordCounts) {
    if (new RegExp(`\\b${word}\\b`).test(normalized)) {
      return count;
    }
  }
  return parseCount(normalized, [/\bcollect\s+(\d+)\b/, /\bopen\s+(?:up\s+)?(\d+)\b/, /\brun\s+(\d+)\b/], 3);
}

function isFullFormYouTubeRequest(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return /\byoutube\b/.test(normalized) && (
    /\bnot\s+(?:youtube\s+)?shorts?\b/.test(normalized) ||
    /\bfull[-\s]?form\b/.test(normalized) ||
    /\btranscripts?\b/.test(normalized) ||
    /\bvideos?\b/.test(normalized)
  );
}

function extractYouTubeQuery(prompt: string): string {
  const withoutQuotes = prompt.match(/"([^"]+)"/)?.[1] ?? prompt.match(/'([^']+)'/)?.[1];
  if (withoutQuotes) {
    return withoutQuotes;
  }

  const match =
    prompt.match(/(?:open(?: up)?|summarize|collect)\s+(?:\w+\s+)?(.+?)\s+youtube\s+videos?/i) ??
    prompt.match(/(.+?)\s+youtube\s+videos?/i);
  const candidate = match?.[1]
    ?.replace(/\b(one|two|three|four|five|\d+)\b/gi, "")
    .replace(/\btranscripts?\b/gi, "")
    .replace(/\bnot\s+shorts?\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return candidate || "YouTube videos";
}

function planCollectors(prompt: string): AgentPlanStep[] {
  const normalized = prompt.toLowerCase();
  const mentionsYouTube = /\b(youtube|yt|shorts?)\b/.test(normalized);
  const mentionsTikTok = /\b(tiktok|tik tok|tiktoks?)\b/.test(normalized);
  const mentionsInstagram = /\b(instagram|ig|reels?)\b/.test(normalized);
  const mentionsAnyPlatform = mentionsYouTube || mentionsTikTok || mentionsInstagram;
  const requestsShortFormBundle =
    /\b(short[-\s]?form|personalized feeds?|social feeds?)\b/.test(normalized) &&
    /\b(collect|gather|capture|run|scrape|pull)\b/.test(normalized);
  const fallbackLimit = parseCount(normalized, [/\bcollect\s+(\d+)\b/, /\brun\s+(\d+)\b/], 3);
  const collectors: AgentPlanStep[] = [];

  if (!mentionsAnyPlatform && !requestsShortFormBundle) {
    throw new Error(
      "No deterministic MCP workflow matched this prompt. Ask for explicit supported platforms, or set OPENAI_API_KEY so the planner can compose generic browser tools."
    );
  }

  if (mentionsYouTube || requestsShortFormBundle) {
    collectors.push({
      tool: "youtube_collect_shorts",
      input: {
        limit: parseCount(normalized, [/(\d+)\s+(?:youtube|yt)?\s*shorts?\b/], fallbackLimit)
      },
      purpose: "Collect personalized YouTube Shorts.",
      successCriteria: "The result contains the requested number of unique Shorts and writes a youtube-shorts artifact."
    });
  }
  if (mentionsTikTok || requestsShortFormBundle) {
    collectors.push({
      tool: "tiktok_collect_videos",
      input: {
        limit: parseCount(normalized, [/(\d+)\s+(?:tik\s*tok|tiktok|tiktoks?)\b/], fallbackLimit)
      },
      purpose: "Collect personalized TikTok videos.",
      successCriteria: "The result contains the requested number of unique TikToks and writes a tiktok-videos artifact."
    });
  }
  if (mentionsInstagram || requestsShortFormBundle) {
    collectors.push({
      tool: "instagram_collect_reels",
      input: {
        limit: parseCount(normalized, [/(\d+)\s+(?:instagram|ig)?\s*reels?\b/], fallbackLimit)
      },
      purpose: "Collect personalized Instagram Reels.",
      successCriteria: "The result contains the requested number of unique Reels and writes an instagram-reels artifact."
    });
  }

  if (collectors.length === 0) {
    throw new Error("I can currently start MCP collection runs for YouTube Shorts, Instagram Reels, and TikTok prompts.");
  }

  return collectors;
}

function deterministicFallbackPlan(prompt: string): AgentPlan {
  const steps: AgentPlanStep[] = [
    {
      tool: "browser_launch",
      input: {
        headless: false,
        slowMoMs: 50,
        viewport: { width: 1280, height: 900 }
      },
      purpose: "Start the persistent browser profile for this run.",
      successCriteria: "The result includes a sessionId."
    }
  ];

  if (isFullFormYouTubeRequest(prompt)) {
    const limit = parseRequestedCount(prompt);
    steps.push({
      tool: "youtube_search_videos",
      input: {
        query: extractYouTubeQuery(prompt),
        limit
      },
      purpose: "Search for normal YouTube videos that match the request.",
      successCriteria: `The search result returns at least ${limit} normal YouTube videos.`
    });
    for (let index = 1; index <= limit; index += 1) {
      steps.push({
        tool: "youtube_open_result",
        input: {
          resultIndex: index,
          includeTranscript: /\btranscripts?|summar/i.test(prompt)
        },
        purpose: `Open full YouTube result ${index} and extract metadata${/\btranscripts?|summar/i.test(prompt) ? " plus transcript" : ""}.`,
        successCriteria: "The result includes a watch URL and title."
      });
    }
    steps.push({
      tool: "artifact_list",
      input: {},
      purpose: "List artifacts created by the run.",
      successCriteria: "The artifact list includes the created YouTube video artifacts."
    });
    return {
      mode: "composed_tools",
      planner: "deterministic_fallback",
      rationale: "The prompt asks for full YouTube videos, so the fallback composes search plus open-result tools rather than using Shorts.",
      confidence: 0.72,
      warnings: ["Planner model was not used; this deterministic fallback covers common YouTube full-video and feed collection requests."],
      assumptions: ["Top organic YouTube search results are acceptable unless the prompt says otherwise."],
      missingCapabilities: /\bsummar/i.test(prompt) ? ["No dedicated MCP transcript summarization tool exists yet; the dashboard will write a final summary artifact."] : [],
      finalizer: /\bsummar/i.test(prompt) ? "summarize_transcripts" : "none",
      steps
    };
  }

  steps.push(...planCollectors(prompt));
  steps.push({
    tool: "artifact_list",
    input: {},
    purpose: "List artifacts created by the run.",
    successCriteria: "The artifact list includes each expected collection artifact."
  });

  return {
    mode: "direct_tool",
    planner: "deterministic_fallback",
    rationale: "The prompt matches the known short-form collection workflow.",
    confidence: 0.7,
    warnings: ["Planner model was not used; unsupported nuanced tasks may need OPENAI_API_KEY for full agentic planning."],
    assumptions: ["Personalized feeds should use the persistent browser profile."],
    missingCapabilities: [],
    finalizer: "none",
    steps
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

interface PageLink {
  text: string;
  url: string;
}

interface PageSnapshot {
  title: string;
  url: string;
  text: string;
  headings: string[];
  links: PageLink[];
}

interface SemanticPageAssessment {
  relevant: boolean;
  confidence: number;
  summary: string;
  evidence: string[];
  missing: string[];
  suggestedSearchQuery: string | null;
}

interface RecoveryCandidate {
  url: string;
  reason: string;
  confidence: number;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pageSnapshotFromStructured(structured: Record<string, unknown> | null): PageSnapshot {
  const data = isRecord(structured?.data) ? structured.data : {};
  const links = Array.isArray(data.links)
    ? data.links
        .filter(isRecord)
        .map((link) => ({
          text: stringValue(link.text),
          url: stringValue(link.url)
        }))
        .filter((link) => link.url.startsWith("http"))
    : [];

  return {
    title: stringValue(data.title),
    url: stringValue(data.url),
    text: stringValue(data.text),
    headings: asStringArray(data.headings),
    links
  };
}

function parseJsonObjectFromText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    const trimmed = value.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) {
      return JSON.parse(fenced);
    }

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }

    throw new Error("No JSON object found.");
  }
}

function coerceSemanticAssessment(value: unknown): SemanticPageAssessment {
  const record = isRecord(value) ? value : {};
  const confidence = typeof record.confidence === "number"
    ? Math.max(0, Math.min(1, record.confidence))
    : 0;
  return {
    relevant: record.relevant === true,
    confidence,
    summary: typeof record.summary === "string" ? record.summary : "Semantic relevance was assessed.",
    evidence: asStringArray(record.evidence).slice(0, 6),
    missing: asStringArray(record.missing).slice(0, 6),
    suggestedSearchQuery:
      typeof record.suggestedSearchQuery === "string" && record.suggestedSearchQuery.trim()
        ? record.suggestedSearchQuery.trim()
        : null
  };
}

const STOP_WORDS = new Set([
  "a",
  "about",
  "all",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "find",
  "for",
  "from",
  "go",
  "how",
  "in",
  "into",
  "is",
  "it",
  "link",
  "main",
  "of",
  "on",
  "or",
  "page",
  "read",
  "source",
  "summarize",
  "summary",
  "that",
  "the",
  "to",
  "up",
  "use",
  "with"
]);

function tokenizeForValidation(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
    )
  );
}

function fallbackSemanticAssessment(prompt: string, page: PageSnapshot): SemanticPageAssessment {
  const promptTerms = tokenizeForValidation(prompt);
  const pageHaystack = `${page.title} ${page.url} ${page.headings.join(" ")} ${page.text.slice(0, 20_000)}`.toLowerCase();
  const hits = promptTerms.filter((term) => pageHaystack.includes(term));
  const confidence = promptTerms.length > 0 ? hits.length / promptTerms.length : 0;
  const relevant = confidence >= 0.35 || hits.length >= 3;
  const missing = promptTerms.filter((term) => !hits.includes(term)).slice(0, 6);

  return {
    relevant,
    confidence: Math.min(1, confidence),
    summary: relevant
      ? `Heuristic match found ${hits.length}/${promptTerms.length} meaningful prompt terms in the page.`
      : `Heuristic match found only ${hits.length}/${promptTerms.length} meaningful prompt terms in the page.`,
    evidence: hits.slice(0, 6),
    missing,
    suggestedSearchQuery: buildFallbackSearchQuery(prompt)
  };
}

async function validatePageSemantics(prompt: string, page: PageSnapshot): Promise<SemanticPageAssessment> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !page.text.trim()) {
    return fallbackSemanticAssessment(prompt, page);
  }

  try {
    const client = new OpenAI({ apiKey });
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
      input: [
        {
          role: "developer",
          content: [
            "You validate whether a browser-read page satisfies the user's requested source/content.",
            "Use only the provided title, URL, headings, and visible text.",
            "Return JSON only with this shape:",
            "{ relevant:boolean, confidence:number, summary:string, evidence:string[], missing:string[], suggestedSearchQuery:string|null }.",
            "Set relevant=false when the page loaded but does not answer the user's requested source/content.",
            "Evidence must be short quotes or concrete visible-page facts."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            request: prompt,
            page: {
              title: page.title,
              url: page.url,
              headings: page.headings,
              text: page.text.slice(0, 60_000)
            }
          })
        }
      ]
    });
    return coerceSemanticAssessment(parseJsonObjectFromText(response.output_text));
  } catch {
    return fallbackSemanticAssessment(prompt, page);
  }
}

function validationStatusFromSemantic(assessment: SemanticPageAssessment): AgentValidationStatus {
  if (assessment.relevant && assessment.confidence >= 0.55) {
    return "passed";
  }
  if (assessment.relevant && assessment.confidence >= 0.35) {
    return "warning";
  }
  return "failed";
}

function needsSemanticPageValidation(prompt: string, plan: AgentPlan | null): boolean {
  return (
    plan?.finalizer === "summarize_artifacts" ||
    /\b(documentation|docs?|article|page|source|research|summarize|read|find)\b/i.test(prompt)
  );
}

function isSearchUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return ["duckduckgo.com", "google.com", "bing.com"].some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function normalizeUrlForComparison(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/$/, "");
  }
}

function buildFallbackSearchQuery(prompt: string): string {
  const normalized = prompt.replace(/[^\w\s.-]/g, " ").replace(/\s+/g, " ").trim();
  if (/\bplaywright\b/i.test(prompt) && !/\bsite:/i.test(prompt)) {
    return `site:playwright.dev/docs ${normalized}`;
  }
  return normalized || prompt;
}

async function createRecoverySearchQuery(prompt: string, failedPage: PageSnapshot, assessment: SemanticPageAssessment): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return assessment.suggestedSearchQuery ?? buildFallbackSearchQuery(prompt);
  }

  try {
    const client = new OpenAI({ apiKey });
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
      input: [
        {
          role: "developer",
          content: [
            "Create one web search query to recover from a wrong or weak source page.",
            "Prefer site-restricted queries when the user named a source or product.",
            "Return JSON only: { query:string }."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            request: prompt,
            failedPage: {
              title: failedPage.title,
              url: failedPage.url,
              headings: failedPage.headings
            },
            validation: assessment
          })
        }
      ]
    });
    const parsed = parseJsonObjectFromText(response.output_text);
    if (isRecord(parsed) && typeof parsed.query === "string" && parsed.query.trim()) {
      return parsed.query.trim();
    }
  } catch {
    // Fall through to the deterministic query.
  }

  return assessment.suggestedSearchQuery ?? buildFallbackSearchQuery(prompt);
}

function linkCandidatesFromPage(page: PageSnapshot): PageLink[] {
  const seen = new Set<string>();
  const candidates: PageLink[] = [];
  for (const link of page.links) {
    if (!link.url.startsWith("http") || isSearchUrl(link.url)) {
      continue;
    }
    const normalized = normalizeUrlForComparison(link.url);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    candidates.push(link);
  }
  return candidates.slice(0, 30);
}

function scoreCandidate(prompt: string, candidate: PageLink): number {
  const terms = tokenizeForValidation(prompt);
  const haystack = `${candidate.text} ${candidate.url}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += 1;
    }
  }
  if (/\bplaywright\b/i.test(prompt) && candidate.url.includes("playwright.dev/docs")) {
    score += 4;
  }
  if (candidate.url.includes("/docs/")) {
    score += 1;
  }
  return score;
}

async function chooseRecoveryCandidate(
  prompt: string,
  failedPage: PageSnapshot,
  searchPage: PageSnapshot
): Promise<RecoveryCandidate | null> {
  const candidates = linkCandidatesFromPage(searchPage);
  if (candidates.length === 0) {
    return null;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    try {
      const client = new OpenAI({ apiKey });
      const response = await client.responses.create({
        model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
        input: [
          {
            role: "developer",
            content: [
              "Choose the best source URL from the provided browser search links.",
              "Return JSON only: { url:string|null, reason:string, confidence:number }.",
              "Choose null if none of the links are likely to satisfy the request."
            ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({
              request: prompt,
              failedPage: {
                title: failedPage.title,
                url: failedPage.url
              },
              candidates
            })
          }
        ]
      });
      const parsed = parseJsonObjectFromText(response.output_text);
      if (isRecord(parsed) && typeof parsed.url === "string" && parsed.url) {
        const normalizedChoice = normalizeUrlForComparison(parsed.url);
        const match = candidates.find((candidate) => normalizeUrlForComparison(candidate.url) === normalizedChoice);
        if (match) {
          return {
            url: match.url,
            reason: typeof parsed.reason === "string" ? parsed.reason : "Selected by the recovery model.",
            confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5
          };
        }
      }
    } catch {
      // Fall back to deterministic link scoring.
    }
  }

  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(prompt, candidate)
    }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  if (!best || best.score <= 0) {
    return null;
  }

  return {
    url: best.candidate.url,
    reason: `Highest deterministic link score (${best.score}).`,
    confidence: Math.min(0.8, best.score / 8)
  };
}

function coerceAgentPlan(value: unknown, planner: AgentPlan["planner"]): AgentPlan {
  if (!isRecord(value)) {
    throw new Error("Planner returned a non-object response.");
  }

  const rawSteps = Array.isArray(value.steps) ? value.steps : [];
  const steps = rawSteps.map((step, index): AgentPlanStep => {
    if (!isRecord(step)) {
      throw new Error(`Planner step ${index + 1} is not an object.`);
    }
    if (typeof step.tool !== "string") {
      throw new Error(`Planner step ${index + 1} is missing a tool name.`);
    }
    return {
      tool: step.tool as ToolName,
      input: isRecord(step.input) ? step.input : {},
      purpose: typeof step.purpose === "string" ? step.purpose : `Run ${step.tool}.`,
      successCriteria:
        typeof step.successCriteria === "string"
          ? step.successCriteria
          : "The tool returns a successful structured result."
    };
  });

  return {
    mode:
      value.mode === "direct_tool" || value.mode === "composed_tools" || value.mode === "generic_browser" || value.mode === "cannot_complete"
        ? value.mode
        : "composed_tools",
    planner,
    rationale: typeof value.rationale === "string" ? value.rationale : "Planner returned a tool sequence.",
    confidence: typeof value.confidence === "number" ? Math.max(0, Math.min(1, value.confidence)) : 0.5,
    warnings: asStringArray(value.warnings),
    assumptions: asStringArray(value.assumptions),
    missingCapabilities: asStringArray(value.missingCapabilities),
    finalizer:
      value.finalizer === "summarize_transcripts" || value.finalizer === "summarize_artifacts"
        ? value.finalizer
        : "none",
    steps
  };
}

async function createLlmPlan(prompt: string, toolCatalog: ToolCatalogEntry[]): Promise<AgentPlan> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set.");
  }

  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";
  const client = new OpenAI({ apiKey });
  const toolSummary = toolCatalog.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema
  }));

  const response = await client.responses.create({
    model,
    input: [
      {
        role: "developer",
        content: [
          "You are an agent planner for a local MCP browser automation runtime.",
          "Return JSON only. Do not wrap it in Markdown.",
          "Use only tools in the provided catalog. Never invent a tool.",
          "If a request can be completed by composing lower-level tools, compose them.",
          "If no exact high-level tool exists, prefer safe existing tools over pretending.",
          "If generic browser tools are enough, use browser_goto/browser_click/browser_read_page style steps.",
          "Always include browser_launch before browser-dependent tools.",
          "Use sessionId '{{sessionId}}' for browser-dependent tools and sessionName '{{sessionId}}' for browser_launch.",
          "Respect explicit negations. If the user says not Shorts, do not use youtube_collect_shorts.",
          "For normal YouTube videos, use youtube_search_videos then youtube_open_result.",
          "For transcript requests on normal YouTube videos, set includeTranscript true on youtube_open_result.",
          "For summarization requests, do not invent a summarization tool. Set finalizer to summarize_transcripts or summarize_artifacts.",
          "If the tools cannot complete the task, set mode to cannot_complete and explain missingCapabilities.",
          "Output shape: { mode, rationale, confidence, warnings, assumptions, missingCapabilities, finalizer, steps }.",
          "Each step shape: { tool, input, purpose, successCriteria }."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          prompt,
          availableTools: toolSummary
        })
      }
    ]
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.output_text);
  } catch (error) {
    throw new Error(`Planner returned invalid JSON: ${error instanceof Error ? error.message : "Unknown parse error."}`);
  }

  return coerceAgentPlan(parsed, "llm");
}

function usesBrowserTool(tool: ToolName): boolean {
  return (
    tool.startsWith("browser_") ||
    tool.startsWith("youtube_") ||
    tool.startsWith("instagram_") ||
    tool.startsWith("tiktok_") ||
    tool.startsWith("pornhub_")
  );
}

function normalizePlanForSession(plan: AgentPlan, sessionId: string): AgentPlan {
  const steps = plan.steps.map((step) => {
    const input = { ...step.input };
    if (step.tool === "browser_launch") {
      input.sessionName = sessionId;
      input.headless = input.headless ?? false;
      input.slowMoMs = input.slowMoMs ?? 50;
      input.viewport = input.viewport ?? { width: 1280, height: 900 };
    } else if (usesBrowserTool(step.tool)) {
      input.sessionId = input.sessionId === "{{sessionId}}" || !input.sessionId ? sessionId : input.sessionId;
    }
    return { ...step, input };
  });

  if (steps.some((step) => usesBrowserTool(step.tool)) && !steps.some((step) => step.tool === "browser_launch")) {
    steps.unshift({
      tool: "browser_launch",
      input: {
        sessionName: sessionId,
        headless: false,
        slowMoMs: 50,
        viewport: { width: 1280, height: 900 }
      },
      purpose: "Start the persistent browser profile for this run.",
      successCriteria: "The result includes a sessionId."
    });
  }

  if (steps.length > 0 && !steps.some((step) => step.tool === "artifact_list")) {
    steps.push({
      tool: "artifact_list",
      input: {},
      purpose: "List artifacts created by the run.",
      successCriteria: "The artifact list includes the saved outputs for the run."
    });
  }

  let finalizer = plan.finalizer;
  const warnings = [...plan.warnings];
  const hasBrowserRead = steps.some((step) => step.tool === "browser_read_page");
  const hasYouTubeTranscript =
    steps.some((step) => step.tool === "youtube_collect_short_transcripts") ||
    steps.some((step) => step.tool === "youtube_open_result" && step.input.includeTranscript === true);
  if (finalizer === "summarize_transcripts" && hasBrowserRead && !hasYouTubeTranscript) {
    finalizer = "summarize_artifacts";
    warnings.push("Planner requested transcript summarization for a browser page; normalized to artifact summarization.");
  }

  return {
    ...plan,
    warnings,
    finalizer,
    steps
  };
}

function validatePlan(prompt: string, plan: AgentPlan, registry: ToolRegistry): AgentPlan {
  if (plan.mode === "cannot_complete") {
    throw new Error(`Planner says the task cannot be completed: ${plan.missingCapabilities.join("; ") || plan.rationale}`);
  }

  if (/\bnot\s+(?:youtube\s+)?shorts?\b/i.test(prompt) && plan.steps.some((step) => step.tool === "youtube_collect_shorts")) {
    throw new Error("Planner violated the user constraint: the prompt said not to use YouTube Shorts.");
  }

  const hasYouTubeStep = plan.steps.some((step) => step.tool.startsWith("youtube_"));
  const asksForTranscript = /\b(transcripts?|captions?|closed captions?|spoken words?|speech text)\b/i.test(prompt);
  const asksForVideoSummary =
    /\b(summarize|summary)\b/i.test(prompt) && /\b(youtube|videos?|shorts?)\b/i.test(prompt);
  const needsTranscriptStep = hasYouTubeStep && (
    asksForTranscript ||
    asksForVideoSummary ||
    plan.finalizer === "summarize_transcripts"
  );

  if (needsTranscriptStep) {
    const extractsTranscript = plan.steps.some(
      (step) =>
        step.tool === "youtube_collect_short_transcripts" ||
        (step.tool === "youtube_open_result" && step.input.includeTranscript === true)
    );
    if (!extractsTranscript) {
      throw new Error("Planner did not include any transcript extraction step.");
    }
  }

  for (const step of plan.steps) {
    const definition = registry.get(step.tool);
    definition.inputSchema.parse(step.input);
  }

  AutomationPlanSchema.parse({
    rationale: plan.rationale,
    steps: plan.steps.map((step) => ({
      tool: step.tool,
      input: step.input,
      successCriteria: step.successCriteria
    }))
  });

  return plan;
}

function rememberRejectedPlan(job: AgentJob, plan: AgentPlan, reason: string): void {
  job.plan = plan;
  job.plannerMode = plan.planner;
  addJobEvent(job, "error", "Agent plan rejected.", {
    reason,
    plan
  });
}

async function createAgentPlan(prompt: string, registry: ToolRegistry, job: AgentJob): Promise<AgentPlan> {
  try {
    const plan = normalizePlanForSession(await createLlmPlan(prompt, registry.listCatalog()), job.sessionId);
    addJobEvent(job, "info", "LLM planner created a plan.", plan);
    try {
      return validatePlan(prompt, plan, registry);
    } catch (validationError) {
      const message = validationError instanceof Error ? validationError.message : "Unknown validation failure.";
      rememberRejectedPlan(job, plan, message);
      throw validationError;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown planner failure.";
    addJobEvent(job, "info", "Planner model unavailable or invalid; using deterministic fallback.", { reason: message });
    let fallback: AgentPlan;
    try {
      fallback = normalizePlanForSession(deterministicFallbackPlan(prompt), job.sessionId);
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : "Unknown fallback planning failure.";
      const rejectedPlan: AgentPlan = {
        mode: "cannot_complete",
        planner: "deterministic_fallback",
        rationale: "The planner could not produce a safe executable MCP tool plan for this prompt.",
        confidence: 1,
        warnings: [message],
        assumptions: [],
        missingCapabilities: [fallbackMessage],
        finalizer: "none",
        steps: []
      };
      rememberRejectedPlan(job, rejectedPlan, fallbackMessage);
      throw new Error(`No executable agent plan is available: ${fallbackMessage}`);
    }

    try {
      return validatePlan(prompt, fallback, registry);
    } catch (validationError) {
      const validationMessage = validationError instanceof Error ? validationError.message : "Unknown validation failure.";
      rememberRejectedPlan(job, fallback, validationMessage);
      throw validationError;
    }
  }
}

function getNestedArray(structured: Record<string, unknown> | null, path: string[]): unknown[] {
  let current: unknown = structured;
  for (const segment of path) {
    if (!isRecord(current)) {
      return [];
    }
    current = current[segment];
  }
  return Array.isArray(current) ? current : [];
}

function validateStepResult(step: AgentPlanStep, structured: Record<string, unknown> | null): StepValidation {
  const warnings: string[] = [];
  const data = isRecord(structured?.data) ? structured.data : {};
  const expectedLimit = typeof step.input.limit === "number" ? step.input.limit : null;

  if (step.tool === "browser_launch" && typeof data.sessionId !== "string") {
    return { ok: false, warnings: ["browser_launch did not return a sessionId."] };
  }

  if (step.tool === "youtube_search_videos") {
    const results = getNestedArray(structured, ["data", "results"]);
    if (expectedLimit !== null && results.length < expectedLimit) {
      warnings.push(`Search returned ${results.length}/${expectedLimit} requested results.`);
    }
    return { ok: results.length > 0, warnings };
  }

  if (step.tool === "youtube_open_result") {
    const hasUrl = typeof data.url === "string" && data.url.includes("youtube.com/watch");
    const wantsTranscript = step.input.includeTranscript === true;
    if (wantsTranscript && !data.transcriptText) {
      warnings.push("Transcript was requested, but YouTube did not expose transcript text for this video.");
    }
    return { ok: hasUrl, warnings };
  }

  if (step.tool === "browser_goto") {
    return { ok: typeof data.url === "string" && data.url.length > 0, warnings };
  }

  if (step.tool === "browser_read_page") {
    const hasText = typeof data.text === "string" && data.text.trim().length > 0;
    return { ok: hasText, warnings: hasText ? warnings : ["The page read returned no visible text."] };
  }

  const collectionPaths: Partial<Record<ToolName, string[]>> = {
    youtube_collect_shorts: ["data", "shorts"],
    youtube_collect_short_transcripts: ["data", "shorts"],
    instagram_collect_reels: ["data", "reels"],
    tiktok_collect_videos: ["data", "videos"]
  };
  const collectionPath = collectionPaths[step.tool];
  if (collectionPath) {
    const items = getNestedArray(structured, collectionPath);
    if (expectedLimit !== null && items.length < expectedLimit) {
      warnings.push(`Collected ${items.length}/${expectedLimit} requested items.`);
    }
    return { ok: expectedLimit === null ? items.length > 0 : items.length > 0, warnings };
  }

  if (step.tool === "artifact_list") {
    const artifacts = getNestedArray(structured, ["data", "artifacts"]);
    return { ok: artifacts.length > 0, warnings: artifacts.length > 0 ? warnings : ["No artifacts were listed."] };
  }

  return { ok: Boolean(structured?.ok ?? true), warnings };
}

function priorPageLinksContainUrl(priorCalls: ToolCallRecord[], url: string): boolean {
  const normalized = normalizeUrlForComparison(url);
  return priorCalls.some((call) => {
    if (call.step.tool !== "browser_read_page") {
      return false;
    }
    return pageSnapshotFromStructured(call.structured).links.some(
      (link) => normalizeUrlForComparison(link.url) === normalized
    );
  });
}

function recordSourceDiscoveryForGoto(
  job: AgentJob,
  step: AgentPlanStep,
  structured: Record<string, unknown> | null,
  priorCalls: ToolCallRecord[],
  context: string | undefined
): void {
  if (step.tool !== "browser_goto") {
    return;
  }

  const data = isRecord(structured?.data) ? structured.data : {};
  const url = stringValue(data.url) || stringValue(step.input.url);
  if (!url) {
    return;
  }

  if (isSearchUrl(url)) {
    addJobValidation(job, {
      kind: "source_discovery",
      status: "passed",
      title: "Discovery surface opened",
      summary: "The browser navigated to a search page so candidate sources can be discovered from visible links.",
      tool: step.tool,
      sourceUrl: url,
      details: { context }
    });
    return;
  }

  const wasDiscovered = priorPageLinksContainUrl(priorCalls, url);
  addJobValidation(job, {
    kind: "source_discovery",
    status: wasDiscovered ? "passed" : context === "recovery_candidate" ? "recovered" : "warning",
    title: wasDiscovered ? "Source URL discovered" : "Source URL assumed",
    summary: wasDiscovered
      ? "The navigated URL was present in an earlier page-read link set."
      : "The URL came from the planner or recovery selector rather than a prior browser-discovered link; semantic validation must confirm it.",
    tool: step.tool,
    sourceUrl: url,
    details: {
      context,
      wasDiscovered
    }
  });
}

type CallStepFunction = (step: AgentPlanStep, options?: CallStepOptions) => Promise<ToolCallRecord>;

async function attemptPageRecovery(
  job: AgentJob,
  failedRecord: ToolCallRecord,
  failedAssessment: SemanticPageAssessment,
  callStep: CallStepFunction
): Promise<boolean> {
  const failedPage = pageSnapshotFromStructured(failedRecord.structured);
  failedRecord.excludeFromFinal = true;
  const query = await createRecoverySearchQuery(job.prompt, failedPage, failedAssessment);
  const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;

  addJobValidation(job, {
    kind: "recovery",
    status: "warning",
    title: "Recovery search planned",
    summary: `Semantic validation failed, so the runner will search for a better source using: ${query}`,
    ...(failedPage.url ? { sourceUrl: failedPage.url } : {}),
    details: {
      query,
      failedPage: {
        title: failedPage.title,
        url: failedPage.url
      }
    }
  });

  await callStep(
    {
      tool: "browser_goto",
      input: {
        sessionId: job.sessionId,
        url: searchUrl
      },
      purpose: "Search the web for a better source after semantic validation failed.",
      successCriteria: "The search results page loads."
    },
    {
      skipAdvancedValidation: true,
      excludeFromFinal: true,
      validationContext: "recovery_search"
    }
  );
  const searchRead = await callStep(
    {
      tool: "browser_read_page",
      input: {
        sessionId: job.sessionId,
        maxChars: 40_000
      },
      purpose: "Read search results and extract candidate source links.",
      successCriteria: "Search result links are visible to the browser."
    },
    {
      skipAdvancedValidation: true,
      excludeFromFinal: true,
      validationContext: "recovery_search_results"
    }
  );

  const searchPage = pageSnapshotFromStructured(searchRead.structured);
  const candidateLinks = linkCandidatesFromPage(searchPage);
  addJobValidation(job, {
    kind: "source_discovery",
    status: candidateLinks.length > 0 ? "passed" : "failed",
    title: "Candidate sources discovered",
    summary: candidateLinks.length > 0
      ? `Found ${candidateLinks.length} candidate source links in the search results.`
      : "No usable source links were found in the search results.",
    ...(searchPage.url ? { sourceUrl: searchPage.url } : {}),
    details: {
      candidateCount: candidateLinks.length,
      sampleCandidates: candidateLinks.slice(0, 5)
    }
  });

  const candidate = await chooseRecoveryCandidate(job.prompt, failedPage, searchPage);
  if (!candidate) {
    addJobValidation(job, {
      kind: "recovery",
      status: "failed",
      title: "Recovery candidate rejected",
      summary: "No candidate source looked relevant enough to continue.",
      details: {
        query,
        candidateCount: candidateLinks.length
      }
    });
    return false;
  }

  addJobValidation(job, {
    kind: "recovery",
    status: "warning",
    title: "Recovery candidate selected",
    summary: candidate.reason,
    sourceUrl: candidate.url,
    confidence: candidate.confidence
  });

  await callStep(
    {
      tool: "browser_goto",
      input: {
        sessionId: job.sessionId,
        url: candidate.url
      },
      purpose: "Navigate to the recovered candidate source.",
      successCriteria: "The recovered candidate page loads."
    },
    {
      skipAdvancedValidation: true,
      validationContext: "recovery_candidate"
    }
  );
  const recoveredRead = await callStep(
    {
      tool: "browser_read_page",
      input: {
        sessionId: job.sessionId,
        maxChars: 40_000
      },
      purpose: "Read the recovered candidate page for semantic validation.",
      successCriteria: "The recovered candidate page returns visible text."
    },
    {
      skipAdvancedValidation: true,
      validationContext: "recovery_candidate"
    }
  );

  const recoveredPage = pageSnapshotFromStructured(recoveredRead.structured);
  const recoveredAssessment = await validatePageSemantics(job.prompt, recoveredPage);
  const recoveredStatus = validationStatusFromSemantic(recoveredAssessment);
  const ok = recoveredStatus === "passed" || recoveredStatus === "warning";
  recoveredRead.excludeFromFinal = !ok;
  addJobValidation(job, {
    kind: "semantic_page",
    status: ok ? "recovered" : "failed",
    title: ok ? "Semantic page validation recovered" : "Recovered page still failed semantic validation",
    summary: recoveredAssessment.summary,
    tool: "browser_read_page",
    sourceUrl: recoveredPage.url || candidate.url,
    confidence: recoveredAssessment.confidence,
    evidence: recoveredAssessment.evidence,
    details: {
      missing: recoveredAssessment.missing,
      suggestedSearchQuery: recoveredAssessment.suggestedSearchQuery
    }
  });

  return ok;
}

function compactTranscript(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractSentences(value: string, maxSentences: number): string {
  const sentences = compactTranscript(value)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.slice(0, maxSentences).join(" ") || compactTranscript(value).slice(0, 700);
}

async function summarizeTranscriptWithModel(title: string, transcript: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !transcript.trim()) {
    return null;
  }

  try {
    const client = new OpenAI({ apiKey });
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
      input: [
        {
          role: "developer",
          content: "Summarize the transcript in 4 concise bullets. Preserve concrete claims and examples."
        },
        {
          role: "user",
          content: JSON.stringify({
            title,
            transcript: transcript.slice(0, 80_000)
          })
        }
      ]
    });
    return response.output_text.trim() || null;
  } catch {
    return null;
  }
}

async function summarizePageWithModel(prompt: string, title: string, url: string | null, text: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !text.trim()) {
    return null;
  }

  try {
    const client = new OpenAI({ apiKey });
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
      input: [
        {
          role: "developer",
          content: [
            "Answer the user's browser research request using only the provided page text.",
            "Be concise and concrete.",
            "Include the source URL when one is provided.",
            "If the page text is insufficient, say what is missing."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            request: prompt,
            source: {
              title,
              url,
              text: text.slice(0, 80_000)
            }
          })
        }
      ]
    });
    return response.output_text.trim() || null;
  } catch {
    return null;
  }
}

async function writeFinalReport(
  artifactStore: ArtifactStore,
  job: AgentJob,
  calls: ToolCallRecord[]
): Promise<void> {
  if (!job.runId || !job.plan || job.plan.finalizer === "none") {
    return;
  }

  if (job.plan.finalizer === "summarize_artifacts") {
    const pageCalls = calls.filter((call) => call.step.tool === "browser_read_page" && !call.excludeFromFinal);
    const pages = await Promise.all(
      pageCalls.map(async (call) => {
        const data = isRecord(call.structured?.data) ? call.structured.data : {};
        const title = typeof data.title === "string" ? data.title : "Untitled page";
        const url = typeof data.url === "string" ? data.url : null;
        const text = typeof data.text === "string" ? data.text : "";
        const modelSummary = await summarizePageWithModel(job.prompt, title, url, text);
        return {
          title,
          url,
          textAvailable: Boolean(text.trim()),
          summaryProvider: modelSummary ? "openai" : "extractive_fallback",
          summary: modelSummary ?? (text ? extractSentences(text, 7) : "No readable page text was available.")
        };
      })
    );

    const finalAnswer = pages
      .map((page, index) => {
        const urlLine = page.url ? `\nSource: ${page.url}` : "";
        return `${index + 1}. ${page.title}${urlLine}\n${page.summary}`;
      })
      .join("\n\n");

    job.finalAnswer = finalAnswer || "No readable page artifacts were produced.";
    const artifact = await artifactStore.writeArtifact(job.runId, {
      type: "agent-final-report",
      content: {
        prompt: job.prompt,
        plannerMode: job.plannerMode,
        finalizer: job.plan.finalizer,
        validations: job.validations,
        pages,
        finalAnswer: job.finalAnswer,
        createdAt: now()
      }
    });
    addJobEvent(job, "info", "Wrote final agent report artifact.", { artifactId: artifact.id });
    return;
  }

  const videoCalls = calls.filter((call) => call.step.tool === "youtube_open_result" && !call.excludeFromFinal);
  const videos = await Promise.all(
    videoCalls.map(async (call) => {
      const data = isRecord(call.structured?.data) ? call.structured.data : {};
      const title = typeof data.title === "string" ? data.title : "Untitled video";
      const transcriptText = typeof data.transcriptText === "string" ? data.transcriptText : "";
      const modelSummary = await summarizeTranscriptWithModel(title, transcriptText);
      return {
        title,
        url: typeof data.url === "string" ? data.url : null,
        channel: typeof data.channel === "string" ? data.channel : null,
        transcriptAvailable: Boolean(transcriptText),
        summaryProvider: modelSummary ? "openai" : "extractive_fallback",
        summary: modelSummary ?? (transcriptText ? extractSentences(transcriptText, 5) : "Transcript was unavailable for this video.")
      };
    })
  );

  const finalAnswer = videos
    .map((video, index) => {
      const urlLine = video.url ? `\nURL: ${video.url}` : "";
      return `${index + 1}. ${video.title}${urlLine}\n${video.summary}`;
    })
    .join("\n\n");

  job.finalAnswer = finalAnswer || "No summarizable artifacts were produced.";
  const artifact = await artifactStore.writeArtifact(job.runId, {
    type: "agent-final-report",
    content: {
      prompt: job.prompt,
      plannerMode: job.plannerMode,
      finalizer: job.plan.finalizer,
      validations: job.validations,
      videos,
      finalAnswer: job.finalAnswer,
      createdAt: now()
    }
  });
  addJobEvent(job, "info", "Wrote final agent report artifact.", { artifactId: artifact.id });
}

async function listDescendantPids(rootPid: number): Promise<number[]> {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid="]);
  const childrenByParent = new Map<number, number[]>();

  for (const line of stdout.split("\n")) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
      continue;
    }
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }

  const descendants: number[] = [];
  const visit = (pid: number): void => {
    for (const child of childrenByParent.get(pid) ?? []) {
      descendants.push(child);
      visit(child);
    }
  };
  visit(rootPid);
  return descendants;
}

async function killProcessTree(rootPid: number | null): Promise<void> {
  if (!rootPid) {
    return;
  }

  const descendants = await listDescendantPids(rootPid).catch(() => []);
  const pids = [...descendants.reverse(), rootPid];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Ignore processes that already exited.
    }
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 600);
  });
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore processes that already exited.
    }
  }
}

function startAgentJob(prompt: string): AgentJob {
  const job: AgentJob = {
    id: randomId("job"),
    prompt,
    status: "queued",
    createdAt: now(),
    updatedAt: now(),
    finishedAt: null,
    runId: null,
    sessionId: randomId("dashboard-mcp"),
    plan: null,
    plannerMode: null,
    finalAnswer: null,
    validations: [],
    events: [],
    error: null
  };
  jobs.set(job.id, job);
  void runAgentJob(job);
  return job;
}

async function runAgentJob(job: AgentJob): Promise<void> {
  const artifactStore = new ArtifactStore();
  const registry = buildRegistry();
  const calls: ToolCallRecord[] = [];
  let transport: StdioClientTransport | null = null;
  let client: Client | null = null;
  let transportPid: number | null = null;
  let xvfb: ChildProcess | null = null;

  job.status = "running";

  try {
    const plan = await createAgentPlan(job.prompt, registry, job);
    job.plan = plan;
    job.plannerMode = plan.planner;
    addJobEvent(job, "info", "Agent plan accepted.", plan);

    const display = `:${100 + Math.floor(Math.random() * 1000)}`;
    xvfb = spawn("Xvfb", [display, "-screen", "0", "1280x1024x24", "-nolisten", "tcp"], {
      stdio: "ignore"
    });
    addJobEvent(job, "info", "Started Xvfb display.", { display, pid: xvfb.pid });
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });

    transport = new StdioClientTransport({
      command: "npm",
      args: ["run", "dev:mcp", "--silent"],
      cwd: projectRoot,
      env: {
        DISPLAY: display
      },
      stderr: "pipe"
    });
    client = new Client({ name: "dashboard-agent-runner", version: "0.1.0" });
    transport.stderr?.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        addJobEvent(job, "info", "MCP stderr", message.slice(0, 600));
      }
    });

    addJobEvent(job, "info", "Starting fresh MCP server process.");
    await client.connect(transport);
    transportPid = transport.pid;
    let recoveryAttempted = false;

    const runAdvancedValidation = async (record: ToolCallRecord, options?: CallStepOptions): Promise<void> => {
      if (record.step.tool === "browser_goto") {
        const priorCalls = calls.filter((call) => call !== record);
        recordSourceDiscoveryForGoto(job, record.step, record.structured, priorCalls, options?.validationContext);
      }

      if (
        record.step.tool !== "browser_read_page" ||
        options?.skipAdvancedValidation ||
        !needsSemanticPageValidation(job.prompt, job.plan)
      ) {
        return;
      }

      const page = pageSnapshotFromStructured(record.structured);
      if (isSearchUrl(page.url)) {
        record.excludeFromFinal = true;
        addJobValidation(job, {
          kind: "source_discovery",
          status: page.links.length > 0 ? "passed" : "warning",
          title: "Search results inspected",
          summary: page.links.length > 0
            ? `Search page returned ${page.links.length} links for candidate-source discovery.`
            : "Search page loaded, but no links were extracted.",
          tool: record.step.tool,
          ...(page.url ? { sourceUrl: page.url } : {}),
          details: {
            linkCount: page.links.length,
            sampleLinks: page.links.slice(0, 5)
          }
        });
        return;
      }

      const assessment = await validatePageSemantics(job.prompt, page);
      const status = validationStatusFromSemantic(assessment);
      const ok = status === "passed" || status === "warning";
      addJobValidation(job, {
        kind: "semantic_page",
        status,
        title: "Semantic page validation",
        summary: assessment.summary,
        tool: record.step.tool,
        ...(page.url ? { sourceUrl: page.url } : {}),
        confidence: assessment.confidence,
        evidence: assessment.evidence,
        details: {
          missing: assessment.missing,
          suggestedSearchQuery: assessment.suggestedSearchQuery
        }
      });

      if (ok) {
        return;
      }

      if (!recoveryAttempted) {
        recoveryAttempted = true;
        const recovered = await attemptPageRecovery(job, record, assessment, callStep);
        if (recovered) {
          return;
        }
      }

      record.excludeFromFinal = true;
      throw new Error(`Semantic validation failed for ${page.url || "the page"}: ${assessment.summary}`);
    };

    async function callStep(step: AgentPlanStep, options?: CallStepOptions): Promise<ToolCallRecord> {
      addJobEvent(job, "info", `Calling ${step.tool}.`, step.input);
      const result = await client!.callTool({ name: step.tool, arguments: step.input });
      if (result.isError) {
        const content = Array.isArray(result.content) ? result.content : [];
        const textContent = content
          .map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text ?? "" : JSON.stringify(part)))
          .join("\n");
        throw new Error(textContent || `${step.tool} failed.`);
      }
      addJobEvent(job, "info", `${step.tool} completed.`, result.structuredContent ?? null);
      const structured = isRecord(result.structuredContent) ? result.structuredContent : null;
      const validation = validateStepResult(step, structured);
      addJobValidation(job, {
        kind: "tool_result",
        status: validation.ok ? (validation.warnings.length > 0 ? "warning" : "passed") : "failed",
        title: `Tool result validation for ${step.tool}`,
        summary: validation.ok
          ? validation.warnings.join(" ") || "The tool returned the minimum structured data expected for this step."
          : validation.warnings.join(" ") || "The tool did not return the minimum structured data expected for this step.",
        tool: step.tool,
        details: validation
      });
      if (!validation.ok) {
        throw new Error(`Validation failed for ${step.tool}: ${validation.warnings.join("; ")}`);
      }
      const record: ToolCallRecord = {
        step,
        structured,
        ...(options?.excludeFromFinal ? { excludeFromFinal: true } : {})
      };
      calls.push(record);
      if (!job.runId) {
        job.runId = await readLatestRunId();
        if (job.runId) {
          addJobEvent(job, "info", "Run id resolved.", { runId: job.runId });
        }
      }
      await runAdvancedValidation(record, options);
      return record;
    }

    for (const step of plan.steps) {
      await callStep(step);
    }

    await writeFinalReport(artifactStore, job, calls);

    if (job.runId) {
      await artifactStore.completeRun(job.runId);
      addJobEvent(job, "info", "Marked run completed.", { runId: job.runId });
    }

    job.status = "completed";
    job.finishedAt = now();
    job.updatedAt = job.finishedAt;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown run failure.";
    job.status = "failed";
    job.error = message;
    job.finishedAt = now();
    job.updatedAt = job.finishedAt;
    addJobEvent(job, "error", message);
    if (job.runId) {
      await artifactStore.failRun(job.runId, {
        code: "unknown",
        message
      }).catch(() => undefined);
    }
  } finally {
    if (client) {
      await client.close().catch(() => undefined);
    } else if (transport) {
      await transport.close().catch(() => undefined);
    }
    await killProcessTree(transportPid).catch(() => undefined);
    await killProcessTree(xvfb?.pid ?? null).catch(() => undefined);
    addJobEvent(
      job,
      "info",
      transportPid || transport || client ? "MCP server process stopped." : "No MCP server process was started."
    );
  }
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body, null, 2));
}

function text(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(body);
}

function buildRegistry(): ToolRegistry {
  const browserManager = new BrowserSessionManager();
  const registry = new ToolRegistry();
  registry.registerMany(createBrowserTools(browserManager));
  registry.registerMany(createMessagesTools());
  registry.registerMany(createYouTubeTools(browserManager));
  registry.registerMany(createInstagramTools(browserManager));
  registry.registerMany(createTikTokTools(browserManager));
  registry.registerMany(createPornhubTools(browserManager));
  registry.registerMany(createArtifactTools());
  return registry;
}

function groupTools(registry: ToolRegistry): PrimitiveGroup[] {
  const groupFor = (name: string): string => {
    if (name.startsWith("browser_")) {
      return "Browser";
    }
    if (name.startsWith("youtube_")) {
      return "YouTube";
    }
    if (name.startsWith("instagram_")) {
      return "Instagram";
    }
    if (name.startsWith("tiktok_")) {
      return "TikTok";
    }
    if (name.startsWith("artifact_")) {
      return "Artifacts";
    }
    if (name.startsWith("messages_")) {
      return "Messages";
    }
    if (name.startsWith("pornhub_")) {
      return "Pornhub";
    }
    return "Other";
  };

  const groups = new Map<string, PrimitiveGroup>();
  for (const tool of registry.listCatalog()) {
    const group = groupFor(tool.name);
    const current = groups.get(group) ?? { group, tools: [] };
    current.tools.push({
      name: tool.name,
      title: tool.title,
      description: tool.description
    });
    groups.set(group, current);
  }

  return Array.from(groups.values());
}

function fileUrl(filePath: string | undefined): string | null {
  if (!filePath) {
    return null;
  }
  return `/api/file?path=${encodeURIComponent(filePath)}`;
}

function summarizeRun(summary: RunSummary): DashboardRun {
  const latestScreenshotPath = summary.steps
    .map((step) => step.result?.screenshotPath)
    .filter((entry): entry is string => Boolean(entry))
    .at(-1);

  return {
    runId: summary.runId,
    status: summary.status,
    goal: summary.taskRequest.goal,
    startedAt: summary.startedAt,
    updatedAt: summary.updatedAt,
    finishedAt: summary.finishedAt ?? null,
    stepCount: summary.steps.length,
    completedStepCount: summary.steps.filter((step) => step.status === "completed").length,
    failedStepCount: summary.steps.filter((step) => step.status === "failed").length,
    artifactCount: summary.artifacts.length,
    artifactTypes: Array.from(new Set(summary.artifacts.map((artifact) => artifact.type))),
    latestScreenshotUrl: fileUrl(latestScreenshotPath)
  };
}

async function readRunSummaries(runtimeDir?: string): Promise<RunSummary[]> {
  const runtimePaths = createRuntimePaths(runtimeDir);
  const entries = await readdir(runtimePaths.artifactsRoot, { withFileTypes: true }).catch(() => []);
  const summaries: RunSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const summaryPath = path.join(runtimePaths.artifactsRoot, entry.name, "summary.json");
    try {
      const raw = await readFile(summaryPath, "utf8");
      summaries.push(RunSummarySchema.parse(JSON.parse(raw)));
    } catch {
      // Skip incomplete or older summaries that no longer match the schema.
    }
  }

  return summaries.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

async function readLatestRunId(runtimeDir?: string): Promise<string | null> {
  const pointerPath = path.join(createRuntimePaths(runtimeDir).artifactsRoot, "latest-run.json");
  try {
    const raw = await readFile(pointerPath, "utf8");
    const parsed = JSON.parse(raw) as { runId?: unknown };
    return typeof parsed.runId === "string" ? parsed.runId : null;
  } catch {
    return null;
  }
}

async function buildState(runtimeDir?: string): Promise<unknown> {
  const registry = buildRegistry();
  const artifactStore = new ArtifactStore(runtimeDir);
  const runtimePaths = artifactStore.runtimePaths;
  const summaries = await readRunSummaries(runtimeDir);
  const latestRunId = await readLatestRunId(runtimeDir);
  const latestSummary = latestRunId
    ? summaries.find((summary) => summary.runId === latestRunId) ?? null
    : summaries[0] ?? null;

  return {
    generatedAt: new Date().toISOString(),
    server: {
      name: "nigs-browser-automation",
      transport: "stdio MCP server, viewed through this dashboard HTTP app",
      projectRoot,
      runtimeRoot: runtimePaths.rootDir,
      artifactsRoot: runtimePaths.artifactsRoot,
      chromeProfileDir: runtimePaths.chromeProfileDir
    },
    primitives: {
      tools: groupTools(registry),
      resources: [
        {
          uri: "run://latest/summary",
          purpose: "Read the newest run summary."
        },
        {
          uri: "run://{runId}/summary",
          purpose: "Read one run summary by id."
        },
        {
          uri: "run://{runId}/artifacts/{artifactId}",
          purpose: "Read a saved artifact from a run."
        }
      ],
      prompts: [
        {
          name: "youtube-top-results",
          purpose: "Generate a browser-only plan for YouTube search and extraction."
        },
        {
          name: "short-form-personalized-feed",
          purpose: "Generate a plan for signed-in Shorts, Reels, and TikTok collection."
        },
        {
          name: "browser-research-run",
          purpose: "Generate a browser-first research plan."
        }
      ]
    },
    agentProcess: [
      {
        phase: "Interpret",
        decision: "Turn the user request into an operational goal and identify constraints from AGENTS.md."
      },
      {
        phase: "Plan",
        decision: "Choose the smallest useful tool sequence from the MCP catalog."
      },
      {
        phase: "Execute",
        decision: "Call one tool, wait for a structured result, and let the run manager record the step."
      },
      {
        phase: "Validate",
        decision: "Check schemas, source discovery, semantic page relevance, artifacts, screenshots, and errors before moving on."
      },
      {
        phase: "Recover",
        decision: "When a page fails semantic validation, search for a better source and retry within a bounded loop."
      },
      {
        phase: "Report",
        decision: "Surface run ids, artifacts, and any caveats so the next agent or person can resume."
      }
    ],
    latestRunId,
    latestRun: latestSummary ? summarizeRun(latestSummary) : null,
    jobs: Array.from(jobs.values()).sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    runs: summaries.map(summarizeRun)
  };
}

function resolveRuntimeFile(requestedPath: string): string | null {
  const resolved = path.resolve(requestedPath);
  const artifactsRoot = path.resolve(createRuntimePaths().artifactsRoot);
  if (resolved === artifactsRoot || resolved.startsWith(`${artifactsRoot}${path.sep}`)) {
    return resolved;
  }
  return null;
}

async function serveStatic(requestPath: string, response: ServerResponse): Promise<void> {
  const cleanPath = requestPath === "/" ? "/index.html" : requestPath;
  const resolved = path.resolve(publicDir, `.${cleanPath}`);
  if (!resolved.startsWith(`${publicDir}${path.sep}`) && resolved !== publicDir) {
    text(response, 403, "Forbidden");
    return;
  }

  try {
    const content = await readFile(resolved);
    const mimeType = mimeTypes.get(path.extname(resolved).toLowerCase()) ?? "application/octet-stream";
    response.writeHead(200, {
      "content-type": mimeType,
      "cache-control": "no-store"
    });
    response.end(content);
  } catch {
    text(response, 404, "Not found");
  }
}

async function handleApi(request: IncomingMessage, url: URL, response: ServerResponse): Promise<void> {
  const runtimeDir = url.searchParams.get("runtimeDir") ?? undefined;

  if (url.pathname === "/api/state") {
    json(response, 200, await buildState(runtimeDir));
    return;
  }

  if (url.pathname === "/api/agent-jobs") {
    json(response, 200, {
      jobs: Array.from(jobs.values()).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    });
    return;
  }

  const jobMatch = url.pathname.match(/^\/api\/agent-jobs\/([^/]+)$/);
  if (jobMatch?.[1]) {
    const job = jobs.get(decodeURIComponent(jobMatch[1]));
    if (!job) {
      text(response, 404, "Job not found.");
      return;
    }
    json(response, 200, job);
    return;
  }

  if (url.pathname === "/api/agent-run" && request.method === "POST") {
    const body = await readRequestJson(request);
    const prompt = body && typeof body === "object" && "prompt" in body
      ? String((body as { prompt?: unknown }).prompt ?? "").trim()
      : "";
    if (!prompt) {
      text(response, 400, "Prompt is required.");
      return;
    }
    const job = startAgentJob(prompt);
    json(response, 202, job);
    return;
  }

  if (url.pathname === "/api/runs") {
    const summaries = await readRunSummaries(runtimeDir);
    json(response, 200, {
      runs: summaries.map(summarizeRun)
    });
    return;
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch?.[1]) {
    const store = new ArtifactStore(runtimeDir);
    json(response, 200, await store.readSummary(decodeURIComponent(runMatch[1])));
    return;
  }

  const artifactMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)$/);
  if (artifactMatch?.[1] && artifactMatch[2]) {
    const store = new ArtifactStore(runtimeDir);
    json(
      response,
      200,
      await store.readArtifact(decodeURIComponent(artifactMatch[1]), decodeURIComponent(artifactMatch[2]))
    );
    return;
  }

  if (url.pathname === "/api/file") {
    const requestedPath = url.searchParams.get("path");
    if (!requestedPath) {
      text(response, 400, "Missing path.");
      return;
    }

    const safePath = resolveRuntimeFile(requestedPath);
    if (!safePath) {
      text(response, 403, "File is outside runtime artifacts.");
      return;
    }

    const fileStats = await stat(safePath).catch(() => null);
    if (!fileStats?.isFile()) {
      text(response, 404, "File not found.");
      return;
    }

    const content = await readFile(safePath);
    response.writeHead(200, {
      "content-type": mimeTypes.get(path.extname(safePath).toLowerCase()) ?? "application/octet-stream",
      "cache-control": "no-store"
    });
    response.end(content);
    return;
  }

  text(response, 404, "Unknown API route.");
}

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  const baseUrl = `http://${request.headers.host ?? "localhost"}`;
  const url = new URL(request.url ?? "/", baseUrl);

  void (async () => {
    try {
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, url, response);
        return;
      }

      await serveStatic(url.pathname, response);
    } catch (error) {
      json(response, 500, {
        error: error instanceof Error ? error.message : "Unknown dashboard error."
      });
    }
  })();
});

const port = getPort();
server.listen(port, () => {
  console.log(`MCP learning dashboard running at http://localhost:${port}`);
});
