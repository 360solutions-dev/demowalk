# Contributing to demogen

Thanks for helping make demogen better. This guide covers local setup, the
code layout, style conventions, and the PR workflow.

## Local setup

```bash
git clone https://github.com/360solutions-dev/demogen.git
cd demogen
npm install
npm run typecheck
```

There is **no build step** — the engine ships as plain TypeScript and hosts
run it with `tsx`. `npm run typecheck` must pass before any PR.

### Developing against a real app

The only way to truly test demogen is to run it inside a host repo:

```bash
# in the host app's repo (sibling folder to your demogen clone):
npm install --save-dev --install-links file:../demogen
npx demogen-init
npm run demo:video          # runs the bundled example journey
```

`--install-links` installs a **copy**, so after every engine change re-run
`npm run demo:update` in the host to pick it up. (A plain `file:` install
symlinks the folder, which duplicates Playwright's types and breaks `tsc` —
don't use it.)

## Code layout

```
src/
├── types.ts      # the public API: DemoConfig, Journey, JourneyStep
├── run.ts        # orchestrator: phases, CLI flags, storyboard, cleanup
├── capture.ts    # Playwright: auth, journey walking, 2× CDP screenshots,
│                 # universal redaction measurement, spotlight geometry
├── overlay.ts    # sharp: skeleton-tinted blur, rings, chips, captions
├── tts.ts        # macOS `say` → m4a narration clips
├── stitch.ts     # ffmpeg: audio-pinned segments, seamless concat, encode
├── assets.ts     # small SVG asset helper
└── index.ts      # package entry (re-exports)
templates/        # what demogen-init copies into a host's demo/ folder
scripts/init.mjs  # the demogen-init CLI (host setup + config auto-wiring)
CLAUDE.md         # instruction set for AI-authored journeys
```

## Rules that protect users (do not weaken in a PR)

These are product decisions, not accidents — PRs that loosen them will be
declined unless the README rules change first:

1. **Universal redaction stays universal.** All dynamic data (filled inputs,
   table cells, `…-row`/`…-value` test-ids, preview images) is redacted by
   the engine on every frame. Opt-outs are per-step (`keepVisible`,
   `noUniversalRedact`) and explicit — never global.
2. **Raw frames are deleted after every successful render.**
3. **Localhost-only by default.** `DEMO_ALLOW_REMOTE=1` is the only way to
   capture a non-localhost URL.
4. **Fail loudly.** A missing element stops the run with step id, URL, toast
   text and a debug frame. Never let a run "best-effort" its way to a wrong
   video.
5. **Journeys create nothing.** The engine and templates must never encourage
   clicking a final create/submit.
6. **No company-, project- or person-specific values in the engine.**
   Branding, URLs, credentials and selectors all come from the host's
   `demo.config.ts` and journey files. Neutral fallbacks only.

## Style

- TypeScript strict; no `any` unless interfacing with raw CDP payloads.
- Keep the host-facing API (`src/types.ts`) small and documented — every
  field has a doc comment explaining when to use it.
- Comments explain *constraints* ("Playwright's screenshot() resets the CDP
  device override, so we shoot via raw CDP"), not what the next line does.
- The **19 visual style rules** in [docs/style-rules.md](./docs/style-rules.md)
  are the product spec. A behavior change that affects frames must update the
  rules in the same PR.

## PR workflow

1. Fork / branch from `main`.
2. Make the change; run `npm run typecheck`.
3. Test inside a host app (see above) — for frame-affecting changes, attach
   a before/after frame or short clip to the PR.
4. Update README / CLAUDE.md / templates in the same PR when behavior or
   setup changes.
5. Open the PR with a clear description of *what changed for hosts*.

## Reporting bugs

Open a GitHub issue with:

- the failing step's console output (demogen prints step id, URL, toast text
  and a debug-frame path on failure),
- your `demo.config.ts` with secrets removed,
- Node, Playwright and ffmpeg versions, and macOS version.
