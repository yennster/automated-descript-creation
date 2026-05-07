import { request } from "undici";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

const BASE = "https://descriptapi.com/v1";

export class DescriptClient {
  constructor(
    private readonly token: string,
    private readonly driveId: string,
  ) {
    if (!token) throw new Error("DESCRIPT_API_TOKEN is required");
    if (!driveId) throw new Error("DESCRIPT_DRIVE_ID is required");
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  /**
   * Step 1 of upload: ask Descript for a signed PUT URL.
   * Step 2 (PUT bytes) and step 3 (poll) are below.
   *
   * The API uses a single POST /v1/jobs/import/project_media that accepts
   * EITHER a remote `url` OR `content_type` + `file_size` (for direct upload).
   * In the direct-upload case, the response includes upload_url + a job_id you
   * poll until job_state === "stopped".
   */
  async createImportJob(args: {
    projectId?: string;
    projectName?: string;
    contentType: string;
    fileSize: number;
    displayName: string;
  }): Promise<{ jobId: string; uploadUrl: string }> {
    const body: Record<string, unknown> = {
      drive_id: this.driveId,
      content_type: args.contentType,
      file_size: args.fileSize,
      display_name: args.displayName,
    };
    if (args.projectId) body.project_id = args.projectId;
    else if (args.projectName) body.project_name = args.projectName;

    const res = await request(`${BASE}/jobs/import/project_media`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      throw new Error(`createImportJob ${res.statusCode}: ${text}`);
    }
    const json = (await res.body.json()) as {
      id: string;
      upload_url: string;
    };
    return { jobId: json.id, uploadUrl: json.upload_url };
  }

  async putBytes(uploadUrl: string, filePath: string): Promise<void> {
    const buf = await readFile(filePath);
    const res = await request(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: buf,
    });
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      throw new Error(`putBytes ${res.statusCode}: ${text}`);
    }
  }

  async getJob(jobId: string): Promise<{
    job_state: string;
    result?: { status: string; project_id?: string; composition_id?: string };
  }> {
    const res = await request(`${BASE}/jobs/${jobId}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      throw new Error(`getJob ${res.statusCode}: ${text}`);
    }
    return (await res.body.json()) as {
      job_state: string;
      result?: { status: string; project_id?: string; composition_id?: string };
    };
  }

  async pollJob(
    jobId: string,
    opts: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<NonNullable<Awaited<ReturnType<DescriptClient["getJob"]>>["result"]>> {
    const interval = opts.intervalMs ?? 2000;
    const timeout = opts.timeoutMs ?? 5 * 60 * 1000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const job = await this.getJob(jobId);
      if (job.job_state === "stopped") {
        if (!job.result) throw new Error(`Job ${jobId} stopped without result`);
        if (job.result.status !== "ok") {
          throw new Error(`Job ${jobId} finished with status=${job.result.status}`);
        }
        return job.result;
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`Job ${jobId} did not complete within ${timeout}ms`);
  }

  /** End-to-end helper: upload one local file and wait for it to be imported. */
  async importLocalFile(args: {
    projectId?: string;
    projectName?: string;
    filePath: string;
    contentType?: string;
  }): Promise<{ projectId: string; compositionId?: string }> {
    const fileSize = (await stat(args.filePath)).size;
    const contentType = args.contentType ?? guessContentType(args.filePath);
    const { jobId, uploadUrl } = await this.createImportJob({
      projectId: args.projectId,
      projectName: args.projectName,
      contentType,
      fileSize,
      displayName: basename(args.filePath),
    });
    await this.putBytes(uploadUrl, args.filePath);
    const result = await this.pollJob(jobId);
    if (!result.project_id) {
      throw new Error(`Import job ${jobId} returned no project_id`);
    }
    return { projectId: result.project_id, compositionId: result.composition_id };
  }

  async publishComposition(args: {
    projectId: string;
    compositionId: string;
    resolution?: "720p" | "1080p" | "4k";
  }): Promise<{ shareUrl: string; downloadUrl: string }> {
    const res = await request(`${BASE}/jobs/publish`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        project_id: args.projectId,
        composition_id: args.compositionId,
        resolution: args.resolution ?? "1080p",
      }),
    });
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      throw new Error(`publishComposition ${res.statusCode}: ${text}`);
    }
    const jobJson = (await res.body.json()) as { id: string };
    const result = await this.pollJob(jobJson.id, { timeoutMs: 15 * 60 * 1000 });
    return {
      shareUrl: (result as unknown as { share_url: string }).share_url,
      downloadUrl: (result as unknown as { download_url: string }).download_url,
    };
  }
}

function guessContentType(path: string): string {
  const ext = path.toLowerCase().split(".").pop();
  switch (ext) {
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "webm":
      return "video/webm";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}
