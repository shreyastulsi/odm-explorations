import {
  ArtifactStore,
  RunContext,
  ToolRegistry,
  TaskRequestSchema,
  toAutomationError,
  type RunStepRecord,
  type ToolName,
  type ToolResult
} from "@nigs/core";

export class ManualRunManager {
  private activeContext?: RunContext;
  private nextStepIndex = 0;

  constructor(
    private readonly artifactStore: ArtifactStore,
    private readonly logger?: (message: string, details?: unknown) => void
  ) {}

  async getContext(goal = "Manual MCP automation session"): Promise<RunContext> {
    if (this.activeContext) {
      return this.activeContext;
    }

    const run = await this.artifactStore.createRun(
      TaskRequestSchema.parse({
        goal,
        outputFormat: "json"
      })
    );

    this.activeContext = new RunContext({
      runId: run.runId,
      artifactStore: this.artifactStore,
      logger: this.logger
    });

    return this.activeContext;
  }

  async callTool(
    registry: ToolRegistry,
    name: ToolName,
    input: unknown
  ): Promise<ToolResult> {
    const context = await this.getContext();
    const index = this.nextStepIndex;
    this.nextStepIndex += 1;
    const startedAt = new Date().toISOString();

    const pendingStep: RunStepRecord = {
      index,
      tool: name,
      input: (input as Record<string, unknown> | undefined) ?? {},
      status: "running",
      attemptCount: 1,
      startedAt
    };

    await this.artifactStore.appendStep(context.runId, pendingStep);

    try {
      const result = await registry.execute(name, input, context);
      await this.artifactStore.replaceStep(context.runId, index, {
        ...pendingStep,
        status: "completed",
        finishedAt: new Date().toISOString(),
        result
      });
      return result;
    } catch (error) {
      const automationError = toAutomationError(error);
      await this.artifactStore.replaceStep(context.runId, index, {
        ...pendingStep,
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: automationError.toToolError()
      });
      await this.artifactStore.failRun(context.runId, automationError.toToolError());
      throw automationError;
    }
  }
}

