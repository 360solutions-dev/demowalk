import * as fs from "fs";
import * as path from "path";

import sharp from "sharp";

/**
 * Render an SVG string to a PNG on disk if it doesn't exist yet — for
 * journey assets like a fictional demo logo, generated rather than committed
 * (no binaries in repos, and the asset regenerates with everything else).
 */
export async function ensureSvgAsset(outPath: string, svg: string): Promise<string> {
  if (!fs.existsSync(outPath)) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await sharp(Buffer.from(svg)).png().toFile(outPath);
  }
  return outPath;
}
