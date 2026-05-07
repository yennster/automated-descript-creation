import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const exec = promisify(execFile);

/**
 * Wraps the `gemini` CLI in non-interactive mode (`gemini -p "..."`).
 *
 * Auth comes from the user's interactive `gemini` login — no API key needed.
 * If the CLI isn't installed, callers should fall back gracefully.
 *
 * Image support: pass `imagePath` and Gemini's `@<path>` embed syntax appends
 * the image to the prompt. The path is resolved to absolute so the CLI's
 * @-loader works regardless of current working directory.
 */
export async function runGemini(args: {
  prompt: string;
  imagePath?: string;
  model?: string;
  /** Max wall-clock time for the call. Default 90s. */
  timeoutMs?: number;
}): Promise<string> {
  const fullPrompt = args.imagePath
    ? `${args.prompt}\n\n@${resolve(args.imagePath)}`
    : args.prompt;
  const cliArgs = ["-p", fullPrompt];
  if (args.model) cliArgs.push("-m", args.model);

  const { stdout, stderr } = await exec("gemini", cliArgs, {
    timeout: args.timeoutMs ?? 90_000,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf8",
  });
  // Gemini CLI emits some terminal warnings + skill conflicts to stdout
  // before the model output. Strip known prefixes so callers get just text.
  return stripCliNoise(stdout) || stripCliNoise(stderr);
}

/** Best-effort detection: returns true if `gemini` is on PATH. */
export async function isGeminiAvailable(): Promise<boolean> {
  try {
    await exec("gemini", ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const NOISE_PREFIXES = [
  "Warning: 256-color support not detected",
  "Ripgrep is not available",
  "Skill conflict detected",
  "Attempt 1 failed",
];

function stripCliNoise(text: string): string {
  return text
    .split("\n")
    .filter((line) => !NOISE_PREFIXES.some((p) => line.includes(p)))
    .join("\n")
    .trim();
}

/** Pulls a JSON object out of a model response that may contain prose or fences. */
export function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1) {
    throw new Error(`No JSON found in model output: ${text.slice(0, 300)}`);
  }
  return text.slice(first, last + 1);
}
