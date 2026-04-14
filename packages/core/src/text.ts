import type { ToolResult } from "./schemas.js";

export function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function toolResultToText(result: ToolResult): string {
  return toPrettyJson(result);
}

export function summaryToText(summary: unknown): string {
  return toPrettyJson(summary);
}

