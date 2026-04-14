import { ArtifactStore } from "./artifact-store.js";
import { AutomationError, toAutomationError } from "./errors.js";
import {
  AutomationPlan,
  RetryPolicy,
  RetryPolicySchema,
  RunStepRecord,
  RunSummary,
  TaskRequest,
  ToolResult
} from "./schemas.js";
import { RunContext, ToolRegistry } from "./tool-registry.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldRetry(error: AutomationError, retryPolicy: RetryPolicy, attempt: number): boolean {
  if (attempt >= retryPolicy.maxAttempts) {
    return false;
  }

  return error.retryable && retryPolicy.retryOn.includes(error.code as RetryPolicy["retryOn"][number]);
}

export interface ExecutionResult {
  runId: string;
  summary: RunSummary;
}

export class PlanExecutor {
  constructor(
    private readonly artifactStore: ArtifactStore,
    private readonly registry: ToolRegistry,
    private readonly logger?: (message: string, details?: unknown) => void
  ) {}

  async execute(taskRequest: TaskRequest, plan: AutomationPlan): Promise<ExecutionResult> {
    const summary = await this.artifactStore.createRun(taskRequest, plan);
    const context = new RunContext({
      runId: summary.runId,
      artifactStore: this.artifactStore,
      logger: this.logger
    });

    if (taskRequest.dryRun || taskRequest.mode === "plan_only") {
      await this.artifactStore.completeRun(summary.runId);
      return {
        runId: summary.runId,
        summary: await this.artifactStore.readSummary(summary.runId)
      };
    }

    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index]!;
      const retryPolicy = RetryPolicySchema.parse(step.retryPolicy ?? {});
      const startedAt = new Date().toISOString();
      let attempt = 0;
      let completed = false;

      while (!completed) {
        attempt += 1;

        const pendingRecord: RunStepRecord = {
          index,
          tool: step.tool,
          input: step.input,
          status: "running",
          attemptCount: attempt,
          startedAt
        };

        if (attempt === 1) {
          await this.artifactStore.appendStep(summary.runId, pendingRecord);
        } else {
          await this.artifactStore.replaceStep(summary.runId, index, pendingRecord);
        }

        try {
          const result = await this.registry.execute(step.tool, step.input, context);
          await this.artifactStore.replaceStep(summary.runId, index, {
            ...pendingRecord,
            status: "completed",
            finishedAt: new Date().toISOString(),
            result
          });
          completed = true;
        } catch (error) {
          const automationError = toAutomationError(error);
          await this.artifactStore.replaceStep(summary.runId, index, {
            ...pendingRecord,
            status: "failed",
            finishedAt: new Date().toISOString(),
            error: automationError.toToolError()
          });

          if (!shouldRetry(automationError, retryPolicy, attempt)) {
            await this.artifactStore.failRun(summary.runId, automationError.toToolError());
            throw automationError;
          }

          await delay(retryPolicy.backoffMs * attempt);
        }
      }
    }

    await this.artifactStore.completeRun(summary.runId);

    return {
      runId: summary.runId,
      summary: await this.artifactStore.readSummary(summary.runId)
    };
  }
}

export function summarizeToolResult(result: ToolResult): string {
  return JSON.stringify(result, null, 2);
}
