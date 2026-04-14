import type { RetryErrorCode, ToolResultError } from "./schemas.js";

export class AutomationError extends Error {
  readonly code: RetryErrorCode | string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: RetryErrorCode | string,
    message: string,
    options?: { retryable?: boolean; details?: unknown }
  ) {
    super(message);
    this.name = "AutomationError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }

  toToolError(): ToolResultError {
    return {
      code: String(this.code),
      message: this.message,
      details: this.details
    };
  }
}

export function toAutomationError(error: unknown): AutomationError {
  if (error instanceof AutomationError) {
    return error;
  }

  if (error instanceof Error) {
    const message = error.message;
    const lower = message.toLowerCase();

    if (lower.includes("timeout")) {
      return new AutomationError("timeout", message, {
        retryable: true,
        details: { cause: error.name }
      });
    }

    if (lower.includes("net::err") || lower.includes("network")) {
      return new AutomationError("network", message, {
        retryable: true,
        details: { cause: error.name }
      });
    }

    if (lower.includes("navigation")) {
      return new AutomationError("navigation", message, {
        retryable: true,
        details: { cause: error.name }
      });
    }

    return new AutomationError("unknown", message, {
      retryable: false,
      details: { cause: error.name }
    });
  }

  return new AutomationError("unknown", "Unknown automation error.", {
    retryable: false,
    details: error
  });
}

