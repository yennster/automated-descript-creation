import type { Page } from "playwright";
import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";

export type CaptureAction =
  | { type: "click"; text?: string; selector?: string; beat: string }
  | { type: "fill"; selector: string; value: string; beat: string }
  | { type: "scroll"; direction: "up" | "down"; durationMs?: number; beat: string }
  | { type: "wait"; durationMs: number; beat?: string }
  | { type: "press"; key: string; beat: string };

/** A beat associated with a time range inside a single recorded clip. */
export interface ActionBeat {
  startSec: number;
  endSec: number;
  label: string;
  narration: string;
  cue: string;
}

const PLANNER_MODEL = "claude-sonnet-4-6";

/**
 * Execute a sequence of actions against an already-loaded page, recording the
 * timing of each so the resulting clip can be split into transcript beats.
 *
 * The browser context is recording continuously throughout; this function
 * just runs the actions and returns a beat per action with start/end times
 * relative to the recording start.
 */
export async function runActionFlow(args: {
  page: Page;
  actions: CaptureAction[];
  /** Wall-clock ms when recording started (reference point for beat times). */
  recordingStartMs: number;
  /** Settle time after each action so the visual change registers. */
  postActionPauseMs?: number;
}): Promise<ActionBeat[]> {
  const pause = args.postActionPauseMs ?? 800;
  const beats: ActionBeat[] = [];

  // initial settle so the page is on screen for a moment before motion
  await args.page.waitForTimeout(1500);

  for (const action of args.actions) {
    const startMs = Date.now() - args.recordingStartMs;
    try {
      await executeAction(args.page, action);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[capture] action failed (${action.type}): ${msg.slice(0, 200)}`);
      // record a "failed" beat so transcript still aligns; tour continues
    }
    await args.page.waitForTimeout(pause);
    const endMs = Date.now() - args.recordingStartMs;

    const narration = action.beat ?? `${action.type} step`;
    beats.push({
      startSec: startMs / 1000,
      endSec: endMs / 1000,
      label: shortLabel(action, narration),
      narration,
      cue: action.type,
    });
  }

  return beats;
}

async function executeAction(page: Page, action: CaptureAction): Promise<void> {
  switch (action.type) {
    case "click": {
      const target = action.text
        ? page.getByText(action.text, { exact: false }).first()
        : action.selector
          ? page.locator(action.selector).first()
          : null;
      if (!target) throw new Error("click action requires text or selector");
      await target.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await target.click({ timeout: 10_000 });
      return;
    }
    case "fill": {
      const target = page.locator(action.selector).first();
      await target.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await target.fill(action.value, { timeout: 10_000 });
      return;
    }
    case "scroll": {
      const dur = action.durationMs ?? 4000;
      await smoothScroll(page, action.direction, dur);
      return;
    }
    case "wait":
      await page.waitForTimeout(action.durationMs);
      return;
    case "press":
      await page.keyboard.press(action.key);
      return;
  }
}

/** Smooth rAF scroll; same trick as capture.ts. Body-as-string avoids tsx __name. */
async function smoothScroll(page: Page, direction: "up" | "down", durationMs: number): Promise<void> {
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

function shortLabel(action: CaptureAction, narration: string): string {
  const verb = action.type === "click"
    ? `Click "${action.text ?? action.selector ?? ""}"`
    : action.type === "fill"
      ? `Fill ${action.selector}`
      : action.type === "scroll"
        ? `Scroll ${action.direction}`
        : action.type === "press"
          ? `Press ${action.key}`
          : "Wait";
  // Prefer the verb but cap length
  return verb.length <= 60 ? verb : narration.slice(0, 60);
}

export async function loadActionsFromFile(path: string): Promise<CaptureAction[]> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  const actions = Array.isArray(parsed) ? parsed : parsed.actions;
  if (!Array.isArray(actions)) {
    throw new Error(`Actions file must be a JSON array (or { actions: [...] }): ${path}`);
  }
  for (const a of actions) validateAction(a);
  return actions as CaptureAction[];
}

function validateAction(a: unknown): void {
  if (!a || typeof a !== "object") throw new Error(`Bad action entry: ${JSON.stringify(a)}`);
  const obj = a as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string") throw new Error(`Action missing "type": ${JSON.stringify(a)}`);
  switch (type) {
    case "click":
      if (!obj.text && !obj.selector) {
        throw new Error(`click action needs "text" or "selector": ${JSON.stringify(a)}`);
      }
      return;
    case "fill":
      if (!obj.selector || typeof obj.value !== "string") {
        throw new Error(`fill action needs "selector" and "value": ${JSON.stringify(a)}`);
      }
      return;
    case "scroll":
      if (obj.direction !== "up" && obj.direction !== "down") {
        throw new Error(`scroll direction must be "up" or "down": ${JSON.stringify(a)}`);
      }
      return;
    case "wait":
      if (typeof obj.durationMs !== "number") {
        throw new Error(`wait needs "durationMs": ${JSON.stringify(a)}`);
      }
      return;
    case "press":
      if (typeof obj.key !== "string") {
        throw new Error(`press needs "key": ${JSON.stringify(a)}`);
      }
      return;
    default:
      throw new Error(`Unknown action type: ${type}`);
  }
}

/**
 * Use Claude (with vision) to plan a click-through demo from the describe
 * text + a screenshot of the loaded page.
 *
 * Returns null if no API key is set so the caller can fall back gracefully.
 */
export async function planActionsWithClaude(args: {
  describe: string;
  screenshotPng: Buffer;
  url: string;
}): Promise<CaptureAction[] | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You're scripting a short demo video of a web app. The screenshot shows the app's current state at ${args.url}.

What the speaker wants to demo:
${args.describe}

Output a STRICT JSON action plan — 3 to 7 steps — that drives the demo. Use only these action types:

  { "type": "click", "text": "exact visible button or link text", "beat": "10-20 word narration cue" }
  { "type": "fill", "selector": "CSS selector for the input", "value": "what to type", "beat": "..." }
  { "type": "scroll", "direction": "down" | "up", "durationMs": 4000, "beat": "..." }
  { "type": "wait", "durationMs": 1500, "beat": "..." }

Rules:
- Prefer click-by-text over selectors. Use exact text visible on the page.
- Only target elements visible (or likely-visible after a click) — don't invent UI.
- Each step's "beat" is what the speaker says during that step.

Output JSON only, no prose:
{ "actions": [ ... ] }`;

  const res = await client.messages.create({
    model: PLANNER_MODEL,
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: args.screenshotPng.toString("base64"),
            },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
  });

  const text = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  const json = JSON.parse(extractJson(text)) as { actions: CaptureAction[] };
  for (const a of json.actions) validateAction(a);
  return json.actions;
}

function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error(`No JSON in planner output: ${text.slice(0, 200)}`);
  return text.slice(first, last + 1);
}
