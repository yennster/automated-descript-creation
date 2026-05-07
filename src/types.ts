export interface Clip {
  /** Absolute path to the local media file (mp4 / mov / png-as-still). */
  path: string;
  /** Display label shown in Descript and in the transcript. */
  label: string;
  /** Duration in seconds. For stills, this is how long they should hold. */
  durationSec: number;
  /** Optional: what the viewer is seeing during this clip. Feeds the script generator. */
  beat?: string;
  /**
   * Optional grouping key. Clips with different keys go into separate
   * Descript projects so each project's composition can have a matching
   * aspect ratio. Set by `capture` mode (one group per --format).
   */
  group?: string;
  /**
   * Pre-built beats for this clip's timeline, with start/end times relative
   * to the clip start. Set by capture mode when an action flow is run —
   * each click/fill/scroll becomes one beat. When present, the transcript
   * writer uses these directly instead of asking the model to generate one.
   */
  beats?: TranscriptBeat[];
}

export interface RunInput {
  /** Project name shown in Descript. */
  name: string;
  /** What the demo is about — fed to the narration generator. */
  describe: string;
  /** Ordered clips on the timeline. */
  clips: Clip[];
  /** Output directory for artifacts. */
  outputDir: string;
}

export interface TranscriptBeat {
  clipLabel: string;
  startSec: number;
  endSec: number;
  narration: string;
  cue?: string;
}

export interface RunResult {
  projectId?: string;
  shareUrl?: string;
  transcriptPath: string;
  manifestPath: string;
}
