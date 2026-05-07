import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DescriptClient } from "./descript/client.js";
import { generateNarration } from "./script/generate.js";
import { writeTranscript } from "./script/transcript.js";
import type { Clip, RunResult } from "./types.js";

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
  await fitDescriptVideoToCanvas({
    descript,
    projectId: out.projectId,
    compositionId: out.compositionId,
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

async function fitDescriptVideoToCanvas(args: {
  descript: DescriptClient;
  projectId: string;
  compositionId?: string;
}): Promise<void> {
  if (!args.compositionId) {
    console.warn("[pipeline] Could not find Descript composition id; skipping canvas fit");
    return;
  }

  console.log(`[pipeline] asking Descript to fit the video layer to the canvas`);
  try {
    await args.descript.agentEdit({
      projectId: args.projectId,
      compositionId: args.compositionId,
      waitForJob: true,
      prompt:
        "In this composition, resize and reposition the imported video layer so it fills the entire video canvas. Center it, remove any margins or offset positioning, and keep the visible app/browser recording inside the frame. Do not add text, captions, music, cuts, or other edits.",
    });
    console.log(`[pipeline] Descript canvas fit processed`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[pipeline] Descript canvas fit failed: ${msg.slice(0, 300)}`);
  }
}

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i);
}
