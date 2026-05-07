import type { Clip, TranscriptBeat } from "../types.js";
import { runGemini, extractJson, isGeminiAvailable } from "../ai/gemini.js";

/**
 * Top-level entry point.
 *
 * Order of preference:
 * 1. Pre-built beats on the clips (set by capture mode's action flow). Used
 *    verbatim with an offset adjustment so beat times are absolute within
 *    the run rather than relative to each clip.
 * 2. AI-generated narration via the `gemini` CLI if it's installed.
 * 3. Placeholder transcript with [Write narration for ...] slots.
 */
export async function generateNarration(args: {
  describe: string;
  clips: Clip[];
}): Promise<TranscriptBeat[]> {
  if (args.clips.some((c) => c.beats && c.beats.length > 0)) {
    return prebuiltBeats(args.clips);
  }
  if (await isGeminiAvailable()) {
    try {
      return await generateWithGemini(args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[narration] gemini call failed (${msg.slice(0, 200)}); writing placeholder`);
    }
  } else {
    console.log("[narration] gemini CLI not found — writing placeholder transcript");
  }
  return placeholderBeats(args.clips);
}

function prebuiltBeats(clips: Clip[]): TranscriptBeat[] {
  console.log("[narration] using pre-built beats from capture action flow");
  const out: TranscriptBeat[] = [];
  let offset = 0;
  for (const clip of clips) {
    if (clip.beats && clip.beats.length > 0) {
      for (const b of clip.beats) {
        out.push({
          clipLabel: b.clipLabel,
          startSec: offset + b.startSec,
          endSec: offset + b.endSec,
          narration: b.narration,
          cue: b.cue,
        });
      }
    } else {
      out.push({
        clipLabel: clip.label,
        startSec: offset,
        endSec: offset + clip.durationSec,
        narration: `[Write narration for "${clip.label}"]`,
        cue: "fill in",
      });
    }
    offset += clip.durationSec;
  }
  return out;
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

async function generateWithGemini(args: {
  describe: string;
  clips: Clip[];
}): Promise<TranscriptBeat[]> {
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

  const text = await runGemini({ prompt });
  const parsed = JSON.parse(extractJson(text)) as {
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
