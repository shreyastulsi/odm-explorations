import { quoteAppleScriptString, runAppleScript } from "./applescript.js";

function serviceTypeToAppleScript(serviceType: "iMessage" | "SMS" | "RCS"): string {
  switch (serviceType) {
    case "SMS":
      return "SMS";
    case "RCS":
      return "RCS";
    case "iMessage":
    default:
      return "iMessage";
  }
}

export function buildOpenMessagesAppScript(): string[] {
  return [
    'tell application "Messages"',
    "activate",
    "end tell",
    'return "opened"'
  ];
}

export function buildResolveRecipientHandleScript(recipientName: string): string[] {
  const targetName = quoteAppleScriptString(recipientName);

  return [
    `set targetName to ${targetName}`,
    "",
    'tell application "Contacts"',
    "set matchingPeople to every person whose name is targetName",
    "if (count of matchingPeople) is 0 then",
    "set matchingPeople to every person whose name contains targetName",
    "end if",
    "",
    "set candidateHandles to {}",
    "repeat with currentPerson in matchingPeople",
    "try",
    "repeat with currentPhone in phones of currentPerson",
    "set phoneValue to value of currentPhone as text",
    'if phoneValue is not "" then set end of candidateHandles to phoneValue',
    "end repeat",
    "end try",
    "try",
    "repeat with currentEmail in emails of currentPerson",
    "set emailValue to value of currentEmail as text",
    'if emailValue is not "" then set end of candidateHandles to emailValue',
    "end repeat",
    "end try",
    "end repeat",
    "",
    "if (count of candidateHandles) is 0 then",
    'return ""',
    "end if",
    "",
    "return item 1 of candidateHandles",
    "end tell"
  ];
}

function normalizeRecipientHandle(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("@")) {
    return trimmed.toLowerCase();
  }

  const digitsOnly = trimmed.replace(/[^\d+]/g, "");
  const digitChars = digitsOnly.replace(/\D/g, "");

  if (digitChars.length === 10) {
    return `+1${digitChars}`;
  }

  if (digitChars.length === 11 && digitChars.startsWith("1")) {
    return `+${digitChars}`;
  }

  if (trimmed.startsWith("+")) {
    return `+${digitChars}`;
  }

  return trimmed;
}

export function buildSendMessageScript(input: {
  recipientName: string;
  recipientTarget: string;
  messageText: string;
  serviceType: "iMessage" | "SMS" | "RCS";
}): string[] {
  const recipientName = quoteAppleScriptString(input.recipientName);
  const recipientTarget = quoteAppleScriptString(input.recipientTarget);
  const messageText = quoteAppleScriptString(input.messageText);
  const serviceType = serviceTypeToAppleScript(input.serviceType);

  return [
    `set targetName to ${recipientName}`,
    `set targetAddress to ${recipientTarget}`,
    `set outgoingMessage to ${messageText}`,
    "",
    'tell application "Messages"',
    "activate",
    "delay 1",
    `set targetService to first service whose service type = ${serviceType} and enabled is true`,
    "set targetRecipient to missing value",
    "",
    "try",
    "set targetRecipient to participant targetAddress of targetService",
    "end try",
    "",
    "if targetRecipient is missing value then",
    "try",
    "set targetRecipient to participant targetName of targetService",
    "end try",
    "end if",
    "",
    'if targetRecipient is missing value then error "Messages recipient not found: " & targetName',
    "send outgoingMessage to targetRecipient",
    "end tell",
    "",
    'return "sent"'
  ];
}

export async function openMessagesApp(): Promise<string> {
  return runAppleScript(buildOpenMessagesAppScript());
}

export async function sendMessage(input: {
  recipientName: string;
  messageText: string;
  serviceType: "iMessage" | "SMS" | "RCS";
}): Promise<string> {
  let recipientTarget = input.recipientName;

  try {
    const resolvedHandle = await runAppleScript(
      buildResolveRecipientHandleScript(input.recipientName)
    );
    if (resolvedHandle) {
      recipientTarget = normalizeRecipientHandle(resolvedHandle);
    }
  } catch {
    recipientTarget = input.recipientName;
  }

  return runAppleScript(
    buildSendMessageScript({
      ...input,
      recipientTarget
    })
  );
}
