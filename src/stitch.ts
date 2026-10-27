import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

import type { CaptureManifest } from "./types";

const run = promisify(execFile);

/**
 * Overlaid frames + per-step audio → the final MP4.
 *
 * Each step becomes a tiny still-image segment whose length is its narration
 * plus a breathing pause, then the segments concat losslessly (same codecs,
 * same dimensions — set deliberately in tts.ts and here) so the join never
 * re-encodes. yuv420p + even dimensions keep QuickTime/browsers happy.
 */

/** Silence after each line, so steps don't slam into each other. */
const TAIL_PAUSE_SECONDS = 0.8;
/** Silence before each line — a voice on the first millisecond gets clipped. */
const LEAD_IN_MS = 400;

/**
 * An audio file's duration, read from ffmpeg itself (the static ffmpeg build
 * ships without ffprobe). `-f null` decodes without writing anything.
 */
async function audioDuration(file: string): Promise<number> {
  const out = await run("ffmpeg", ["-i", file, "-f", "null", "-"]).catch((e) => e as { stderr?: string });
  const stderr = (out as { stderr?: string }).stderr ?? "";
  const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(stderr);
  if (!m) throw new Error(`[demo] could not read duration of ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export async function stitch(manifest: CaptureManifest, outDir: string): Promise<string> {
  const segmentsDir = path.join(outDir, "segments");
  fs.mkdirSync(segmentsDir, { recursive: true });

  const segments: string[] = [];
  for (const frame of manifest.frames) {
    const image = path.join(outDir, "overlaid", frame.image);
    const audio = path.join(outDir, "audio", `${frame.id}.m4a`);
    const segment = path.join(segmentsDir, `${frame.id}.mp4`);

    // ⚠️ Both streams are pinned to ONE exact duration. `-shortest` let the
    // video and audio stream lengths differ by a few frames per segment, and
    // across two dozen concatenated segments the voice drifted ahead of the
    // frames — the viewer heard the next step's narration over the previous
    // step's screen (caught on review at tour steps 2→3).
    const duration = (LEAD_IN_MS / 1000 + (await audioDuration(audio)) + TAIL_PAUSE_SECONDS).toFixed(3);
    await run("ffmpeg", [
      "-y",
      "-loop", "1",
      "-framerate", "25",
      "-t", duration,
      "-i", image,
      "-i", audio,
      // Lead-in silence so the voice never starts on the exact first frame,
      // then pad out to exactly the segment duration.
      "-af", `adelay=${LEAD_IN_MS}|${LEAD_IN_MS},apad=whole_dur=${duration}`,
      "-t", duration,
      "-c:v", "libx264",
      // ⚠️ Near-lossless intermediates: segments pass through a SECOND encode
      // at the join, and default quality twice over starved the text to a
      // 100 kb/s smear — the "bad image quality" of the first cuts.
      "-crf", "12",
      "-preset", "medium",
      "-tune", "stillimage",
      "-pix_fmt", "yuv420p",
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:a", "aac",
      "-ar", "44100",
      segment,
    ]);
    segments.push(segment);
    console.log(`[demo] segment ${frame.id}`);
  }

  // ⚠️ Join with the concat FILTER, not the concat demuxer. Every AAC
  // segment carries ~2048 samples of encoder priming; the demuxer keeps each
  // segment's edit list and some players stall the audio at the seams until
  // a pause/seek (heard on review: "audio stops, video keeps running"). The
  // filter decodes all segments and rebuilds ONE continuous A/V timeline, so
  // there are no seams left to trip on.
  const output = path.join(outDir, `${manifest.journeyId}.mp4`);
  const inputs = segments.flatMap((seg) => ["-i", seg]);
  const pairs = segments.map((_, i) => `[${i}:v][${i}:a]`).join("");
  await run("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex", `${pairs}concat=n=${segments.length}:v=1:a=1[v][a]`,
    "-map", "[v]",
    "-map", "[a]",
    "-c:v", "libx264",
    "-crf", "16",
    "-preset", "medium",
    "-tune", "stillimage",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "44100",
    output,
  ]);
  return output;
}