import type { Locator, Page } from "playwright";
import { readFile } from "node:fs/promises";

export type CaptureAction =
  | { type: "click"; text?: string; selector?: string; beat: string }
  | { type: "fill"; selector: string; value: string; beat: string }
  | { type: "scroll"; direction: "up" | "down"; durationMs?: number; beat: string }
  | { type: "wait"; durationMs: number; beat?: string }
  | { type: "press"; key: string; beat: string };

type ClickAction = Extract<CaptureAction, { type: "click" }>;

const CLICK_TIMEOUT_MS = 10_000;
const FALLBACK_CLICK_TIMEOUT_MS = 2_500;

/** A beat associated with a time range inside a single recorded clip. */
export interface ActionBeat {
  startSec: number;
  endSec: number;
  label: string;
  narration: string;
  cue: string;
}

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
    case "click":
      await clickAction(page, action);
      return;
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

async function clickAction(page: Page, action: ClickAction): Promise<void> {
  if (action.selector) {
    await clickLocator(page.locator(action.selector).first(), `selector "${action.selector}"`);
    return;
  }
  if (!action.text) throw new Error("click action requires text or selector");

  const candidates = [
    {
      locator: page.getByRole("button", { name: action.text, exact: false }).first(),
      description: `button text "${action.text}"`,
    },
    {
      locator: page.getByRole("link", { name: action.text, exact: false }).first(),
      description: `link text "${action.text}"`,
    },
    {
      locator: page.getByLabel(action.text, { exact: false }).first(),
      description: `label "${action.text}"`,
    },
    {
      locator: page.getByText(action.text, { exact: false }).first(),
      description: `text "${action.text}"`,
    },
  ];

  let lastError: unknown;
  for (const candidate of candidates) {
    const count = await candidate.locator.count();
    if (count === 0) continue;
    try {
      await clickLocator(candidate.locator, candidate.description);
      return;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error(`No clickable target found for text "${action.text}"`);
}

async function clickLocator(target: Locator, description: string): Promise<void> {
  const count = await target.count();
  if (count === 0) throw new Error(`No element found for ${description}`);

  if (await clickInputControl(target)) return;

  await target.scrollIntoViewIfNeeded({ timeout: FALLBACK_CLICK_TIMEOUT_MS }).catch(() => {});
  try {
    await target.click({ timeout: CLICK_TIMEOUT_MS });
    return;
  } catch (normalClickError) {
    try {
      await target.evaluate((el) => {
        const clickable = el as HTMLElement & { click?: () => void };
        if (typeof clickable.click === "function") {
          clickable.click();
        } else {
          el.dispatchEvent(
            new MouseEvent("click", { bubbles: true, cancelable: true, view: window }),
          );
        }
      });
      console.log(`[capture] used DOM click fallback for ${description}`);
      return;
    } catch {
      try {
        await target.click({ force: true, timeout: FALLBACK_CLICK_TIMEOUT_MS });
        console.log(`[capture] used forced click fallback for ${description}`);
        return;
      } catch (forceClickError) {
        const normalMsg = normalClickError instanceof Error
          ? normalClickError.message
          : String(normalClickError);
        const forceMsg = forceClickError instanceof Error
          ? forceClickError.message
          : String(forceClickError);
        throw new Error(`${normalMsg}; forced click fallback failed: ${forceMsg}`);
      }
    }
  }
}

async function clickInputControl(target: Locator): Promise<boolean> {
  const inputType = await target
    .evaluate((el) => (el instanceof HTMLInputElement ? el.type : null))
    .catch(() => null);
  if (inputType !== "radio" && inputType !== "checkbox") return false;

  try {
    await target.check({ timeout: FALLBACK_CLICK_TIMEOUT_MS });
    return true;
  } catch {}

  try {
    await target.check({ force: true, timeout: FALLBACK_CLICK_TIMEOUT_MS });
    console.log(`[capture] used forced check fallback for ${inputType} input`);
    return true;
  } catch {}

  const clickedLabel = await target
    .evaluate((el) => {
      const input = el as HTMLInputElement;
      const label = input.labels?.[0];
      if (!label) return false;
      label.click();
      return true;
    })
    .catch(() => false);
  if (clickedLabel) {
    console.log(`[capture] used label click fallback for ${inputType} input`);
    return true;
  }

  await target.evaluate((el) => {
    const input = el as HTMLInputElement;
    input.click();
    if (!input.checked) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
      descriptor?.set?.call(input, true);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  console.log(`[capture] used DOM input fallback for ${inputType} input`);
  return true;
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
