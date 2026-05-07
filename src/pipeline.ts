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
  const result: RunResult = { transcriptPath, manifestPath };
  const token = process.env.DESCRIPT_API_TOKEN;
  const driveId = process.env.DESCRIPT_DRIVE_ID;
  const upload = args.uploadToDescript !== false && token && driveId;

  if (!upload) {
    console.log(
      `[pipeline] Skipping Descript upload (${
        token && driveId ? "explicitly disabled" : "DESCRIPT_API_TOKEN/DRIVE_ID not set"
      }). Transcript + manifest are ready locally.`,
    );
    return result;
  }

  const descript = new DescriptClient(token!, driveId!);
  let projectId: string | undefined;

  for (let i = 0; i < args.clips.length; i++) {
    const clip = args.clips[i]!;
    const isFirst = i === 0;
    console.log(
      `[pipeline] uploading clip ${i + 1}/${args.clips.length} (${clip.label}) → Descript`,
    );
    const out = await descript.importLocalFile({
      filePath: clip.path,
      ...(isFirst ? { projectName: args.name } : { projectId }),
    });
    if (isFirst) projectId = out.projectId;
  }

  result.projectId = projectId;
  console.log(`[pipeline] Descript project: ${projectId}`);

  const linkPath = join(args.outputDir, "descript-link.txt");
  await writeFile(
    linkPath,
    `https://web.descript.com/project/${projectId}\n` +
      `(Open in Descript, then File → Record to add voiceover using transcript.md)\n`,
  );

  return result;
}
