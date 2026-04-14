import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ArtifactStore } from "./artifact-store.js";
import { AutomationError } from "./errors.js";
import { PlanExecutor } from "./executor.js";
import { AutomationPlanSchema, TaskRequestSchema } from "./schemas.js";
import { ToolRegistry } from "./tool-registry.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("PlanExecutor", () => {
  it("retries transient failures and completes the run", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "nigs-executor-"));
    tempDirs.push(tempRoot);

    const store = new ArtifactStore(tempRoot);
    const registry = new ToolRegistry();
    let attempts = 0;

    registry.register({
      name: "browser_launch",
      title: "Launch browser",
      description: "Test tool",
      inputSchema: z.object({}),
      execute: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new AutomationError("timeout", "Timed out.", { retryable: true });
        }

        return {
          ok: true,
          data: { sessionId: "session-1" }
        };
      }
    });

    const executor = new PlanExecutor(store, registry);
    const result = await executor.execute(
      TaskRequestSchema.parse({ goal: "Launch browser" }),
      AutomationPlanSchema.parse({
        steps: [
          {
            tool: "browser_launch",
            input: {},
            retryPolicy: {
              maxAttempts: 2,
              backoffMs: 1,
              retryOn: ["timeout"]
            }
          }
        ]
      })
    );

    expect(attempts).toBe(2);
    expect(result.summary.status).toBe("completed");
    expect(result.summary.steps[0]?.attemptCount).toBe(2);
  });
});

