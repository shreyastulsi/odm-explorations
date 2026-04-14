import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export function toJsonSchema(schema: ZodTypeAny, name: string): Record<string, unknown> {
  return zodToJsonSchema(schema, {
    name,
    $refStrategy: "none"
  }) as Record<string, unknown>;
}

