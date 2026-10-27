import type { Journey } from "demogen";

/**
 * Journey skeleton — see the package's CLAUDE.md for how journeys are
 * authored (usually: tell Claude the start and end point; it writes this
 * file from your repo's docs, following the 19 rules in README.md).
 */
interface ExampleData {
  recordName: string;
}

const journey: Journey<ExampleData> = {
  id: "example",
  title: "Example Walkthrough",
  startPath: "/dashboard",
  data: { recordName: "Demo Record 001" },
  // Journey-level redactions: app chrome that shows identity on EVERY frame
  // (the engine can't know your app's markup — name it here once). Example
  // for a MUI header user-chip:
  // redact: ({ page }) => [
  //   page
  //     .locator("div")
  //     .filter({ has: page.locator(".MuiAvatar-root") })
  //     .last(),
  // ],
  steps: [
    {
      id: "01-opening",
      narration:
        "Welcome — in this guide we'll walk through the flow step by step. Let's get started.",
      // Opening frames are clean: no ring, no chip (rule 14).
      // Give slow-loading sections time to render BEFORE blurs are measured —
      // a section that appears after measurement would show its data.
      settleMs: 1500,
    },
  ],
};

export default journey;
