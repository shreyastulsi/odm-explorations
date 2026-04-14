import { describe, expect, it } from "vitest";
import {
  buildOpenMessagesAppScript,
  buildResolveRecipientHandleScript,
  buildSendMessageScript
} from "./messages.js";

describe("Messages AppleScript builders", () => {
  it("builds an app open script", () => {
    const script = buildOpenMessagesAppScript().join("\n");
    expect(script).toContain('tell application "Messages"');
    expect(script).toContain("activate");
  });

  it("builds a send message script with recipient and content", () => {
    const script = buildSendMessageScript({
      recipientName: "Gautam Nair",
      recipientTarget: "+14084780050",
      messageText: "S.P",
      serviceType: "iMessage"
    }).join("\n");
    expect(script).toContain("Gautam Nair");
    expect(script).toContain("+14084780050");
    expect(script).toContain("S.P");
    expect(script).toContain("participant targetAddress of targetService");
    expect(script).toContain('send outgoingMessage to targetRecipient');
  });

  it("builds a Contacts lookup script for recipient handles", () => {
    const script = buildResolveRecipientHandleScript("Gautam Nair").join("\n");
    expect(script).toContain('tell application "Contacts"');
    expect(script).toContain("Gautam Nair");
    expect(script).toContain("candidateHandles");
  });
});
