import { chromium, type Browser, type Page } from "playwright";
import { mkdir, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  horizontalScrollLockScript,
  installHorizontalScrollLock,
} from "../browser/horizontal-scroll-lock.js";
import type { Clip, TranscriptBeat } from "../types.js";
import {
  type CaptureAction,
  runActionFlow,
} from "./capture-actions.js";

export type CaptureFormat =
  | "desktop"
  | "desktop-4k"
  | "desktop-720p"
  | "mobile"
  | "mobile-720p";

interface FormatSpec {
  label: string;
  viewport: { width: number; height: number };
  isMobile: boolean;
}

export const FORMAT_PRESETS: Record<CaptureFormat, FormatSpec> = {
  desktop: {
    label: "Desktop 1080p (16:9)",
    viewport: { width: 1920, height: 1080 },
    isMobile: false,
  },
  "desktop-4k": {
    label: "Desktop 4K (16:9) — text will look small on apps designed for 1920px",
    viewport: { width: 3840, height: 2160 },
    isMobile: false,
  },
  "desktop-720p": {
    label: "Desktop 720p (16:9)",
    viewport: { width: 1280, height: 720 },
    isMobile: false,
  },
  mobile: {
    label: "Mobile portrait 1080×1920 (9:16) — Shorts/Reels",
    viewport: { width: 1080, height: 1920 },
    isMobile: true,
  },
  "mobile-720p": {
    label: "Mobile portrait 720×1280 (9:16)",
    viewport: { width: 720, height: 1280 },
    isMobile: true,
  },
};

export function isCaptureFormat(s: string): s is CaptureFormat {
  return s in FORMAT_PRESETS;
}

/**
 * `capture` mode. Two flavors:
 *
 * 1. Action flow (recommended): pass `actions` — a list of click/fill/scroll
 *    steps. Capture loads the URL, executes each action, and records the
 *    whole sequence. Each action becomes a beat in the transcript with its
 *    own start/end time, so you know what to say while it's playing back.
 *
 * 2. Scroll tour (default fallback): no actions → automated slow-scroll
 *    of the landing page. Useful as a placeholder.
 *
 * With multiple `formats`, the actions/tour run once per format on the same
 * browser instance.
 */
export async function captureUrl(args: {
  url: string;
  outputDir: string;
  formats: CaptureFormat[];
  actions?: CaptureAction[];
}): Promise<Clip[]> {
  if (args.formats.length === 0) throw new Error("At least one format is required");

  const videoDir = resolve(args.outputDir, "raw");
  await mkdir(videoDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const clips: Clip[] = [];
  try {
    for (const formatKey of args.formats) {
      const clip = await captureOneFormat({
        browser,
        url: args.url,
        videoDir,
        formatKey,
        actions: args.actions,
      });
      clips.push(clip);
    }
  } finally {
    await browser.close();
  }
  return clips;
}

async function captureOneFormat(args: {
  browser: Browser;
  url: string;
  videoDir: string;
  formatKey: CaptureFormat;
  actions?: CaptureAction[];
}): Promise<Clip> {
  const spec = FORMAT_PRESETS[args.formatKey];
  const formatDir = resolve(args.videoDir, args.formatKey);
  await mkdir(formatDir, { recursive: true });

  const context = await args.browser.newContext({
    viewport: spec.viewport,
    isMobile: spec.isMobile,
    hasTouch: spec.isMobile,
    recordVideo: { dir: formatDir, size: spec.viewport },
  });
  await context.addInitScript(horizontalScrollLockScript());
  const page = await context.newPage();

  const recordingStartMs = Date.now();
  let beats: TranscriptBeat[] | undefined;
  try {
    await page.goto(args.url, { waitUntil: "networkidle", timeout: 30_000 });
    await preparePageForCapture(page);
    if (args.actions && args.actions.length > 0) {
      console.log(`[capture] running ${args.actions.length} action(s) on ${args.formatKey}`);
      const actionBeats = await runActionFlow({ page, actions: args.actions, recordingStartMs });
      beats = actionBeats.map((b) => ({
        clipLabel: b.label,
        startSec: b.startSec,
        endSec: b.endSec,
        narration: b.narration,
        cue: b.cue,
      }));
    } else {
      await page.waitForTimeout(1500);
      await slowScroll(page, "down", 8000);
      await page.waitForTimeout(500);
      await slowScroll(page, "up", 4000);
      await page.waitForTimeout(500);
    }
  } finally {
    await context.close();
  }
  const durationSec = (Date.now() - recordingStartMs) / 1000;

  const written = (await readdir(formatDir)).filter((f) => f.endsWith(".webm"));
  if (written.length === 0) throw new Error(`No video recorded in ${formatDir}`);
  if (written.length > 1) {
    throw new Error(`Expected one .webm in ${formatDir}, found ${written.length}`);
  }
  const finalPath = join(args.videoDir, `${args.formatKey}.webm`);
  await rename(join(formatDir, written[0]!), finalPath);

  return {
    path: finalPath,
    label: spec.label,
    durationSec,
    beat: `${spec.label} — ${args.url}`,
    group: args.formatKey,
    beats,
  };
}

async function preparePageForCapture(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      html,
      body {
        width: 100vw !important;
        max-width: 100vw !important;
        overflow-x: hidden !important;
        overscroll-behavior-x: none !important;
      }

      * {
        scroll-behavior: auto !important;
      }
    `,
  }).catch(() => {});
  await installHorizontalScrollLock(page);
}

/**
 * Smooth requestAnimationFrame-driven scroll with ease-in-out. The browser
 * code is passed as a STRING so tsx/esbuild can't inject __name helpers
 * (they don't exist in the browser sandbox).
 */
async function slowScroll(page: Page, direction: "up" | "down", durationMs: number): Promise<void> {
  await page.evaluate(`new Promise((resolve) => {
    const startTime = performance.now();
    const ms = ${durationMs};
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const from = ${JSON.stringify(direction)} === "up" ? window.scrollY : 0;
    const to = ${JSON.stringify(direction)} === "up" ? 0 : max;
    const tick = () => {
      const t = Math.min(1, (performance.now() - startTime) / ms);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      window.scrollTo(0, from + (to - from) * eased);
      if (t < 1) requestAnimationFrame(tick);
      else resolve(undefined);
    };
    tick();
  })`);
}
