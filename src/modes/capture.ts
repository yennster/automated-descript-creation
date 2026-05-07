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
 * Smooth scroll using Playwright's mouse wheel from the Node side. Avoids
 * page.evaluate so esbuild/tsx helpers (__name, etc.) never leak into the
 * browser sandbox.
 */
async function slowScroll(page: Page, direction: "up" | "down", durationMs: number): Promise<void> {
  const steps = Math.max(1, Math.round(durationMs / 60)); // ~16fps stepping
  const stepInterval = durationMs / steps;
  const sign = direction === "down" ? 1 : -1;
  // 80px per step at the default viewport: ~80 * 16 = 1280px/sec — gentle.
  const dy = sign * 80;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(stepInterval);
  }
}
