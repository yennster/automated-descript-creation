#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { runPipeline } from "./pipeline.js";
import { captureUrl } from "./modes/capture.js";
import { stitchClips } from "./modes/stitch.js";
import { mockFromPrompt } from "./modes/mock.js";

const program = new Command()
  .name("adc")
  .description("Automate Descript project drafts for AI-built app demos")
  .version("0.1.0");

program
  .command("capture")
  .description("open a URL in Playwright, record a tour, draft in Descript")
  .requiredOption("-u, --url <url>", "URL of the deployed app")
  .requiredOption("-d, --describe <text>", "What to demo / why it's interesting")
  .requiredOption("-n, --name <name>", "Descript project name")
  .option("--no-upload", "Skip Descript upload, just generate transcript locally")
  .action(async (opts) => {
    const outputDir = await prepareOutputDir(opts.name);
    const clips = await captureUrl({
      url: opts.url,
      describe: opts.describe,
      outputDir,
    });
    await runPipeline({
      name: opts.name,
      describe: opts.describe,
      clips,
      outputDir,
      uploadToDescript: opts.upload,
    });
  });

program
  .command("stitch")
  .description("take an existing folder of clips, draft in Descript")
  .requiredOption("-c, --clips <dir>", "Folder containing video clips")
  .requiredOption("-d, --describe <text>", "What the demo is about")
  .requiredOption("-n, --name <name>", "Descript project name")
  .option("--no-upload", "Skip Descript upload, just generate transcript locally")
  .action(async (opts) => {
    const outputDir = await prepareOutputDir(opts.name);
    const clips = await stitchClips({ clipsDir: opts.clips });
    await runPipeline({
      name: opts.name,
      describe: opts.describe,
      clips,
      outputDir,
      uploadToDescript: opts.upload,
    });
  });

program
  .command("mock")
  .description("prompt-only: produce title-card slides + transcript")
  .requiredOption("-d, --describe <text>", "Project pitch / what to demo")
  .requiredOption("-n, --name <name>", "Descript project name")
  .option("-t, --target <sec>", "Target total length in seconds", "60")
  .option("--no-upload", "Skip Descript upload, just generate transcript locally")
  .action(async (opts) => {
    const outputDir = await prepareOutputDir(opts.name);
    const clips = await mockFromPrompt({
      describe: opts.describe,
      outputDir,
      targetSeconds: parseInt(opts.target, 10),
    });
    await runPipeline({
      name: opts.name,
      describe: opts.describe,
      clips,
      outputDir,
      uploadToDescript: opts.upload,
    });
  });

async function prepareOutputDir(name: string): Promise<string> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = resolve(process.cwd(), "output", `${stamp}_${slug}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
