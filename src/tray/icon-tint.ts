import type { Argb32Pixmap } from "./icon-data.js";

/**
 * Produce a tinted variant of each pixmap for the "activity" tray state.
 *
 * The tray pixmaps are near-white with alpha; multiplying the RGB channels
 * toward a cool green shifts the icon to a visibly different colour without
 * needing a second rasterized asset. Alpha is preserved exactly so the icon
 * silhouette stays sharp on any panel background.
 */
export function tintPixmaps(pixmaps: Argb32Pixmap[], r: number, g: number, b: number): Argb32Pixmap[] {
  return pixmaps.map((p) => ({
    width: p.width,
    height: p.height,
    data: tintBuffer(p.data, r, g, b),
  }));
}

function tintBuffer(src: Buffer, rScale: number, gScale: number, bScale: number): Buffer {
  const out = Buffer.alloc(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i]!;
    const r = src[i + 1]!;
    const g = src[i + 2]!;
    const b = src[i + 3]!;
    out[i] = a;
    out[i + 1] = clamp(Math.round(r * rScale));
    out[i + 2] = clamp(Math.round(g * gScale));
    out[i + 3] = clamp(Math.round(b * bScale));
  }
  return out;
}

function clamp(n: number): number {
  if (n < 0) return 0;
  if (n > 255) return 255;
  return n;
}
