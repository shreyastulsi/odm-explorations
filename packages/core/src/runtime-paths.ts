import path from "node:path";
import { mkdir } from "node:fs/promises";

export interface RuntimePaths {
  rootDir: string;
  artifactsRoot: string;
  chromeProfileDir: string;
}

export function createRuntimePaths(rootDir = path.resolve(process.cwd(), "runtime")): RuntimePaths {
  return {
    rootDir,
    artifactsRoot: path.join(rootDir, "artifacts"),
    chromeProfileDir: path.join(rootDir, "chrome-profile")
  };
}

export async function ensureRuntimePaths(paths: RuntimePaths): Promise<void> {
  await Promise.all([
    mkdir(paths.rootDir, { recursive: true }),
    mkdir(paths.artifactsRoot, { recursive: true }),
    mkdir(paths.chromeProfileDir, { recursive: true })
  ]);
}

