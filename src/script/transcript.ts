import { writeFile } from "node:fs/promises";
import type { TranscriptBeat } from "../types.js";

export async function writeTranscript(args: {
  outputPath: string;
  projectName: string;
  describe: string;
  beats: TranscriptBeat[];
}): Promise<void> {
  const { projectName, describe, beats } = args;
  const total = beats.length === 0 ? 0 : beats[beats.length - 1]!.endSec;

  const lines: string[] = [];
  lines.push(`# ${projectName} — narration script`, "");
  lines.push(`> ${describe}`, "");
  lines.push(`Total length: ~${total.toFixed(0)}s. Read at a relaxed pace; pause between beats.`);
  lines.push("");
  lines.push("Open the Descript project, hit record, and read each beat while its clip plays.");
  lines.push("");

  for (const b of beats) {
    lines.push(`## ${fmtTime(b.startSec)}–${fmtTime(b.endSec)} · ${b.clipLabel}`);
    lines.push("");
    if (b.cue) lines.push(`*${b.cue}*`, "");
    lines.push(b.narration);
    lines.push("");
  }

  await writeFile(args.outputPath, lines.join("\n"), "utf8");
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
