/**
 * Rasterize an SVG to a square PNG. Prefers `rsvg-convert` (librsvg) since it
 * renders directly at the target size — ImageMagick's default path is a
 * rasterize-then-downsample that softens fine strokes and gradients.
 */

import { execFileSync } from "node:child_process";

function hasBinary(name: string): boolean {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function rasterizeSvg(svgPath: string, outPath: string, size: number): void {
  if (hasBinary("rsvg-convert")) {
    execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), "-o", outPath, svgPath], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    return;
  }

  for (const im of ["magick", "convert"]) {
    try {
      execFileSync(im, ["-version"], { stdio: "ignore" });
      execFileSync(
        im,
        ["-background", "none", "-density", String(size * 4), svgPath, "-resize", `${size}x${size}`, outPath],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
      return;
    } catch {
      // try next
    }
  }

  throw new Error("No SVG rasterizer found — install librsvg2-bin (`rsvg-convert`) or ImageMagick.");
}
