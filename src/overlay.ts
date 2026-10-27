import * as fs from "fs";
import * as path from "path";

import sharp from "sharp";

import type { Box, CaptureManifest, DemoConfig } from "./types";

/**
 * Draws the step styling on each captured frame: a teal ring around the
 * step's target, a label chip pointing at it, and the narration as a caption
 * bar along the bottom.
 *
 * ⚠️ **No dim overlay, deliberately** (product review): the only dimming in
 * the video is the app's OWN tour backdrop on the first-time-tour frames —
 * a drawn dim on top of it double-darkened those frames and looked muddy,
 * and on ordinary frames he wants the clean screen, ring + label only.
 *
 * Everything is one SVG composited by sharp — no canvas native deps, and the
 * geometry comes straight from the capture manifest, so a regenerated frame
 * always has its spotlight exactly where the element now is.
 *
 * All chrome colours (ring, chip, caption, skeleton tint) come from the
 * host's demo.config — every project has its own branding; the engine
 * ships only neutral fallbacks.
 */

// Neutral fallbacks only — real values come from each host's demo.config
// (every project has its own branding; the engine must carry none).
const DEFAULT_RING = "#2F6FEB";
const DEFAULT_CHIP = "#1F2937";
/** All sized against a 3200px-wide reference frame. */
function metrics(width: number) {
  const u = width / 3200;
  return {
    pad: Math.round(14 * u),
    radius: Math.round(12 * u),
    caption: Math.max(13, Math.round(30 * u)),
    label: Math.max(13, Math.round(30 * u)),
  };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Greedy word wrap sized for the caption font — SVG has no text wrapping. */
function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && (line + " " + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function frameSvg(
  width: number,
  height: number,
  spotlight: { x: number; y: number; width: number; height: number } | undefined,
  label: string | undefined,
  narration: string,
  RING: string,
  CHIP: string,
  CHIP_TEXT: string
): string {
  const parts: string[] = [];
  const { pad: SPOTLIGHT_PADDING, radius: CORNER_RADIUS, caption: CAPTION_FONT, label: LABEL_FONT } = metrics(width);

  if (spotlight) {
    const x = Math.max(0, spotlight.x - SPOTLIGHT_PADDING);
    const y = Math.max(0, spotlight.y - SPOTLIGHT_PADDING);
    const w = Math.min(width - x, spotlight.width + SPOTLIGHT_PADDING * 2);
    const h = Math.min(height - y, spotlight.height + SPOTLIGHT_PADDING * 2);

    // Ring only — the screen itself stays untouched (no dim; see header).
    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${CORNER_RADIUS}" fill="none" stroke="#ffffff" stroke-width="7" opacity="0.9"/>`,
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${CORNER_RADIUS}" fill="none" stroke="${RING}" stroke-width="4"/>`
    );

    if (label) {
      // Chip sits centred ABOVE the ring with a pointer; below when there is
      // no room. Never over the ring's content (that hid what it labelled).
      const chipH = LABEL_FONT + 24;
      const chipW = Math.round(label.length * LABEL_FONT * 0.6) + 48;
      const arrow = 12;
      const above = y - chipH - arrow - 10 > 10;
      const chipX = Math.round(Math.max(12, Math.min(x + w / 2 - chipW / 2, width - chipW - 12)));
      const chipY = above ? y - chipH - arrow - 8 : Math.min(y + h + arrow + 8, height - chipH - 12);
      const tipX = Math.round(Math.max(chipX + 18, Math.min(x + w / 2, chipX + chipW - 18)));
      const tri = above
        ? `M ${tipX - arrow} ${chipY + chipH} L ${tipX + arrow} ${chipY + chipH} L ${tipX} ${chipY + chipH + arrow} Z`
        : `M ${tipX - arrow} ${chipY} L ${tipX + arrow} ${chipY} L ${tipX} ${chipY - arrow} Z`;
      parts.push(
        `<path d="${tri}" fill="${CHIP}"/>`,
        `<rect x="${chipX}" y="${chipY}" width="${chipW}" height="${chipH}" rx="10" fill="${CHIP}"/>`,
        `<text x="${chipX + chipW / 2}" y="${chipY + chipH / 2 + LABEL_FONT * 0.36}" ` +
          `font-family="Helvetica, Arial, sans-serif" font-size="${LABEL_FONT}" font-weight="600" ` +
          `fill="${CHIP_TEXT}" text-anchor="middle">${escapeXml(label)}</text>`
      );
    }
  }

  // Caption bar: what the voice is saying, readable with the sound off.
  const lines = wrap(narration, Math.floor((width * 0.86) / (CAPTION_FONT * 0.52)));
  const lineH = CAPTION_FONT + 12;
  const barH = lines.length * lineH + 30;
  const barY = height - barH;
  parts.push(`<rect x="0" y="${barY}" width="${width}" height="${barH}" fill="${CHIP}" opacity="0.92"/>`);
  lines.forEach((line, i) => {
    parts.push(
      `<text x="${width / 2}" y="${barY + 24 + (i + 0.5) * lineH}" ` +
        `font-family="Helvetica, Arial, sans-serif" font-size="${CAPTION_FONT}" ` +
        `fill="${CHIP_TEXT}" text-anchor="middle">${escapeXml(line)}</text>`
    );
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`;
}

/**
 * Frames arrive at native resolution (the capture renders the browser at 2×),
 * so the overlay composites 1:1 — upscaling a 1× capture was what read as
 * "low image quality" on review. All chrome (fonts, ring, chip) and the blur
 * strength are sized RELATIVE to the frame width, so any capture scale still
 * renders identical proportions.
 */
const RENDER_SCALE = 1;

function clip(b: Box, w: number, h: number): { left: number; top: number; width: number; height: number } | null {
  const x1 = Math.max(0, b.x);
  const y1 = Math.max(0, b.y);
  const x2 = Math.min(w, b.x + b.width);
  const y2 = Math.min(h, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return null;
  return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 };
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export async function overlay(
  manifest: CaptureManifest,
  outDir: string,
  config?: Pick<
    DemoConfig,
    "redactionTint" | "redactionTintOpacity" | "ringColor" | "chipColor" | "chipTextColor"
  >
): Promise<void> {
  const RING = config?.ringColor ?? DEFAULT_RING;
  const CHIP = config?.chipColor ?? DEFAULT_CHIP;
  const CHIP_TEXT = config?.chipTextColor ?? "#ffffff";
  // Redactions read as SKELETON bars: the blur is washed with the host
  // theme's skeleton grey, so hidden values look like loading placeholders
  // rather than smudges (review review: "use skeleton color").
  const [tr, tg, tb] = hexToRgb(config?.redactionTint ?? "#E2E5E9");
  const tintOpacity = config?.redactionTintOpacity ?? 0.55;
  const framesDir = path.join(outDir, "frames");
  const overlaidDir = path.join(outDir, "overlaid");
  fs.mkdirSync(overlaidDir, { recursive: true });

  for (const frame of manifest.frames) {
    const source = path.join(framesDir, frame.image);

    // ⚠️ MEASURE the frame; never trust the manifest's dimensions for the
    // composite. The one time they disagreed (a 1× screenshot under 2×
    // geometry) sharp refused the composite — scaling from the measured size
    // makes a mismatch impossible by construction.
    const meta = await sharp(source).metadata();
    const srcW = meta.width ?? manifest.width;
    const srcH = meta.height ?? manifest.height;

    // Redaction pass FIRST, at source resolution: each region is cut out,
    // blurred hard, and composited back — real local records (partner rows,
    // carrier names) never survive into the published frame.
    let baseImage = source as string | Buffer;
    if (frame.redactions?.length) {
      // Proper rectangle intersection with the frame — a target that sits
      // (partly) outside the viewport otherwise produces a negative extract
      // size and sharp refuses the whole frame. Offscreen pixels don't exist
      // in the screenshot, so there is nothing to blur; skip them.
      const regions = frame.redactions
        .map((r) => {
          const x1 = Math.max(0, r.x);
          const y1 = Math.max(0, r.y);
          const x2 = Math.min(srcW, r.x + r.width);
          const y2 = Math.min(srcH, r.y + r.height);
          return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 };
        })
        .filter((r) => r.width > 0 && r.height > 0);

      if (regions.length) {
        // The Guidde-style redaction the review asked for: a generous
        // gaussian blur whose edges FEATHER out (rounded, soft alpha mask)
        // instead of a hard-edged rectangle — the hard edge + low-res mush is
        // what read as "bad blur / bad opacity". Each region is padded a
        // little so the feather falls outside the element it hides.
        const PAD = 10;
        const FEATHER = 6;
        const soft = await Promise.all(
          regions.map(async (r) => {
            const left = Math.max(0, r.left - PAD);
            const top = Math.max(0, r.top - PAD);
            const width = Math.min(srcW - left, r.width + PAD * 2);
            const height = Math.min(srcH - top, r.height + PAD * 2);
            const blurred = await sharp(source)
              .extract({ left, top, width, height })
              .blur(Math.max(5, Math.round(srcW / 320)))
              .composite([
                {
                  input: {
                    create: {
                      width,
                      height,
                      channels: 4,
                      background: { r: tr, g: tg, b: tb, alpha: tintOpacity },
                    },
                  },
                },
              ])
              .ensureAlpha()
              .toBuffer();
            // Rounded, blurred mask = soft falloff at the region's edges.
            const maskSvg =
              `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
              `<rect x="${FEATHER}" y="${FEATHER}" width="${width - FEATHER * 2}" ` +
              `height="${height - FEATHER * 2}" rx="12" fill="#ffffff"/></svg>`;
            const mask = await sharp(Buffer.from(maskSvg)).blur(FEATHER / 2).toBuffer();
            const input = await sharp(blurred)
              .composite([{ input: mask, blend: "dest-in" }])
              .png()
              .toBuffer();
            return { input, left, top };
          })
        );
        const layers: { input: Buffer; left: number; top: number }[] = [...soft];
        // The explicit "don't blur this" opt-out: original pixels re-pasted.
        for (const kv of frame.keepVisible ?? []) {
          const k = clip(kv, srcW, srcH);
          if (k) {
            layers.push({
              input: await sharp(source).extract(k).toBuffer(),
              left: k.left,
              top: k.top,
            });
          }
        }
        // A floating element (the tour card) can sit OVER a redacted region's
        // pixels — re-paste the spotlight's own crop so the thing the step is
        // ABOUT can never come back smeared (it did, on the tour frames).
        // ⚠️ protectOnly frames ONLY: on ordinary frames the redactions may
        // sit INSIDE the spotlight (the subdomain text inside the ringed
        // field) and the re-paste would undo exactly those blurs.
        if (frame.spotlight && (frame.protectOnly || frame.protect)) {
          const sx1 = Math.max(0, frame.spotlight.x);
          const sy1 = Math.max(0, frame.spotlight.y);
          const sx2 = Math.min(srcW, frame.spotlight.x + frame.spotlight.width);
          const sy2 = Math.min(srcH, frame.spotlight.y + frame.spotlight.height);
          if (sx2 > sx1 && sy2 > sy1) {
            layers.push({
              input: await sharp(source)
                .extract({ left: sx1, top: sy1, width: sx2 - sx1, height: sy2 - sy1 })
                .toBuffer(),
              left: sx1,
              top: sy1,
            });
          }
        }
        baseImage = await sharp(source).composite(layers).png().toBuffer();
      }
    }
    const outW = srcW * RENDER_SCALE;
    const outH = srcH * RENDER_SCALE;
    // Spotlight boxes are stored in capture-image pixels; map to output.
    const f = outW / srcW;
    const spotlight = frame.spotlight
      ? {
          x: Math.round(frame.spotlight.x * f),
          y: Math.round(frame.spotlight.y * f),
          width: Math.round(frame.spotlight.width * f),
          height: Math.round(frame.spotlight.height * f),
        }
      : undefined;

    const svg = frameSvg(
      outW,
      outH,
      frame.protectOnly ? undefined : spotlight,
      frame.protectOnly ? undefined : frame.label,
      frame.narration,
      RING,
      CHIP,
      CHIP_TEXT
    );
    await sharp(baseImage)
      .resize(outW, outH)
      .composite([{ input: Buffer.from(svg) }])
      .png()
      .toFile(path.join(overlaidDir, frame.image));
    console.log(`[demo] overlaid ${frame.id}`);
  }
}
