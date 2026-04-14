import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserSessionManager, createBrowserTools } from "@nigs/browser-playwright";
import { createMessagesTools } from "@nigs/desktop-macos";
import {
  ArtifactStore,
  createArtifactTools,
  summaryToText,
  toolResultToText,
  ToolRegistry
} from "@nigs/core";
import { createPornhubTools } from "@nigs/site-pornhub";
import { createYouTubeTools } from "@nigs/site-youtube";
import { ManualRunManager } from "./manual-run-manager.js";

function buildRegistry(browserManager: BrowserSessionManager): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerMany(createBrowserTools(browserManager));
  registry.registerMany(createMessagesTools());
  registry.registerMany(createYouTubeTools(browserManager));
  registry.registerMany(createPornhubTools(browserManager));
  registry.registerMany(createArtifactTools());
  return registry;
}

export async function startMcpServer(): Promise<void> {
  const artifactStore = new ArtifactStore();
  await artifactStore.initialize();

  const browserManager = new BrowserSessionManager();
  const registry = buildRegistry(browserManager);
  const runManager = new ManualRunManager(artifactStore, (message, details) => {
    if (details) {
      console.error(message, details);
      return;
    }
    console.error(message);
  });

  const server = new McpServer(
    {
      name: "nigs-browser-automation",
      version: "0.1.0"
    },
    {
      instructions:
        "Use these tools for browser-first automation. Phase 1 is browser-only. Launch Chrome first, use YouTube tools for search/extraction, and read artifacts through run:// resources."
    }
  );

  for (const tool of registry.listCatalog()) {
    const definition = registry.get(tool.name);
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: definition.inputSchema
      },
      async (args) => {
        try {
          const result = await runManager.callTool(registry, tool.name, args);
          return {
            content: [
              {
                type: "text",
                text: toolResultToText(result)
              }
            ],
            structuredContent: result as Record<string, unknown>
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown tool error.";
          return {
            content: [
              {
                type: "text",
                text: message
              }
            ],
            isError: true
          };
        }
      }
    );
  }

  server.registerResource(
    "latest-run-summary",
    "run://latest/summary",
    {
      title: "Latest Run Summary",
      description: "Read the latest run summary."
    },
    async () => {
      const summary = await artifactStore.readSummary("latest");
      return {
        contents: [
          {
            uri: "run://latest/summary",
            mimeType: "application/json",
            text: summaryToText(summary)
          }
        ]
      };
    }
  );

  server.registerResource(
    "run-summary",
    new ResourceTemplate("run://{runId}/summary", { list: undefined }),
    {
      title: "Run Summary",
      description: "Read a run summary by run id."
    },
    async (_uri, params) => {
      const runId = Array.isArray(params.runId) ? params.runId[0] : params.runId;
      if (!runId) {
        throw new Error("runId is required.");
      }
      const summary = await artifactStore.readSummary(runId);
      return {
        contents: [
          {
            uri: `run://${runId}/summary`,
            mimeType: "application/json",
            text: summaryToText(summary)
          }
        ]
      };
    }
  );

  server.registerResource(
    "run-artifact",
    new ResourceTemplate("run://{runId}/artifacts/{artifactId}", { list: undefined }),
    {
      title: "Run Artifact",
      description: "Read a run artifact by run id and artifact id."
    },
    async (_uri, params) => {
      const runId = Array.isArray(params.runId) ? params.runId[0] : params.runId;
      const artifactId = Array.isArray(params.artifactId) ? params.artifactId[0] : params.artifactId;
      if (!runId || !artifactId) {
        throw new Error("runId and artifactId are required.");
      }
      const artifact = await artifactStore.readArtifact(runId, artifactId);
      return {
        contents: [
          {
            uri: `run://${runId}/artifacts/${artifactId}`,
            mimeType: artifact.mimeType,
            text: typeof artifact.content === "string" ? artifact.content : JSON.stringify(artifact.content, null, 2)
          }
        ]
      };
    }
  );

  server.registerPrompt(
    "youtube-top-results",
    {
      title: "YouTube Top Results",
      description: "Generate a browser-only automation prompt for top YouTube results.",
      argsSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(10).optional()
      }
    },
    async (args) => ({
      description: "Prompt for collecting top YouTube results.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Launch Chrome, search YouTube for "${args.query}", open the top ${args.limit ?? 3} organic videos, and save each video's extracted text as artifacts.`
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "browser-research-run",
    {
      title: "Browser Research Run",
      description: "Generate a browser-first research prompt.",
      argsSchema: {
        goal: z.string().min(1)
      }
    },
    async (args) => ({
      description: "Prompt for a browser-only research run.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Use browser-only automation to complete this goal: ${args.goal}`
          }
        }
      ]
    })
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
