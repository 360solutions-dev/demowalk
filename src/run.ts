import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

import { capture } from "./capture";
import { overlay } from "./overlay";
import { stitch } from "./stitch";
import { synthesize } from "./tts";
import type { CaptureManifest, DemoConfig, Journey } from "./types";

const execFileAsync = promisify(execFile);

/**
 * The demo-video pipeline: capture → overlay → tts → stitch.
 *
 * Host usage (each portal keeps a 3-line shim, see README):
 *
 *   import { run } from "demogen";
 *   import config from "./demo.config";
 *   run(config, (id) => import(`./journeys/${id}`));
 *
 * Flags: --journey=<id> (default "example"), --from=<phase>, --keep-frames.
 *
 * The requirement this tool exists for: when the product changes, the demo
 * must be dynamically re-generated — never a static recording that can go
 * out-of-date. This command IS that regeneration.
 */

const PHASES = ["capture", "overlay", "tts", "stitch"] as const;
type Phase = (typeof PHASES)[number];

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=")[1];
}

/**
 * ⚠️ Localhost-only, on purpose. The capture signs in; pointing it at a
 * shared or production host must be an explicit, spelled-out decision
 * (config.allowRemote or DEMO_ALLOW_REMOTE=1), never a default or a typo.
 */
function guardBaseUrl(baseUrl: string, allowRemote?: boolean): void {
  if (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1")) return;
  if (allowRemote || process.env.DEMO_ALLOW_REMOTE === "1") {
    console.warn(`[demo] ⚠️ running against REMOTE host ${baseUrl}`);
    return;
  }
  throw new Error(
    `[demo] refusing to run against non-local baseUrl "${baseUrl}". ` +
      `Set allowRemote in demo.config (or DEMO_ALLOW_REMOTE=1) only if you mean it.`
  );
}

async function ensureFfmpeg(): Promise<void> {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
  } catch {
    throw new Error("[demo] ffmpeg not found — install it first:  brew install ffmpeg");
  }
}

/** The human-readable storyboard — regenerated every run, never hand-edited. */
function writeStoryboard(journey: Journey<unknown>, journeysDir: string): void {
  const storyboard = [
    `# ${journey.title}`,
    "",
    `> Auto-generated from \`${path.join(journeysDir, journey.id)}.ts\` on every run — do not edit by hand.`,
    "",
    `Steps: ${journey.steps.length} · Start: \`${journey.steps[0]?.id}\` · End: \`${journey.steps[journey.steps.length - 1]?.id}\``,
    "",
    ...journey.steps.map((step, i) => {
      const marks = [
        step.preAuth ? "signed-out" : "",
        step.spotlight && !step.protectOnly ? "ring" : "",
        step.protectOnly ? "product tour callout" : "",
        step.noUniversalRedact ? "⚠️ universal blur OFF" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `${i + 1}. **${step.id}**${marks ? ` _(${marks})_` : ""}\n   “${step.narration}”`;
    }),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(journeysDir, `${journey.id}.md`), storyboard);
}

export async function run(
  config: DemoConfig,
  loadJourney: (id: string) => Promise<{ default: Journey<unknown> }>
): Promise<void> {
  // Default matches the shipped template so a fresh install runs out of the
  // box; real journeys are selected with --journey=<id>.
  const journeyId = arg("journey") ?? "example";
  const from: Phase = (arg("from") as Phase) ?? "capture";
  if (!PHASES.includes(from)) {
    throw new Error(`[demo] --from must be one of: ${PHASES.join(", ")}`);
  }

  let journey: Journey<unknown>;
  try {
    journey = (await loadJourney(journeyId)).default;
  } catch {
    throw new Error(
      `[demo] journey "${journeyId}" not found in demo/journeys/ — ` +
        `run with --journey=<id> matching a file there.`
    );
  }
  const demoDir = config.demoDir ?? "demo";
  const outDir = path.join(demoDir, "out", journey.id);
  fs.mkdirSync(outDir, { recursive: true });
  writeStoryboard(journey, path.join(demoDir, "journeys"));

  await ensureFfmpeg();

  const fromIndex = PHASES.indexOf(from);
  let manifest: CaptureManifest;

  if (fromIndex <= PHASES.indexOf("capture")) {
    guardBaseUrl(config.baseUrl, config.allowRemote);
    if (config.prepare) await config.prepare();
    manifest = await capture(journey, config, outDir);
  } else {
    const manifestPath = path.join(outDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`[demo] no manifest at ${manifestPath} — run a capture first.`);
    }
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as CaptureManifest;
  }

  if (fromIndex <= PHASES.indexOf("overlay")) await overlay(manifest, outDir, config);
  if (fromIndex <= PHASES.indexOf("tts")) await synthesize(manifest, outDir, config);
  const output = await stitch(manifest, outDir);

  // ⚠️ Privacy by default: the raw frames are the UNBLURRED screenshots.
  // Once the render succeeds they have done their job — delete them so no
  // unredacted capture lingers on disk. Keep them only when explicitly
  // iterating on overlay styling: --keep-frames (then `--from=overlay`
  // re-renders without a recapture).
  if (!process.argv.includes("--keep-frames")) {
    fs.rmSync(path.join(outDir, "frames"), { recursive: true, force: true });
    console.log("[demo] raw (unblurred) frames deleted — pass --keep-frames to retain");
  }

  console.log(`\n[demo] ✅ ${manifest.frames.length} steps → ${output}`);
}
