import Anthropic from "@anthropic-ai/sdk";
import type { Clip, TranscriptBeat } from "../types.js";

const MODEL = "claude-sonnet-4-6";

/**
 * Top-level entry point: returns AI-generated narration if ANTHROPIC_API_KEY
 * is set, otherwise returns a placeholder transcript with empty slots and
 * timing markers for the speaker to fill in by hand.
 */
export async function generateNarration(args: {
  describe: string;
  clips: Clip[];
}): Promise<TranscriptBeat[]> {
  if (process.env.ANTHROPIC_API_KEY) {
    return generateWithClaude(args);
  }
  console.log("[narration] ANTHROPIC_API_KEY not set — writing placeholder transcript");
  return placeholderBeats(args.clips);
}

function placeholderBeats(clips: Clip[]): TranscriptBeat[] {
  let cursor = 0;
  return clips.map((c) => {
    const startSec = cursor;
    const endSec = cursor + c.durationSec;
    cursor = endSec;
    return {
      clipLabel: c.label,
      startSec,
      endSec,
      narration: `[Write narration for ${c.beat ? `"${c.beat}"` : `"${c.label}"`} — about ${Math.max(1, Math.round(c.durationSec * 2.3))} words]`,
      cue: "fill in",
    };
  });
}

async function generateWithClaude(args: {
  describe: string;
  clips: Clip[];
}): Promise<TranscriptBeat[]> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

  const totalSec = args.clips.reduce((a, c) => a + c.durationSec, 0);
  const wordsTarget = Math.round(totalSec * 2.3); // ~140 wpm

  const clipsBrief = args.clips
    .map(
      (c, i) =>
        `${i + 1}. "${c.label}" (${c.durationSec.toFixed(1)}s)${
          c.beat ? ` — viewer is seeing: ${c.beat}` : ""
        }`,
    )
    .join("\n");

  const prompt = `You're writing the narration for a short demo video about a project the speaker built.
The speaker will read this aloud while recording voiceover in Descript. Be conversational, specific, and confident — not marketing-speak.

Project description (from the speaker):
${args.describe}

The video has ${args.clips.length} clips, total duration ~${totalSec.toFixed(0)}s. Aim for ~${wordsTarget} words across the whole script (≈140 wpm; leave a little breathing room).

Clips, in order:
${clipsBrief}

Output STRICT JSON, no prose, with this shape:
{
  "beats": [
    { "clipLabel": "...", "narration": "...", "cue": "optional one-line direction like 'pause briefly' or 'click is on screen here'" }
  ]
}

One beat per clip, same order as listed. The narration field is what the speaker says during that clip.`;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  const text = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();

  const jsonStr = extractJson(text);
  const parsed = JSON.parse(jsonStr) as {
    beats: { clipLabel: string; narration: string; cue?: string }[];
  };

  let cursor = 0;
  return parsed.beats.map((b, i) => {
    const clip = args.clips[i];
    if (!clip) throw new Error(`Beat ${i} has no matching clip`);
    const startSec = cursor;
    const endSec = cursor + clip.durationSec;
    cursor = endSec;
    return {
      clipLabel: b.clipLabel || clip.label,
      startSec,
      endSec,
      narration: b.narration,
      cue: b.cue,
    };
  });
}

function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error(`No JSON in model output: ${text.slice(0, 200)}`);
  return text.slice(first, last + 1);
}
