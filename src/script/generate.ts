import type { Clip, TranscriptBeat } from "../types.js";

/**
 * Top-level entry point.
 *
 * Order of preference:
 * 1. Pre-built beats on the clips (set by capture mode's action flow). Used
 *    verbatim with an offset adjustment so beat times are absolute within
 *    the run rather than relative to each clip.
 * 2. Placeholder transcript with [Write narration for ...] slots.
 */
export async function generateNarration(args: {
  describe: string;
  clips: Clip[];
}): Promise<TranscriptBeat[]> {
  if (args.clips.some((c) => c.beats && c.beats.length > 0)) {
    return prebuiltBeats(args.clips);
  }

  console.log("[narration] writing placeholder transcript");
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
