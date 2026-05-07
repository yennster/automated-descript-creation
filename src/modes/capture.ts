import { chromium, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Clip } from "../types.js";

/**
 * Mode 2a: open a deployed app in a real browser, perform a gentle automated
 * "tour" (navigate → settle → slow scroll), and record it as a single clip.
 *
 * This is intentionally minimal. The plan:
 *   v1 (now): one clip, ~14s, useful as a placeholder you can replace.
 *   v2 (todo): segment into multiple clips driven by the `describe` text — use
 *              Claude with vision to pick what to click; each step becomes a
 *              clip with its own beat.
 */
export async function captureUrl(args: {
  url: string;
  describe: string;
  outputDir: string;
}): Promise<Clip[]> {
  const videoDir = resolve(args.outputDir, "raw");
  await mkdir(videoDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();

  try {
    await page.goto(args.url, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(1500);
    await slowScrollToBottom(page, 8000);
    await page.waitForTimeout(500);
    await slowScrollToTop(page, 4000);
    await page.waitForTimeout(500);
  } finally {
    const video = page.video();
    await context.close();
    await browser.close();
    if (!video) throw new Error("No video was recorded");
    const finalPath = join(videoDir, "tour.webm");
    await video.saveAs(finalPath);

    return [
      {
        path: finalPath,
        label: "Site tour",
        durationSec: 14,
        beat: `Landing page of ${args.url}, slow scroll through the page.`,
      },
    ];
  }
}

async function slowScrollToBottom(page: Page, durationMs: number): Promise<void> {
  await page.evaluate(async (ms) => {
    const start = performance.now();
    const max = document.documentElement.scrollHeight - window.innerHeight;
    return new Promise<void>((resolve) => {
      function step(): void {
        const t = Math.min(1, (performance.now() - start) / ms);
        window.scrollTo(0, max * t);
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      }
      step();
    });
  }, durationMs);
}

async function slowScrollToTop(page: Page, durationMs: number): Promise<void> {
  await page.evaluate(async (ms) => {
    const start = performance.now();
    const from = window.scrollY;
    return new Promise<void>((resolve) => {
      function step(): void {
        const t = Math.min(1, (performance.now() - start) / ms);
        window.scrollTo(0, from * (1 - t));
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      }
      step();
    });
  }, durationMs);
}
