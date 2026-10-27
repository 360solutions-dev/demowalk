# demogen

**Self-regenerating product demo videos.** One command rebuilds a narrated
walkthrough **from your live app**: Playwright drives the real UI, every
frame is styled in your own branding (spotlight rings, captions, and
skeleton-style redaction of all dynamic data), narration is voiced, and
ffmpeg stitches the final MP4.

When the product changes, you re-run the command — nothing is recorded by
hand, so nothing can silently go stale.

```bash
npm run demo:video              # → demo/out/example/example.mp4
```

- **Always current** — a UI change means a re-run, not a re-shoot.
- **Privacy-safe by construction** — every filled input, table cell and
  record value is redacted on every frame, by the engine. Raw captures are
  deleted after every render.
- **Your branding, not ours** — ring, chip and redaction colors come from
  each project's config; the engine ships neutral fallbacks only.
- **Fails loudly, never lies** — a missing element stops the run with the
  step name, URL and a debug frame. A wrong video cannot be produced silently.

## How it works

Your repo keeps two inputs; demogen turns them into a video in four stages:

```
   demo/journeys/<id>.ts                demo/demo.config.ts
   steps + narration text               baseUrl · auth hook · brand colors
            │                                      │
            └──────────────────┬───────────────────┘
                               ▼
                    ┌─────────────────────┐
  your app      ◄── │  1  CAPTURE          │  signs in with your e2e fixture,
  (localhost)       │     Playwright       │  walks the steps, shoots 2× retina
                    └──────────┬──────────┘  frames + element geometry
                               ▼
                    ┌─────────────────────┐
                    │  2  OVERLAY          │  redacts every dynamic value into
                    │     sharp            │  skeleton bars; draws rings, chips
                    └──────────┬──────────┘  and captions in YOUR colors
                               ▼
                    ┌─────────────────────┐
                    │  3  NARRATE          │  voices each step's narration
                    │     say → ffmpeg     │  into one audio clip
                    └──────────┬──────────┘
                               ▼
                    ┌─────────────────────┐
                    │  4  STITCH           │  per-step segments pinned to the
                    │     ffmpeg           │  audio length → one seamless MP4
                    └──────────┬──────────┘
                               ▼
                   demo/out/<id>/<id>.mp4
                   + demo/journeys/<id>.md   (storyboard, regenerated each run)
```

The engine, starter templates and setup CLI live in this package; journeys
(one `.ts` file per video) live in your repo.

## Requirements

| Required | Why |
|---|---|
| Node 18+ and `tsx` | runs the pipeline |
| `@playwright/test` + Chromium | the capture engine (peer dependency) |
| ffmpeg on the machine | narration conversion + stitching |
| **macOS** (for now) | narration uses the built-in `say`; download a natural voice once via System Settings → Accessibility → Spoken Content → Manage Voices (e.g. "Tom (Enhanced)") |
| A sign-in function | the only app-specific code — repos with e2e tests reuse their auth fixture |
| The app running locally | something to film |

Docs, an e2e suite and test-ids are **not** required — they only make
journeys easier to author or redaction richer when present.

## Quick start

```bash
# 0. ffmpeg (once per machine — check first: `ffmpeg -version`).
#    The 2-minute static build beats compiling via brew:
curl -L "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip" -o /tmp/ffmpeg.zip \
  && unzip -o /tmp/ffmpeg.zip -d /tmp \
  && sudo mv /tmp/ffmpeg /usr/local/bin/ffmpeg \
  && sudo xattr -d com.apple.quarantine /usr/local/bin/ffmpeg 2>/dev/null; ffmpeg -version

# 1. in your app's repo:
npm install --save-dev tsx
npm install --save-dev demogen@github:360solutions-dev/demogen
#    (from a local clone instead: npm i -D --install-links file:../demogen
#     --install-links matters — a symlinked file: install duplicates
#     Playwright's types and breaks tsc)

# 2. only if the repo doesn't already use Playwright:
npm install --save-dev @playwright/test && npx playwright install chromium

# 3. let demogen set itself up (scripts + templates + gitignore, idempotent):
npx demogen-init

# 4. review demo/demo.config.ts — init AUTO-WIRES it when the repo has the
#    common e2e convention (tests/global-setup.ts + tests/fixtures/
#    auth.fixture.ts), detecting the dev port and theme colors too.
#    Otherwise wire the marked spots by hand (the env-loading setup import
#    comes FIRST — the auth fixture reads env when it is imported).

# 5. smoke test — with the app + backend running locally:
npm run demo:video
open demo/out/example/example.mp4
```

