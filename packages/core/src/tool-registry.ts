import type { ZodTypeAny } from "zod";
import { ArtifactStore } from "./artifact-store.js";
import { AutomationError, toAutomationError } from "./errors.js";
import {
  RunArtifact,
  ToolCatalogEntry,
  ToolName,
  ToolResult
} from "./schemas.js";
import { toJsonSchema } from "./json-schema.js";

export interface RunContextOptions {
  runId: string;
  artifactStore: ArtifactStore;
  logger?: ((message: string, details?: unknown) => void) | undefined;
}

export class RunContext {
  readonly runId: string;
  readonly artifactStore: ArtifactStore;
  readonly logger: ((message: string, details?: unknown) => void) | undefined;
  private readonly state = new Map<string, unknown>();

  constructor(options: RunContextOptions) {
    this.runId = options.runId;
    this.artifactStore = options.artifactStore;
    this.logger = options.logger;
  }

  setState(key: string, value: unknown): void {
    this.state.set(key, value);
  }

  getState<T>(key: string): T | undefined {
    return this.state.get(key) as T | undefined;
  }

  async writeArtifact(input: {
    type: string;
    content: unknown;
    sourceUrl?: string;
    mimeType?: string;
  }): Promise<RunArtifact> {
    return this.artifactStore.writeArtifact(this.runId, input);
  }

  log(message: string, details?: unknown): void {
    this.logger?.(message, details);
  }
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: ZodTypeAny;
  execute(context: RunContext, input: TInput): Promise<ToolResult<TOutput>>;
}

export class ToolRegistry {
  private readonly tools = new Map<ToolName, ToolDefinition>();

  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    this.tools.set(tool.name, tool as ToolDefinition);
  }

  registerMany(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  listCatalog(): ToolCatalogEntry[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: toJsonSchema(tool.inputSchema, `${tool.name}_input`)
    }));
  }

  get(name: ToolName): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new AutomationError("unknown", `Tool ${name} is not registered.`);
    }
    return tool;
  }

  async execute(name: ToolName, input: unknown, context: RunContext): Promise<ToolResult> {
    const tool = this.get(name);
    const parsedInput = tool.inputSchema.parse(input);

    try {
      return await tool.execute(context, parsedInput);
    } catch (error) {
      throw toAutomationError(error);
    }
  }
}
