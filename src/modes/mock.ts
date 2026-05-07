import Anthropic from "@anthropic-ai/sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Clip } from "../types.js";

const MODEL = "claude-opus-4-7";

/**
 * Mode 2c: prompt-only. There's no real app yet — just an idea. We ask Claude
 * to break the description into N "shots" and write each as a title-card SVG.
 *
 * The SVGs land in raw/ and are referenced as Clips. Descript's importer
 * accepts images and holds them on the timeline for the duration we pass.
 *
 * No native deps (no canvas, no ffmpeg). Trade-off: slides are static.
 */
export async function mockFromPrompt(args: {
  describe: string;
  outputDir: string;
  targetSeconds?: number;
}): Promise<Clip[]> {
  const target = args.targetSeconds ?? 60;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
  const client = new Anthropic({ apiKey });

  const prompt = `You're planning a short demo video about a project the speaker hasn't built yet.
The speaker will record voiceover later; right now you're producing a SHOT LIST of title-card slides.

Project pitch:
${args.describe}

Constraints:
- Total target length: ~${target} seconds.
- Each slide holds for 4–8 seconds (pick a duration per slide that fits the beat).
- 5 to 10 slides total.
- Each slide has a short headline (≤6 words) and an optional sub-line (≤12 words).

Output STRICT JSON, no prose:
{
  "slides": [
    { "headline": "...", "sub": "optional", "durationSec": 6, "beat": "what the viewer is meant to take away" }
  ]
}`;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  const text = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  const json = JSON.parse(extractJson(text)) as {
    slides: { headline: string; sub?: string; durationSec: number; beat?: string }[];
  };

  const slidesDir = resolve(args.outputDir, "raw");
  await mkdir(slidesDir, { recursive: true });

  const clips: Clip[] = [];
  let i = 0;
  for (const s of json.slides) {
    i += 1;
    const fileName = `slide-${String(i).padStart(2, "0")}.svg`;
    const filePath = join(slidesDir, fileName);
    await writeFile(filePath, renderSlideSvg(s.headline, s.sub), "utf8");
    clips.push({
      path: filePath,
      label: s.headline,
      durationSec: s.durationSec,
      beat: s.beat,
    });
  }
  return clips;
}

function renderSlideSvg(headline: string, sub?: string): string {
  const safeHeadline = escapeXml(headline);
  const safeSub = sub ? escapeXml(sub) : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#bg)"/>
  <text x="960" y="${safeSub ? 480 : 540}" text-anchor="middle"
        font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        font-size="120" font-weight="700" fill="#f8fafc">${safeHeadline}</text>
  ${
    safeSub
      ? `<text x="960" y="620" text-anchor="middle"
          font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
          font-size="48" font-weight="400" fill="#94a3b8">${safeSub}</text>`
      : ""
  }
</svg>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error(`No JSON in output: ${text.slice(0, 200)}`);
  return text.slice(first, last + 1);
}
