import type {
  MessagesOpenAppInput,
  MessagesSendTextInput,
  ToolDefinition
} from "@nigs/core";
import {
  MessagesOpenAppInputSchema,
  MessagesSendTextInputSchema
} from "@nigs/core";
import { openMessagesApp, sendMessage } from "./messages.js";

export function createMessagesTools(): ToolDefinition[] {
  const openTool: ToolDefinition<MessagesOpenAppInput> = {
    name: "messages_open_app",
    title: "Open Messages App",
    description: "Activate the macOS Messages application.",
    inputSchema: MessagesOpenAppInputSchema,
    execute: async (context) => {
      const output = await openMessagesApp();
      const artifact = await context.writeArtifact({
        type: "messages-open-app",
        content: { output }
      });
      return {
        ok: true,
        data: { output },
        artifactIds: [artifact.id]
      };
    }
  };

  const sendTextTool: ToolDefinition<MessagesSendTextInput> = {
    name: "messages_send_text",
    title: "Send iMessage Text",
    description: "Open Messages if needed, find a recipient by name, and send text.",
    inputSchema: MessagesSendTextInputSchema,
    execute: async (context, input) => {
      await openMessagesApp();
      const output = await sendMessage({
        recipientName: input.recipientName,
        messageText: input.messageText,
        serviceType: input.serviceType
      });
      const artifact = await context.writeArtifact({
        type: "messages-send-text",
        content: {
          recipientName: input.recipientName,
          messageText: input.messageText,
          serviceType: input.serviceType,
          output
        }
      });
      return {
        ok: true,
        data: {
          recipientName: input.recipientName,
          messageText: input.messageText,
          serviceType: input.serviceType,
          output
        },
        artifactIds: [artifact.id]
      };
    }
  };

  return [openTool, sendTextTool];
}

