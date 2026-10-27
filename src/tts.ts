import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

import type { CaptureManifest, DemoConfig } from "./types";

const run = promisify(execFile);

/**
 * Narration text → one audio file per step.
 *
 * v1 is macOS `say`: offline, free, and the narration never leaves the
 * machine — the right default for a tool that runs against a healthcare
 * product, even though the text itself contains no PHI. The engine is behind
 * this one function, so a premium voice (ElevenLabs / OpenAI TTS) for the
 * client-facing cut is a drop-in replacement later, not a rewrite.
 *
 * `say` writes AIFF; ffmpeg converts to 44.1k stereo AAC so every segment
 * matches and the final concat never re-encodes audio mid-stream.
 */

// "Tom (Enhanced)" is a downloaded neural voice (System Settings →
// Accessibility → Spoken Content → Manage Voices); the built-in classics
// sound dated. On a machine without it, `say` errors — download the voice or
// override with DEMO_VOICE.



export async function synthesize(
  manifest: CaptureManifest,
  outDir: string,
  config?: Pick<DemoConfig, "voice" | "voiceRate">
): Promise<void> {
  const VOICE = process.env.DEMO_VOICE ?? config?.voice ?? "Tom (Enhanced)";
  // Slightly slower than `say`'s default 175 — tutorial pacing.
  const RATE_WPM = process.env.DEMO_VOICE_RATE ?? config?.voiceRate ?? "165";
  const audioDir = path.join(outDir, "audio");
  fs.mkdirSync(audioDir, { recursive: true });

  for (const frame of manifest.frames) {
    const aiff = path.join(audioDir, `${frame.id}.aiff`);
    const m4a = path.join(audioDir, `${frame.id}.m4a`);
    await run("say", ["-v", VOICE, "-r", RATE_WPM, "-o", aiff, frame.narration]);
    await run("ffmpeg", ["-y", "-i", aiff, "-ar", "44100", "-ac", "2", "-c:a", "aac", m4a]);
    fs.unlinkSync(aiff);
    console.log(`[demo] voiced ${frame.id}`);
  }
}
