import type {
  ArtifactListInput,
  ArtifactReadInput
} from "./schemas.js";
import {
  ArtifactListInputSchema,
  ArtifactReadInputSchema
} from "./schemas.js";
import type { ToolDefinition } from "./tool-registry.js";

export function createArtifactTools(): ToolDefinition[] {
  const listTool: ToolDefinition<ArtifactListInput> = {
    name: "artifact_list",
    title: "List Artifacts",
    description: "List saved artifacts for a run.",
    inputSchema: ArtifactListInputSchema,
    execute: async (context, input) => {
      const artifacts = await context.artifactStore.listArtifacts(input.runId ?? context.runId, input.type);
      return {
        ok: true,
        data: {
          runId: input.runId ?? context.runId,
          artifacts
        }
      };
    }
  };

  const readTool: ToolDefinition<ArtifactReadInput> = {
    name: "artifact_read",
    title: "Read Artifact",
    description: "Read a saved artifact by id.",
    inputSchema: ArtifactReadInputSchema,
    execute: async (context, input) => {
      const artifact = await context.artifactStore.readArtifact(input.runId ?? context.runId, input.artifactId);
      return {
        ok: true,
        data: artifact,
        artifactIds: [artifact.id]
      };
    }
  };

  return [listTool, readTool];
}
