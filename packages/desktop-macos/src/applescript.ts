import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runAppleScript(lines: string[], timeoutMs = 60_000): Promise<string> {
  const args = lines.flatMap((line) => ["-e", line]);
  const { stdout, stderr } = await execFileAsync("osascript", args, {
    timeout: timeoutMs
  });

  return [stdout, stderr].join("").trim();
}

export function quoteAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

