# automated-descript-creation

Automate demo videos for AI-built apps via [Descript](https://descript.com).
You bring an app (or clips, or just an idea); the tool produces a Descript
project draft + a narration transcript ready for you to record your voice
over.

## Modes

| Mode      | Input                                                  | What it does                                                            |
| --------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `capture` | URL of a deployed app + a description of what to demo  | Drives the app in headless Chromium, records a 4K tour by default.      |
| `stitch`  | A folder of clips you recorded yourself                | Uploads them in order; auto-detects durations via `ffprobe`.            |
| `mock`    | Just a prompt / feature description                    | Generates title-card SVG slides so you can record over them.            |

All three converge on the same output:

1. A **Descript project** created via the API, with your media on the timeline.
2. A `transcript.md` file with narration broken into beats, timed to the clips,
   so you can record voice in Descript directly into the project.
3. A `manifest.json` snapshot of inputs, durations, and beats.

## AI is optional

`ANTHROPIC_API_KEY` is **only** used to generate two kinds of text: narration
script (all modes) and slide outlines (`mock` only). Without a key:

- The Descript project, clips/slides, and timing all still get produced.
- `transcript.md` is written with `[Write narration for ...]` placeholders so
  you can fill in the script yourself in any text editor.
- `mock` falls back to a heuristic — newlines or sentences in your `--describe`
  become slide headlines.

So if Anthropic billing isn't set up (Claude Max alone doesn't grant API
access), you can still use everything; you just write the script.

## Setup

```bash
npm install
npx playwright install chromium    # needed for capture mode only
cp .env.example .env               # add DESCRIPT_API_TOKEN; rest is optional
```

Get a Descript API token at Settings → API tokens. The Drive ID is optional
(inherited from the token by the import endpoint).

## Usage

```bash
# capture: drive a deployed app and record (default: 4K desktop)
npm run capture -- \
  --url https://my-app.vercel.app \
  --describe "Sign up flow, then create a project, then invite a teammate" \
  --name "MyApp demo"

# capture in BOTH desktop 4K and mobile portrait (Shorts/Reels) in one run
npm run capture -- \
  --url https://my-app.vercel.app \
  --describe "..." \
  --name "MyApp demo" \
  --format desktop,mobile

# stitch: bring your own clips
npm run stitch -- \
  --clips ./recordings/ \
  --describe "What I built and why it's cool" \
  --name "MyApp demo"

# mock: prompt-only title-card slides
npm run mock -- \
  --describe "A todo app with AI subtask generation. 60 seconds." \
  --name "MyApp demo"
```

## Capture formats

`--format` accepts a comma-separated list. Pick one or many; you get one clip
per format on the same Descript timeline (drag onto separate compositions in
Descript when you're ready to export different aspect ratios).

| Format          | Logical viewport | DPR | Video output | Use for                              |
| --------------- | ---------------- | --- | ------------ | ------------------------------------ |
| `desktop`       | 1920 × 1080      | 2   | 3840 × 2160  | YouTube desktop, 4K master (default) |
| `desktop-1080p` | 1920 × 1080      | 1   | 1920 × 1080  | Smaller files, faster uploads        |
| `desktop-720p`  | 1280 × 720       | 1   | 1280 × 720   | Low bandwidth, draft cuts            |
| `mobile`        |  540 × 960       | 2   | 1080 × 1920  | YouTube Shorts, Instagram Reels, TikTok |
| `mobile-720p`   |  360 × 640       | 2   |  720 × 1280  | Smaller mobile cuts                  |

The retina-DPR formats (`desktop`, `mobile`, `mobile-720p`) render the page at
a normal logical viewport with `deviceScaleFactor: 2`, then capture at the
2× raster. That's why text stays readable at 4K — the page lays out for a
1920px-wide screen, not a 3840px-wide one.

For mobile formats, Playwright also sets `isMobile: true` and `hasTouch: true`,
so your app's mobile breakpoints kick in.

## Output

Output lands in `./output/<run-id>/`:

- `descript-link.txt` — link to the draft project in Descript
- `transcript.md` — narration script (or placeholder slots), with timestamps
- `manifest.json` — what was uploaded, in what order, with durations
- `raw/` — the local media files (e.g. `desktop.webm`, `mobile.webm`)

## Status

Working scaffold. Verified live against the Descript API: capture, stitch, and
mock all produce real Descript projects.

Known limitations:

- `capture` is a v1 "scroll tour" — one clip per format. Driving multi-step
  interactions per beat (via Claude with vision) is the obvious next upgrade.
- Slides are SVG — Descript's importer accepts them.
- `publishComposition` is implemented but untested end-to-end (no completed
  draft to publish yet).

## Descript API surface used

- `POST /v1/jobs/import/project_media` — create project + composition with media
  in one round trip; response returns signed `upload_urls` per media key.
- `POST /v1/jobs/publish` — render and publish a composition.
- `GET /v1/jobs/{id}` — poll job status (transcription, processing).
- `GET /v1/status` — sanity check + drive_id discovery.

There's also `POST /v1/jobs/agent` for natural-language edits, which we may
use to auto-trim awkward pauses once recordings exist.
