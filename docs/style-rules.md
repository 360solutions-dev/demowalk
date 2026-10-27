# Visual style rules

These rules bind **every** journey. They were set by frame-by-frame product
review; journey authors — human or AI (see [`CLAUDE.md`](../CLAUDE.md)) —
follow all of them. A behavior change that affects frames must update these
rules in the same PR.

1. **Rings + label chips are for MAIN CONCEPTS only**: buttons the viewer
   must click, navigation items, wizard steppers, dialogs, a module's key
   introduction. **Never on a plain section heading** — captions narrate those.
2. **Form fields get NO ring and NO chip** — the app's own focus border is
   the highlight. Fill fields ONE PER FRAME, narrated one at a time.
3. **Selection cards get NO ring** — the app's selected-state border is the
   highlight.
4. **No dim overlay ever** — the only dimming is the product's own tour
   backdrop (`protectOnly` frames show the product's callout alone).
5. **Redact values only, skeleton-soft**: row contents not tables, numbers
   not stat cards, typed text inside fields not whole fields, card text not
   cards, nav icon+label not the whole sidebar. Never a whole panel/screen.
6. **Ring geometry**: wrap the WHOLE element group via scoped
   ancestors/siblings. **Never union with page-wide locators** (a page-wide
   `input.last()` once grabbed a below-the-fold checkbox; a page-wide text
   match once ringed a sidebar nav item instead of the section).
7. **The current screen's own nav items stay readable** (URL-driven); a
   navigation step `protect`s its subject.
8. **After an in-app tour finishes, scroll back to the top.**
9. **Every typed form value is redacted** (engine-enforced); `keepVisible` is
   the explicit opt-out for the value a step itself teaches.
10. **No frame ever shows a toast** (engine-enforced).
11. **A "record created" listing frame** rings the WHOLE row with ALL values
    redacted — the story is "your record appears here", never the data. The
    quick-actions (⋮) menu gets its own `protect`ed step.
12. **Detail/review screens redact EVERY printed value** (generic
    label→value patterns; names in breadcrumbs and headings included) —
    labels and section titles stay readable.
13. **App UI text is never redacted** — field labels, checkbox labels, button
    text, column headers. Redaction is for DATA only.
14. **The opening frame of a journey is clean** — welcome narration over the
    untouched screen; the first highlight arrives with the first action.
15. **A step without a spotlight scrolls explicitly** to what its narration
    describes.
16. **Raw frames are deleted after every successful render**
    (engine-enforced; `--keep-frames` only while styling).
17. **Dynamic data is redacted UNIVERSALLY, in the engine** — step `redact`s
    only ADD patterns. If a value shows, fix the engine or a generic pattern,
    never a one-off.
18. **Journeys create NOTHING**: never click the final create/submit — with
    all rows redacted, a ringed existing record tells the identical story. No
    records, no emails, no cleanup, no orphan users.
19. **Any email a flow WOULD send** must target a plus-tagged mailbox the
    team owns — never a fictional-but-real-looking domain.

## Step-level escape hatches

- `redact` — ADD generic redaction patterns for one step.
- `keepVisible` — "don't redact this one thing — it's the value the step
  teaches."
- `noUniversalRedact` — whole frame clean; rare and deliberate.
- `protect` / `protectOnly` — re-paste an element sharp over the redactions
  (`protectOnly`: and show nothing else highlighted). See `src/types.ts` for
  the full API.
