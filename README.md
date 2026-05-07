# automated-descript-creation

Automate demo videos for AI-built apps via [Descript](https://descript.com).
You bring an app (or clips, or just an idea); the tool produces a Descript
project draft + a narration transcript ready for you to record your voice over.

## Modes

| Mode      | Input                                                  | What it does                                                            |
| --------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `capture` | URL of a deployed app + a description of what to demo  | Drives the app in a headed browser via Playwright, screen-records it.   |
| `stitch`  | A folder of clips you recorded yourself                | Uploads them in order, generates narration timed to each clip.          |
| `mock`    | Just a prompt / feature description                    | Generates title-card placeholder slides so you can record over them.    |

All three modes converge on the same output:

1. A **Descript project** created via the API, with your media on the timeline.
2. A `transcript.md` file with narration broken into beats, timed to the clips,
   so you can record voice in Descript directly into the project.

## AI is optional

`ANTHROPIC_API_KEY` is **only** used to generate two kinds of text: narration
script (all modes) and slide outlines (`mock` only). Without a key:

- The Descript project, clips/slides, and timing all still get produced.
- `transcript.md` is written with `[Write narration for ...]` placeholders so
  you can fill in the script yourself in any text editor.
- `mock` falls back to a simple heuristic — newlines or sentences in your
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
it; that's your `DESCRIPT_DRIVE_ID`). The Anthropic key is optional — see "AI is
optional" above.

## Usage

```bash
# capture: drive a deployed app and record
npm run capture -- \
  --url https://my-app.vercel.app \
  --describe "Sign up flow, then create a new project, then invite a teammate" \
  --name "MyApp demo"

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

Output lands in `./output/<run-id>/`:

- `descript-link.txt` — link to open the draft project in Descript
- `transcript.md` — narration script, with timestamps and per-clip cues
- `manifest.json` — what was uploaded, in what order, with durations

## Status

Early scaffold. The pipeline, Descript client, and transcript generator are
wired up. `capture` uses Playwright recording; `stitch` takes a clip folder;
`mock` generates 1080p SVG title cards (no ffmpeg dep — Descript holds each
SVG on the timeline for the duration we pass).

See `src/` for the layout. The Descript API surface used:

- `POST /v1/jobs/import/project_media` — create project + composition with media
- `POST /v1/jobs/publish` — export when ready
- `GET /v1/jobs/{id}` — poll job status

There's also `POST /v1/jobs/agent` for natural-language edits, which we may
use to auto-trim awkward pauses once recordings exist.
