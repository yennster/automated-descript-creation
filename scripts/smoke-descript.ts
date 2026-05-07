/**
 * Smoke test: upload one tiny PNG to Descript via the DescriptClient.
 * Bypasses Claude/narration so it can run without ANTHROPIC_API_KEY.
 *
 * Run: npx tsx scripts/smoke-descript.ts
 */
import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DescriptClient } from "../src/descript/client.js";

// Hand-crafted minimal 1x1 transparent PNG — 67 bytes, no external deps.
const ONE_PIXEL_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

async function main() {
  const token = process.env.DESCRIPT_API_TOKEN;
  const driveId = process.env.DESCRIPT_DRIVE_ID;
  if (!token || !driveId) {
    throw new Error("Missing DESCRIPT_API_TOKEN or DESCRIPT_DRIVE_ID in .env");
  }

  const outDir = resolve(process.cwd(), "output", "_smoke");
  await mkdir(outDir, { recursive: true });
  const filePath = resolve(outDir, "smoke.png");
  await writeFile(filePath, ONE_PIXEL_PNG);
  console.log(`[smoke] wrote ${filePath} (${ONE_PIXEL_PNG.length} bytes)`);

  const client = new DescriptClient(token, driveId);
  const projectName = `adc smoke ${new Date().toISOString().slice(0, 19)}`;

  console.log(`[smoke] creating project "${projectName}"...`);
  const t0 = Date.now();
  const out = await client.importLocalFiles({
    projectName,
    files: [{ path: filePath, contentType: "image/png" }],
  });
  console.log(
    `[smoke] DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s — project=${out.projectId} job=${out.jobId}`,
  );
  console.log(`[smoke] open: ${out.projectUrl}`);
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err.message);
  process.exit(1);
});
