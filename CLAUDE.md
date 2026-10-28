# Authoring journeys with Claude

This file is the instruction set for any Claude session asked to create or
edit a walkthrough video in a host repo. The human gives only a **start
point and an end point** ("start from login, end at partner listing") —
everything else below is YOUR job, not theirs.

## The contract

1. **Read `docs/style-rules.md` in this package first** — the 19 visual
   style rules bind every journey. Do not re-learn them from review rounds;
   start compliant.
2. **The human never lists what to blur.** The engine blurs all dynamic data
   universally; you add only generic patterns (label→value pairs on detail
   pages, checkbox-name siblings, selection-card text). If they want
   something readable, they'll say so → use `keepVisible` (one value) or
   `noUniversalRedact` (whole frame, rare).
3. **Journeys create nothing** (rule 18): fill real forms, ring the final
   create/submit button, narrate the completion — never click it. Show the
   result on an existing record with everything blurred.

## How to auto-write a journey from "start X, end Y"

1. **Mine the host repo — you have full access:**
   - `docs/<module>.md` — each module's doc explains what every screen,
     field and button actually does. This is your narration source of truth.
   - `docs/user-guide/guide.config.json` + `mockups.mjs` — the sections,
     step order and per-screen elements the team already documents for
     users. A journey should cover the same ground in the same order.
   - The screen's source (`src/screen/<Module>/`) — for exact field labels,
     placeholders (your selectors), conditional sections, and validations.
2. **Cover EVERYTHING on the path.** Walk the real screen top-to-bottom and
   give every field/section its moment — name, then subdomain, then type,
   then each conditional section as it appears. Missing a field the screen
   shows is a review bounce; the human should never have to say "you skipped
   X".
3. **Detect the product's own tour/onboarding.** Search the host for
   ProductTour / onboarding flags (e.g. `has_completed_onboarding`). Where
   the product draws its own tour, trigger it (patch the flag in the demo
   browser's API response — never in the app) and use `protectOnly` frames:
   the product's backdrop is the only dim in the whole video (rule 4).
4. **Narration voice:** present tense, "you/your", one or two sentences per
   frame, say what + why, end transition steps with the click to make
   ("Click Next", "click Continue"). Opening frame = welcome + what the
   video covers; closing frame = one-line recap + "thanks for watching".
5. **Selectors:** accessible (labels, placeholders, roles) — never
   page-wide text or nth() guesses (rule 6); scope through section titles
   and siblings. Measurement flakiness is already engine-handled.
   **Scrolling:** spotlight steps center themselves (engine). A step that
   scrolls in its own `do` must CENTER its subject too —
   `locator.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "instant" }))`
   — never `scrollIntoViewIfNeeded`, which stops at "barely visible" and
   leaves the subject cut off at the bottom edge under the caption.
6. **Emails/data:** all typed values come from the journey's `data` object —
   fictional names, plus-tagged owned mailboxes if an address could ever
   receive mail (rule 19), fictional addresses/phones (555-01xx).

## Workflow with the human

1. They give start + end (+ anything special to keep visible).
2. You write `demo/journeys/<id>.ts` + run once; the storyboard
   `demo/journeys/<id>.md` regenerates automatically — share it for review
   of the narration before they even watch the video.
3. They watch, send screenshots; you fix. Engine-level issues get fixed in
   THIS package (every portal inherits); journey issues in the journey file.

## Debugging a failed run

The run stops loudly with the step id, the page URL, any on-screen toast
text and a debug frame path. That is the diagnosis — read it before touching
code. A "spotlight target not found" after a product change is the tool
working as designed: update that one step and re-run.
