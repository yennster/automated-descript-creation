import { request } from "undici";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

const BASE = "https://descriptapi.com/v1";

export interface MediaSpec {
  /** Display name shown in Descript and used as the media key. Must be unique within the request. */
  displayName: string;
  /** Path to a local file. Mutually exclusive with `url`. */
  filePath?: string;
  /** Remote URL Descript will fetch directly. Mutually exclusive with `filePath`. */
  url?: string;
  /** Override content type detection. Inferred from extension if omitted. */
  contentType?: string;
}

export interface CreateProjectResponse {
  jobId: string;
  projectId: string;
  projectUrl: string;
  /** Map keyed by displayName; only present for media items requesting direct upload. */
  uploadUrls: Record<string, { uploadUrl: string; assetId: string; artifactId: string }>;
}

export class DescriptClient {
  /**
   * driveId is no longer required for /jobs/import/project_media (it's
   * inherited from the token), but we keep it for /v1/status sanity checks
   * and forward-compat with endpoints that need it.
   */
  constructor(
    private readonly token: string,
    private readonly _driveId?: string,
  ) {
    if (!token) throw new Error("DESCRIPT_API_TOKEN is required");
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Create a project (or add to an existing one), declare media + composition
   * layout, and receive signed upload URLs for any local files.
   *
   * The caller still needs to PUT the bytes to each signed URL — see
   * `putBytes` and the `importLocalFiles` end-to-end helper below.
   */
  async createProjectWithMedia(args: {
    projectId?: string;
    projectName?: string;
    media: MediaSpec[];
    compositionName?: string;
  }): Promise<CreateProjectResponse> {
    if (args.media.length === 0) throw new Error("At least one media item required");

    const addMedia: Record<string, Record<string, unknown>> = {};
    const clips: { media: string }[] = [];

    for (const m of args.media) {
      const key = m.displayName;
      if (key in addMedia) throw new Error(`Duplicate media displayName: ${key}`);
      if (m.filePath && m.url) {
        throw new Error(`Media ${key}: pass filePath OR url, not both`);
      }

      if (m.url) {
        addMedia[key] = { url: m.url };
      } else if (m.filePath) {
        const size = (await stat(m.filePath)).size;
        addMedia[key] = {
          content_type: m.contentType ?? guessContentType(m.filePath),
          file_size: size,
        };
      } else {
        throw new Error(`Media ${key}: must specify filePath or url`);
      }
      clips.push({ media: key });
    }

    const body: Record<string, unknown> = {
      add_media: addMedia,
      add_compositions: [
        {
          name: args.compositionName ?? args.projectName ?? "Main",
          clips,
        },
      ],
    };
    if (args.projectId) body.project_id = args.projectId;
    else if (args.projectName) body.project_name = args.projectName;
    else throw new Error("Either projectId or projectName is required");

    const res = await request(`${BASE}/jobs/import/project_media`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      throw new Error(`createProjectWithMedia ${res.statusCode}: ${text}`);
    }
    const json = (await res.body.json()) as {
      job_id: string;
      project_id: string;
      project_url: string;
      upload_urls?: Record<
        string,
        { upload_url: string; asset_id: string; artifact_id: string }
      >;
    };
    const uploadUrls: CreateProjectResponse["uploadUrls"] = {};
    for (const [k, v] of Object.entries(json.upload_urls ?? {})) {
      uploadUrls[k] = {
        uploadUrl: v.upload_url,
        assetId: v.asset_id,
        artifactId: v.artifact_id,
      };
    }
    return {
      jobId: json.job_id,
      projectId: json.project_id,
      projectUrl: json.project_url,
      uploadUrls,
    };
  }

  async putBytes(uploadUrl: string, filePath: string, contentType: string): Promise<void> {
    const buf = await readFile(filePath);
    const res = await request(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: buf,
    });
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      throw new Error(`putBytes ${res.statusCode}: ${text.slice(0, 300)}`);
    }
  }

  async getJob(jobId: string): Promise<{
    job_state: string;
    result?: {
      status: string;
      project_id?: string;
      composition_id?: string;
      created_compositions?: { id: string; name: string }[];
    };
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
      result?: {
        status: string;
        project_id?: string;
        composition_id?: string;
        created_compositions?: { id: string; name: string }[];
      };
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
        if (job.result.status !== "ok" && job.result.status !== "success") {
          throw new Error(`Job ${jobId} finished with status=${job.result.status}`);
        }
        return job.result;
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`Job ${jobId} did not complete within ${timeout}ms`);
  }

  /**
   * End-to-end helper: create a project (or add to an existing one) with N
   * local files, upload all bytes in parallel, return the project_id.
   *
   * Set waitForJob=true if you need processing/transcription to finish before
   * proceeding (e.g. before publishing).
   */
  async importLocalFiles(args: {
    projectId?: string;
    projectName?: string;
    files: { path: string; displayName?: string; contentType?: string }[];
    compositionName?: string;
    waitForJob?: boolean;
  }): Promise<{
    projectId: string;
    projectUrl: string;
    jobId: string;
    compositionId?: string;
  }> {
    const media: MediaSpec[] = args.files.map((f) => ({
      displayName: f.displayName ?? basename(f.path),
      filePath: f.path,
      contentType: f.contentType,
    }));

    const created = await this.createProjectWithMedia({
      projectId: args.projectId,
      projectName: args.projectName,
      media,
      compositionName: args.compositionName,
    });

    await Promise.all(
      args.files.map(async (f) => {
        const name = f.displayName ?? basename(f.path);
        const slot = created.uploadUrls[name];
        if (!slot) throw new Error(`No upload_url returned for ${name}`);
        const ct = f.contentType ?? guessContentType(f.path);
        await this.putBytes(slot.uploadUrl, f.path, ct);
      }),
    );

    const jobResult = args.waitForJob ? await this.pollJob(created.jobId) : undefined;
    const compositionId = jobResult?.composition_id ?? jobResult?.created_compositions?.[0]?.id;

    return {
      projectId: created.projectId,
      projectUrl: created.projectUrl,
      jobId: created.jobId,
      compositionId,
    };
  }

  async agentEdit(args: {
    projectId: string;
    prompt: string;
    compositionId?: string;
    waitForJob?: boolean;
  }): Promise<{ jobId: string; projectUrl: string; projectChanged?: boolean }> {
    const body: Record<string, unknown> = {
      project_id: args.projectId,
      prompt: args.prompt,
    };
    if (args.compositionId) body.composition_id = args.compositionId;

    const res = await request(`${BASE}/jobs/agent`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      throw new Error(`agentEdit ${res.statusCode}: ${text}`);
    }

    const json = (await res.body.json()) as {
      job_id: string;
      project_url: string;
    };
    const result = args.waitForJob ? await this.pollJob(json.job_id) : undefined;
    return {
      jobId: json.job_id,
      projectUrl: json.project_url,
      projectChanged: (result as { project_changed?: boolean } | undefined)?.project_changed,
    };
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
    const jobJson = (await res.body.json()) as { job_id: string };
    const result = await this.pollJob(jobJson.job_id, { timeoutMs: 15 * 60 * 1000 });
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
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
