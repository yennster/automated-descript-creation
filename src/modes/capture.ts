import { chromium, type Page } from "playwright";
import { mkdir, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Clip } from "../types.js";

/**
 * `capture` mode: open a deployed app in a real browser, perform a gentle
 * automated "tour" (navigate → settle → slow scroll), and record it as a
 * single clip.
 *
 * v1: one clip, useful as a placeholder you can replace.
 * v2 (todo): segment into multiple clips driven by the `describe` text — use
 *            Claude with vision to pick what to click; each step becomes a
 *            clip with its own beat.
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

  const startMs = Date.now();
  try {
    await page.goto(args.url, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(1500);
    await slowScroll(page, "down", 8000);
    await page.waitForTimeout(500);
    await slowScroll(page, "up", 4000);
    await page.waitForTimeout(500);
  } finally {
    // Recording is finalized when the context closes; the file lands in
    // videoDir under an auto-generated name. Don't use video.saveAs() —
    // saveAs after browser.close() throws, and the call sequencing is
    // fragile. Renaming the file is simpler and reliable.
    await context.close();
    await browser.close();
  }
  const durationSec = (Date.now() - startMs) / 1000;

  const written = (await readdir(videoDir)).filter((f) => f.endsWith(".webm"));
  if (written.length === 0) throw new Error(`No video was recorded in ${videoDir}`);
  if (written.length > 1) {
    throw new Error(
      `Expected one .webm in ${videoDir}, found ${written.length}: ${written.join(", ")}`,
    );
  }
  const recordedPath = join(videoDir, written[0]!);
  const finalPath = join(videoDir, "tour.webm");
  if (recordedPath !== finalPath) {
    await rename(recordedPath, finalPath);
  }

  return [
    {
      path: finalPath,
      label: "Site tour",
      durationSec,
      beat: `Landing page of ${args.url}, slow scroll through the page.`,
    },
  ];
}

/**
 * Smooth requestAnimationFrame-driven scroll, with ease-in-out so the start
 * and stop don't feel abrupt.
 *
 * The browser code is passed to page.evaluate as a STRING rather than a
 * function — when it's a string, Playwright sends the source verbatim and
 * tsx/esbuild never transforms it. (When it's a function, esbuild wraps
 * named functions with a __name() helper that doesn't exist in the page,
 * which throws ReferenceError.)
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
