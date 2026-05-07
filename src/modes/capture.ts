import { chromium, type Browser, type Page } from "playwright";
import { mkdir, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Clip } from "../types.js";

export type CaptureFormat =
  | "desktop"
  | "desktop-4k"
  | "desktop-720p"
  | "mobile"
  | "mobile-720p";

interface FormatSpec {
  label: string;
  /**
   * The viewport dimensions. We deliberately make this 1:1 with the
   * recordVideo size: Playwright records the framebuffer at the logical
   * viewport, so a recordVideo size larger than the viewport gets gray
   * letterbox padding instead of pixel-perfect output. Setting them equal
   * means the page fills the recording.
   *
   * Trade-off: at 4K, the page renders into a 3840-wide viewport — most
   * apps designed for ~1920 desktop will show tiny text. Default desktop
   * is 1080p; opt into desktop-4k explicitly.
   */
  viewport: { width: number; height: number };
  /** Sets isMobile + hasTouch on the context so mobile breakpoints fire. */
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
 * `capture` mode: open a deployed app in a real browser, perform a gentle
 * automated tour, and record it. With multiple formats specified, runs once
 * per format on the same browser instance — useful for getting a desktop +
 * Shorts/Reels cut from a single command.
 */
export async function captureUrl(args: {
  url: string;
  describe: string;
  outputDir: string;
  formats: CaptureFormat[];
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
}): Promise<Clip> {
  const spec = FORMAT_PRESETS[args.formatKey];
  // Each format gets its own subdir so we can confidently rename — Playwright
  // auto-names video files and we'd otherwise have to disambiguate.
  const formatDir = resolve(args.videoDir, args.formatKey);
  await mkdir(formatDir, { recursive: true });

  const context = await args.browser.newContext({
    viewport: spec.viewport,
    isMobile: spec.isMobile,
    hasTouch: spec.isMobile,
    recordVideo: { dir: formatDir, size: spec.viewport },
  });
  const page = await context.newPage();

  const startMs = Date.now();
  try {
    await page.goto(args.url, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(1500);
    await slowScroll(page, "down", 8000);
    await page.waitForTimeout(500);
    await slowScroll(page, "up", 4000);
    await page.waitForTimeout(500);
  } finally {
    await context.close();
  }
  const durationSec = (Date.now() - startMs) / 1000;

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
    beat: `${spec.label} — landing page of ${args.url}, slow scroll through the page.`,
    group: args.formatKey,
  };
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
