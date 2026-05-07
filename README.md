# automated-descript-creation

Automate demo videos for AI-built apps via [Descript](https://descript.com).
You bring an app (or clips, or just an idea); the tool produces a Descript
project draft + a narration transcript ready for you to record your voice over.

## Modes

| Mode    | Input                                        | What it does                                                            |
| ------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| `capture` (2a) | URL of a deployed app + a description of what to demo | Drives the app in a headed browser via Playwright, screen-records it. |
| `stitch`  (2b) | A folder of clips you recorded yourself          | Uploads them in order, generates narration timed to each clip.        |
| `mock`    (2c) | Just a prompt / feature description              | Generates titled placeholder slides so you can record over them later.|

All three modes converge on the same output:

1. A **Descript project** created via the API, with your media on the timeline.
2. A `transcript.md` file with narration broken into beats, timed to the clips,
   so you can record voice in Descript directly into the project.

## AI is optional

`ANTHROPIC_API_KEY` is **only** used to generate two kinds of text: narration
script (all modes) and slide outlines (mode 2c). Without a key:

- The Descript project, clips/slides, and timing all still get produced.
- `transcript.md` is written with `[Write narration for ...]` placeholders so
  you can fill in the script yourself in any text editor.
- Mode 2c falls back to a simple heuristic — newlines or sentences in your
  `--describe` become slide headlines.

So if Anthropic billing isn't set up (Claude Max alone doesn't grant API
access), you can still use everything; you just write the script.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
# DESCRIPT_API_TOKEN is required; ANTHROPIC_API_KEY is optional (see above)
```

Get a Descript API token at Settings → API tokens (pick a Drive when you create
it; that's your `DESCRIPT_DRIVE_ID`). Anthropic key is for narration generation.

## Usage

```bash
# Mode 2a: capture a deployed app
npm run capture -- \
  --url https://my-app.vercel.app \
  --describe "Sign up flow, then create a new project, then invite a teammate" \
  --name "MyApp demo"

# Mode 2b: stitch existing clips
npm run stitch -- \
  --clips ./recordings/ \
  --describe "What I built and why it's cool" \
  --name "MyApp demo"

# Mode 2c: prompt-only mock slides
npm run mock -- \
  --describe "A todo app with AI subtask generation. 60 seconds." \
  --name "MyApp demo"
```

Output lands in `./output/<run-id>/`:

- `descript-link.txt` — link to open the draft project in Descript
- `transcript.md` — narration script, with timestamps and per-clip cues
- `manifest.json` — what was uploaded, in what order, with durations

## Status

Early scaffold. The pipeline, Descript client, and transcript generator are
wired up. Mode 2a uses Playwright recording; 2b takes a clip folder; 2c
generates silent placeholder MP4s with title cards via a tiny SVG → MP4 path
(no ffmpeg dep yet — slides are rendered as 1080p PNGs and held; this will
move to ffmpeg once we add it).

See `src/` for the layout. The Descript API surface used:

- `POST /v1/jobs/import/project_media` — create project + composition with media
- `POST /v1/jobs/publish` — export when ready
- `GET /v1/jobs/{id}` — poll job status

There's also `POST /v1/jobs/agent` for natural-language edits, which we may
use to auto-trim awkward pauses once recordings exist.
