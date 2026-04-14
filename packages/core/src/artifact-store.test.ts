import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { TaskRequestSchema } from "./schemas.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("ArtifactStore", () => {
  it("creates runs, stores artifacts, and resolves latest run", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "nigs-artifacts-"));
    tempDirs.push(tempRoot);

    const store = new ArtifactStore(tempRoot);
    const run = await store.createRun(
      TaskRequestSchema.parse({
        goal: "Collect top videos"
      })
    );

    const artifact = await store.writeArtifact(run.runId, {
      type: "youtube-video",
      content: { title: "Example" }
    });

    const latestSummary = await store.readSummary("latest");
    expect(latestSummary.runId).toBe(run.runId);
    expect(latestSummary.artifacts).toHaveLength(1);

    const loaded = await store.readArtifact("latest", artifact.id);
    expect(loaded.content).toEqual({ title: "Example" });
  });
});

