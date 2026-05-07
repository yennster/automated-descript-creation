import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { spawn } from "node:child_process";
import type { Clip } from "../types.js";

const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".mkv"]);

/**
 * Mode 2b: take a folder of clips the user already recorded and prep them for
 * upload in alphabetical order.
 *
 * Durations: we try `ffprobe` first (most accurate). If it's not installed,
 * we look for a sidecar `manifest.json` in the folder of shape:
 *   { "clips": [{ "file": "01-intro.mp4", "label": "Intro", "durationSec": 8, "beat": "..." }] }
 *
 * If neither is available, we fall back to a 10s placeholder per clip and warn.
 */
export async function stitchClips(args: {
  clipsDir: string;
}): Promise<Clip[]> {
  const dir = resolve(args.clipsDir);
  if (!existsSync(dir)) throw new Error(`Clips directory not found: ${dir}`);

  const manifestPath = join(dir, "manifest.json");
  if (existsSync(manifestPath)) {
    return readManifest(manifestPath, dir);
  }

  const entries = (await readdir(dir))
    .filter((n) => VIDEO_EXTS.has(extname(n).toLowerCase()))
    .sort();

  if (entries.length === 0) {
    throw new Error(`No video clips found in ${dir} (looked for ${[...VIDEO_EXTS].join(", ")})`);
  }

  const probeAvailable = await ffprobeAvailable();
  if (!probeAvailable) {
    console.warn(
      "[stitch] ffprobe not found — using 10s placeholder durations. " +
        "Install ffmpeg or add a manifest.json for accurate timing.",
    );
  }

  const clips: Clip[] = [];
  for (const name of entries) {
    const path = join(dir, name);
    const durationSec = probeAvailable ? await ffprobeDuration(path) : 10;
    clips.push({
      path,
      label: prettyLabel(name),
      durationSec,
    });
  }
  return clips;
}

async function readManifest(manifestPath: string, dir: string): Promise<Clip[]> {
  const json = JSON.parse(await readFile(manifestPath, "utf8")) as {
    clips: { file: string; label?: string; durationSec: number; beat?: string }[];
  };
  const out: Clip[] = [];
  for (const c of json.clips) {
    const path = join(dir, c.file);
    if (!existsSync(path)) throw new Error(`Manifest references missing file: ${path}`);
    out.push({
      path,
      label: c.label ?? prettyLabel(c.file),
      durationSec: c.durationSec,
      beat: c.beat,
    });
  }
  return out;
}

function prettyLabel(filename: string): string {
  return basename(filename, extname(filename))
    .replace(/^[0-9]+[-_\s]*/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function ffprobeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", ["-version"], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
}

async function ffprobeDuration(filePath: string): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const p = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", rejectP);
    p.on("exit", (code) => {
      if (code !== 0) return rejectP(new Error(`ffprobe failed on ${filePath}`));
      const n = parseFloat(out.trim());
      if (!Number.isFinite(n)) return rejectP(new Error(`ffprobe parse failed: "${out}"`));
      resolveP(n);
    });
  });
}
