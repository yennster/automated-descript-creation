#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { runPipeline } from "./pipeline.js";
import { captureUrl, isCaptureFormat, FORMAT_PRESETS, type CaptureFormat } from "./modes/capture.js";
import {
  loadActionsFromFile,
  type CaptureAction,
} from "./modes/capture-actions.js";
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
  .requiredOption("-n, --name <name>", "Descript project name")
  .option("-d, --description <text>", "What to demo / why it's interesting (defaults to --name)")
  .option("--describe <text>", "Deprecated alias for --description")
  .option(
    "-f, --format <list>",
    `Comma-separated formats. Choices: ${Object.keys(FORMAT_PRESETS).join(", ")}`,
    "desktop",
  )
  .option(
    "-a, --actions <path>",
    "Path to a JSON file with click-through actions. See README for schema.",
  )
  .option("--no-upload", "Skip Descript upload, just generate transcript locally")
  .action(async (opts) => {
    const formats = parseFormats(opts.format);
    const description = descriptionFromName(opts, "capture");
    const outputDir = await prepareOutputDir(opts.name);
    const actions = await resolveCaptureActions({
      actionsPath: opts.actions,
    });
    const clips = await captureUrl({
      url: opts.url,
      outputDir,
      formats,
      actions,
    });
    await runPipelineGrouped({
      baseName: opts.name,
      describe: description,
      clips,
      baseOutputDir: outputDir,
      uploadToDescript: opts.upload,
    });
  });

program
  .command("stitch")
  .description("take an existing folder of clips, draft in Descript")
  .requiredOption("-c, --clips <dir>", "Folder containing video clips")
  .requiredOption("-n, --name <name>", "Descript project name")
  .option("-d, --description <text>", "What the demo is about (defaults to --name)")
  .option("--describe <text>", "Deprecated alias for --description")
  .option("--no-upload", "Skip Descript upload, just generate transcript locally")
  .action(async (opts) => {
    const description = descriptionFromName(opts, "stitch");
    const outputDir = await prepareOutputDir(opts.name);
    const clips = await stitchClips({ clipsDir: opts.clips });
    await runPipeline({
      name: opts.name,
      describe: description,
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

/**
 * Group clips by their `group` key and run one pipeline per group, so each
 * Descript project gets a composition matching its clips' aspect ratio.
 * Clips without a group key all go into one default project.
 */
async function runPipelineGrouped(args: {
  baseName: string;
  describe: string;
  clips: import("./types.js").Clip[];
  baseOutputDir: string;
  uploadToDescript?: boolean;
}): Promise<void> {
  const groups = new Map<string, import("./types.js").Clip[]>();
  for (const c of args.clips) {
    const key = c.group ?? "_";
    const existing = groups.get(key) ?? [];
    existing.push(c);
    groups.set(key, existing);
  }
  const single = groups.size === 1;
  for (const [groupKey, groupClips] of groups) {
    const isDefault = groupKey === "_";
    const projectName = single || isDefault ? args.baseName : `${args.baseName} — ${groupKey}`;
    const subdir = single
      ? args.baseOutputDir
      : resolve(args.baseOutputDir, isDefault ? "default" : groupKey);
    await mkdir(subdir, { recursive: true });
    await runPipeline({
      name: projectName,
      describe: args.describe,
      clips: groupClips,
      outputDir: subdir,
      uploadToDescript: args.uploadToDescript,
    });
  }
}

/**
 * Decide which click-through actions to run, in priority order:
 *  1. --actions <path> if provided
 *  2. neither → undefined (fall back to scroll tour)
 */
async function resolveCaptureActions(args: {
  actionsPath?: string;
}): Promise<CaptureAction[] | undefined> {
  if (args.actionsPath) {
    const list = await loadActionsFromFile(args.actionsPath);
    console.log(`[capture] loaded ${list.length} action(s) from ${args.actionsPath}`);
    return list;
  }

  console.log(`[capture] no --actions file provided — falling back to scroll tour`);
  return undefined;
}

function parseFormats(raw: string): CaptureFormat[] {
  const tokens = raw.split(",").map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) throw new Error("--format must list at least one format");
  for (const t of tokens) {
    if (!isCaptureFormat(t)) {
      throw new Error(
        `Unknown format "${t}". Valid: ${Object.keys(FORMAT_PRESETS).join(", ")}`,
      );
    }
  }
  return tokens as CaptureFormat[];
}

function descriptionFromName(
  opts: { name: string; description?: string; describe?: string },
  commandName: string,
): string {
  const description = opts.description?.trim();
  const describeAlias = opts.describe?.trim();

  if (description && describeAlias && description !== describeAlias) {
    console.warn(
      `[${commandName}] both --description and --describe were provided; using --description`,
    );
  }

  const resolved = description || describeAlias || opts.name;
  if (!description && !describeAlias) {
    console.log(`[${commandName}] no --description provided; using --name as the description`);
  }
  return resolved;
}

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
