import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DescriptClient } from "./descript/client.js";
import { generateNarration } from "./script/generate.js";
import { writeTranscript } from "./script/transcript.js";
import type { Clip, RunResult, TranscriptBeat } from "./types.js";

export async function runPipeline(args: {
  name: string;
  describe: string;
  clips: Clip[];
  outputDir: string;
  uploadToDescript?: boolean;
}): Promise<RunResult> {
  if (args.clips.length === 0) throw new Error("No clips to process");

  await mkdir(args.outputDir, { recursive: true });

  // 1. Narration first — works whether or not Descript creds exist.
  console.log(`[pipeline] generating narration for ${args.clips.length} clips`);
  const beats = await generateNarration({
    describe: args.describe,
    clips: args.clips,
  });

  const transcriptPath = resolve(args.outputDir, "transcript.md");
  await writeTranscript({
    outputPath: transcriptPath,
    projectName: args.name,
    describe: args.describe,
    beats,
  });
  console.log(`[pipeline] wrote ${transcriptPath}`);

  const manifest = {
    name: args.name,
    describe: args.describe,
    clips: args.clips,
    beats,
    createdAt: new Date().toISOString(),
  };
  const manifestPath = resolve(args.outputDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  // 2. Descript upload — skip if creds missing or user opts out.
  // DRIVE_ID is optional: the import endpoint inherits it from the token.
  const result: RunResult = { transcriptPath, manifestPath };
  const token = process.env.DESCRIPT_API_TOKEN;
  const driveId = process.env.DESCRIPT_DRIVE_ID;
  const upload = args.uploadToDescript !== false && Boolean(token);

  if (!upload) {
    console.log(
      `[pipeline] Skipping Descript upload (${
        token ? "explicitly disabled" : "DESCRIPT_API_TOKEN not set"
      }). Transcript + manifest are ready locally.`,
    );
    return result;
  }

  const descript = new DescriptClient(token!, driveId);
  console.log(`[pipeline] uploading ${args.clips.length} clip(s) → Descript`);
  console.log(`[pipeline] waiting for Descript to process the imported media`);
  const out = await descript.importLocalFiles({
    projectName: args.name,
    compositionName: args.name,
    waitForJob: true,
    files: args.clips.map((c, i) => ({
      path: c.path,
      // keep clip order stable + display labels readable in Descript
      displayName: `${String(i + 1).padStart(2, "0")}-${c.label.replace(/[^\w.-]+/g, "_")}${extOf(c.path)}`,
    })),
  });

  result.projectId = out.projectId;
  console.log(`[pipeline] Descript import processed`);

  await postProcessDescriptComposition({
    descript,
    projectId: out.projectId,
    compositionId: out.compositionId,
    actionBeats: actionTimelineBeats(args.clips),
  });
  console.log(`[pipeline] Descript project: ${out.projectUrl}`);

  const linkPath = join(args.outputDir, "descript-link.txt");
  await writeFile(
    linkPath,
    `${out.projectUrl}\n` +
      `(Open in Descript, then File → Record to add voiceover using transcript.md)\n`,
  );

  return result;
}

async function postProcessDescriptComposition(args: {
  descript: DescriptClient;
  projectId: string;
  compositionId?: string;
  actionBeats: TranscriptBeat[];
}): Promise<void> {
  if (!args.compositionId) {
    console.warn("[pipeline] Could not find Descript composition id; skipping Descript post-process");
    return;
  }

  const splitActionClips = args.actionBeats.length > 0;
  console.log(
    `[pipeline] asking Descript to fit the video layer to the canvas${
      splitActionClips ? ` and split ${args.actionBeats.length} action clip(s)` : ""
    }`,
  );
  try {
    await args.descript.agentEdit({
      projectId: args.projectId,
      compositionId: args.compositionId,
      waitForJob: true,
      prompt: buildDescriptPostProcessPrompt(args.actionBeats),
    });
    console.log(
      `[pipeline] Descript post-process processed${
        splitActionClips ? " (canvas fit + action clips)" : " (canvas fit)"
      }`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[pipeline] Descript post-process failed: ${msg.slice(0, 300)}`);
  }
}

function actionTimelineBeats(clips: Clip[]): TranscriptBeat[] {
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
    }
    offset += clip.durationSec;
  }

  return out;
}

function buildDescriptPostProcessPrompt(actionBeats: TranscriptBeat[]): string {
  const lines = [
    "In this composition, resize and reposition the imported video layer so it fills the entire video canvas. Center it, remove any margins or offset positioning, and keep the visible app/browser recording inside the frame.",
    "Do not add text, captions, music, transitions, or decorative edits.",
  ];

  if (actionBeats.length === 0) return lines.join("\n\n");

  lines.push(
    "Then split the existing recording into a separate timeline clip or scene for each action beat below. Keep the timing boundaries as close as possible to the listed start and end times, without trimming away visible action from inside the range.",
    "For each resulting clip/scene, set its title/name to the listed title. Attach the listed description as the clip/scene notes or description. If Descript does not support notes/descriptions for that item, add the description as a marker/comment at the start of that clip/scene instead.",
    "Action beat list:",
  );

  actionBeats.forEach((beat, index) => {
    lines.push(
      `${index + 1}. ${fmtTime(beat.startSec)}-${fmtTime(beat.endSec)} | Title: ${oneLine(beat.clipLabel)} | Description: ${oneLine(beat.narration)}`,
    );
  });

  return lines.join("\n\n");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i);
}
