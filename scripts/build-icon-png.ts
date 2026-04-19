#!/usr/bin/env bun
/**
 * Rasterize linux/platter.svg into a standalone 512x512 PNG at dist/icon.png,
 * used as the top-level `icons[].src` asset for the MCP registry entry.
 *
 * Requires ImageMagick (`magick` or `convert`) on PATH.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const SIZE = 512;
const projectRoot = resolve(import.meta.dir, "..");
const svgPath = join(projectRoot, "linux", "platter.svg");
const outDir = join(projectRoot, "dist");
const outPath = join(outDir, "icon.png");

if (!existsSync(svgPath)) {
  console.error(`Missing source SVG at ${svgPath}`);
  process.exit(1);
}

function findImageMagick(): string {
  for (const bin of ["magick", "convert"]) {
    try {
      execFileSync(bin, ["-version"], { stdio: "ignore" });
      return bin;
    } catch {
      // try next
    }
  }
  throw new Error("ImageMagick not found — install IM7 (`magick`) or IM6 (`convert`) on PATH.");
}

mkdirSync(outDir, { recursive: true });
execFileSync(
  findImageMagick(),
  ["-background", "none", "-density", String(SIZE * 4), svgPath, "-resize", `${SIZE}x${SIZE}`, outPath],
  { stdio: ["ignore", "ignore", "inherit"] },
);
console.log(`Wrote ${outPath} (${SIZE}x${SIZE})`);
