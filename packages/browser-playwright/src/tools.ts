import type {
  BrowserClickInput,
  BrowserFillInput,
  BrowserGotoInput,
  BrowserLaunchInput,
  BrowserPressInput,
  BrowserReadPageInput,
  BrowserWaitForInput,
  ToolDefinition
} from "@nigs/core";
import {
  BrowserClickInputSchema,
  BrowserFillInputSchema,
  BrowserGotoInputSchema,
  BrowserLaunchInputSchema,
  BrowserPressInputSchema,
  BrowserReadPageInputSchema,
  BrowserWaitForInputSchema
} from "@nigs/core";
import { BrowserSessionManager } from "./session-manager.js";

export function createBrowserTools(
  browserManager: BrowserSessionManager
): ToolDefinition[] {
  const browserLaunchTool: ToolDefinition<BrowserLaunchInput> = {
    name: "browser_launch",
    title: "Launch Browser",
    description: "Launch headed Google Chrome with a persistent profile.",
    inputSchema: BrowserLaunchInputSchema,
    execute: async (context, input) => {
      const data = await browserManager.launch(context.runId, input);
      return {
        ok: true,
        data
      };
    }
  };

  const browserGotoTool: ToolDefinition<BrowserGotoInput> = {
    name: "browser_goto",
    title: "Go To URL",
    description: "Navigate the active browser session to a URL.",
    inputSchema: BrowserGotoInputSchema,
    execute: async (context, input) => browserManager.goto(context.runId, input)
  };

  const browserClickTool: ToolDefinition<BrowserClickInput> = {
    name: "browser_click",
    title: "Click Element",
    description: "Click a semantic target on the current page.",
    inputSchema: BrowserClickInputSchema,
    execute: async (context, input) => browserManager.click(context.runId, input)
  };

  const browserFillTool: ToolDefinition<BrowserFillInput> = {
    name: "browser_fill",
    title: "Fill Input",
    description: "Fill a semantic target with text.",
    inputSchema: BrowserFillInputSchema,
    execute: async (context, input) => browserManager.fill(context.runId, input)
  };

  const browserPressTool: ToolDefinition<BrowserPressInput> = {
    name: "browser_press",
    title: "Press Key",
    description: "Press a key in the active browser session.",
    inputSchema: BrowserPressInputSchema,
    execute: async (context, input) => browserManager.press(context.runId, input)
  };

  const browserWaitTool: ToolDefinition<BrowserWaitForInput> = {
    name: "browser_wait_for",
    title: "Wait For",
    description: "Wait for a target, URL fragment, text, or load state.",
    inputSchema: BrowserWaitForInputSchema,
    execute: async (context, input) => browserManager.waitFor(context.runId, input)
  };

  const browserReadPageTool: ToolDefinition<BrowserReadPageInput> = {
    name: "browser_read_page",
    title: "Read Page",
    description: "Read the visible page into structured text.",
    inputSchema: BrowserReadPageInputSchema,
    execute: async (context, input) => {
      const result = await browserManager.readPage(context.runId, input);
      if (result.data) {
        const sourceUrl = result.currentUrl;
        const artifact = await context.writeArtifact({
          type: "page-read",
          content: result.data,
          ...(sourceUrl ? { sourceUrl } : {})
        });
        result.artifactIds = [artifact.id];
      }
      return result;
    }
  };

  return [
    browserLaunchTool,
    browserGotoTool,
    browserClickTool,
    browserFillTool,
    browserPressTool,
    browserWaitTool,
    browserReadPageTool
  ];
}