Your repo keeps **three small files**:

```
demo/
├── demo.config.ts        # THE app-specific file: baseUrl, auth hook, branding
├── run.ts                # 3-line shim
└── journeys/<id>.ts      # the videos — one file per video
```

Day-to-day:

```bash
npm run demo:video -- --journey=<id>   # build one video
npm run demo:video -- --from=overlay   # re-style an existing capture (also: tts, stitch)
npm run demo:video -- --keep-frames    # keep raw frames while iterating on styling
npm run demo:update                    # pull a newer engine into this repo
```

## Creating a journey

Journeys are **authored, not configured** — usually by an AI coding
assistant: give it the **start and end point** ("start from login, end at the
created record") and it writes `demo/journeys/<id>.ts` following
[`CLAUDE.md`](./CLAUDE.md) — mining your docs for narration, covering every
field on the path, and applying the
[visual style rules](./docs/style-rules.md) that bind every journey.

Every run regenerates a storyboard (`demo/journeys/<id>.md`) with each step's
narration as text — review the script without watching the video.

## Configuration

demogen has **no .env of its own**: real configuration lives in
`demo/demo.config.ts` (typed, committed). Env vars are per-run overrides only:

| Variable | Meaning | Default |
|---|---|---|
| `BASE_URL` | Override the base URL for one run | from config |
| `DEMO_VOICE` | Override the macOS `say` voice | from config |
| `DEMO_VOICE_RATE` | Words per minute | from config / 165 |
| `DEMO_ALLOW_REMOTE` | `1` permits a non-localhost base URL (explicit opt-in) | off |

**Auth env belongs to the host, not to demogen** — the pipeline signs in
through your repo's own e2e fixture, so whatever your e2e suite needs is all
it needs. If `npm run e2e` works on a machine, `npm run demo:video` has
everything besides ffmpeg and the running local app.

Branding is per project — each config passes its own theme's values:

```ts
import type { DemoConfig } from "demogen";
import globalSetup from "../tests/global-setup";
import { createAuthContext } from "../tests/fixtures/auth.fixture";

const config: DemoConfig = {
  baseUrl: process.env.BASE_URL ?? "http://localhost:3000",
  prepare: () => globalSetup(),   // host e2e setup: env + preflight
  createAuthContext,              // the host's own signed-in context
  ringColor: "#2F6FEB",           // spotlight ring   (theme primary)
  chipColor: "#1F2937",           // chips + caption  (theme secondary)
  redactionTint: "#E2E5E9",       // skeleton grey    (theme placeholder tint)
  voice: "Tom (Enhanced)",
};
export default config;
```

## Privacy posture

Designed for products whose screens hold sensitive data (including
regulated/health data):

- **Localhost-only by default** — `DEMO_ALLOW_REMOTE=1` is an explicit opt-in.
- **Journeys create nothing and send nothing** — the final create/submit is
  ringed and narrated, never clicked.
- **All dynamic data is redacted by the engine** on every frame — no step
  opts in, no frame can be forgotten; raw captures never persist.
- Output folders are gitignored; distribute videos only through your own
  storage behind your product's auth.

The full frame-styling contract lives in
[docs/style-rules.md](./docs/style-rules.md).

## Updating

In a host repo: `npm run demo:update` (set up by `demogen-init`). Journeys
and config stay untouched; only the engine updates.

## Contributing

PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, code
layout, style and the PR workflow.

```bash
git clone https://github.com/360solutions-dev/demogen.git
cd demogen && npm install && npm run typecheck   # no build step
```

## License

MIT. See [LICENSE](./LICENSE).

---

*Made for teams tired of re-recording demo videos every sprint.*
