import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AutomationPlan,
  RunArtifact,
  RunArtifactMeta,
  RunSummary,
  RunSummarySchema,
  RunStepRecord,
  TaskRequest,
  ToolResultError
} from "./schemas.js";
import { createRuntimePaths, ensureRuntimePaths, RuntimePaths } from "./runtime-paths.js";

interface WriteArtifactInput {
  type: string;
  content: unknown;
  sourceUrl?: string;
  mimeType?: string;
}

export class ArtifactStore {
  readonly runtimePaths: RuntimePaths;

  constructor(rootDir?: string) {
    this.runtimePaths = createRuntimePaths(rootDir);
  }

  async initialize(): Promise<void> {
    await ensureRuntimePaths(this.runtimePaths);
  }

  getRunDir(runId: string): string {
    return path.join(this.runtimePaths.artifactsRoot, runId);
  }

  getRunArtifactsDir(runId: string): string {
    return path.join(this.getRunDir(runId), "files");
  }

  getRunSummaryPath(runId: string): string {
    return path.join(this.getRunDir(runId), "summary.json");
  }

  getLatestRunPointerPath(): string {
    return path.join(this.runtimePaths.artifactsRoot, "latest-run.json");
  }

  async createRun(taskRequest: TaskRequest, plan?: AutomationPlan): Promise<RunSummary> {
    await this.initialize();
    const runId = randomUUID();
    const runDir = this.getRunDir(runId);
    const artifactsDir = this.getRunArtifactsDir(runId);

    await mkdir(runDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });

    const now = new Date().toISOString();
    const summary: RunSummary = {
      runId,
      taskRequest,
      plan,
      status: "running",
      startedAt: now,
      updatedAt: now,
      artifacts: [],
      steps: []
    };

    await this.writeSummary(summary);
    await writeFile(this.getLatestRunPointerPath(), JSON.stringify({ runId }, null, 2), "utf8");

    return summary;
  }

  async readSummary(runId = "latest"): Promise<RunSummary> {
    const resolvedRunId = await this.resolveRunId(runId);
    const raw = await readFile(this.getRunSummaryPath(resolvedRunId), "utf8");
    return RunSummarySchema.parse(JSON.parse(raw));
  }

  async writeSummary(summary: RunSummary): Promise<void> {
    await writeFile(
      this.getRunSummaryPath(summary.runId),
      JSON.stringify(summary, null, 2),
      "utf8"
    );
  }

  async updateSummary(
    runId: string,
    updater: (summary: RunSummary) => RunSummary | Promise<RunSummary>
  ): Promise<RunSummary> {
    const current = await this.readSummary(runId);
    const updated = await updater(current);
    updated.updatedAt = new Date().toISOString();
    await this.writeSummary(updated);
    return updated;
  }

  async appendStep(runId: string, step: RunStepRecord): Promise<void> {
    await this.updateSummary(runId, async (summary) => {
      summary.steps.push(step);
      return summary;
    });
  }

  async replaceStep(runId: string, index: number, step: RunStepRecord): Promise<void> {
    await this.updateSummary(runId, async (summary) => {
      summary.steps[index] = step;
      return summary;
    });
  }

  async completeRun(runId: string): Promise<void> {
    await this.updateSummary(runId, async (summary) => ({
      ...summary,
      status: "completed",
      finishedAt: new Date().toISOString()
    }));
  }

  async failRun(runId: string, error: ToolResultError): Promise<void> {
    await this.updateSummary(runId, async (summary) => ({
      ...summary,
      status: "failed",
      error,
      finishedAt: new Date().toISOString()
    }));
  }

  async writeArtifact(runId: string, input: WriteArtifactInput): Promise<RunArtifact> {
    const resolvedRunId = await this.resolveRunId(runId);
    const artifactId = randomUUID();
    const isJson = typeof input.content !== "string";
    const extension = isJson ? "json" : "txt";
    const mimeType = input.mimeType ?? (isJson ? "application/json" : "text/plain");
    const artifactPath = path.join(
      this.getRunArtifactsDir(resolvedRunId),
      `${artifactId}.${extension}`
    );

    await mkdir(path.dirname(artifactPath), { recursive: true });
    const textContent = isJson
      ? JSON.stringify(input.content, null, 2)
      : (input.content as string);

    await writeFile(artifactPath, textContent, "utf8");
    const stats = await stat(artifactPath);

    const meta: RunArtifactMeta = {
      id: artifactId,
      type: input.type,
      path: artifactPath,
      sourceUrl: input.sourceUrl,
      mimeType,
      createdAt: new Date().toISOString(),
      sizeBytes: stats.size
    };

    await this.updateSummary(resolvedRunId, async (summary) => {
      summary.artifacts.push(meta);
      return summary;
    });

    return {
      ...meta,
      content: input.content
    };
  }

  async listArtifacts(runId = "latest", type?: string): Promise<RunArtifactMeta[]> {
    const summary = await this.readSummary(runId);
    if (!type) {
      return summary.artifacts;
    }
    return summary.artifacts.filter((artifact) => artifact.type === type);
  }

  async readArtifact(runId: string, artifactId: string): Promise<RunArtifact> {
    const resolvedRunId = await this.resolveRunId(runId);
    const summary = await this.readSummary(resolvedRunId);
    const artifact = summary.artifacts.find((entry) => entry.id === artifactId);

    if (!artifact) {
      throw new Error(`Artifact ${artifactId} not found in run ${resolvedRunId}.`);
    }

    const raw = await readFile(artifact.path, "utf8");
    const content =
      artifact.mimeType === "application/json" ? JSON.parse(raw) : raw;

    return {
      ...artifact,
      content
    };
  }

  async resolveRunId(runId = "latest"): Promise<string> {
    if (runId !== "latest") {
      return runId;
    }

    const raw = await readFile(this.getLatestRunPointerPath(), "utf8");
    const parsed = JSON.parse(raw) as { runId: string };
    return parsed.runId;
  }
}

