#!/usr/bin/env bun
/**
 * Rasterize linux/platter.svg into a standalone 512x512 PNG at dist/icon.png,
 * used as the top-level `icons[].src` asset for the MCP registry entry.
 *
 * Requires ImageMagick (`magick` or `convert`) on PATH.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { rasterizeSvg } from "./lib/rasterize-svg.js";

const SIZE = 512;
const projectRoot = resolve(import.meta.dir, "..");
const svgPath = join(projectRoot, "linux", "platter.svg");
const outDir = join(projectRoot, "dist");
const outPath = join(outDir, "icon.png");

if (!existsSync(svgPath)) {
  console.error(`Missing source SVG at ${svgPath}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
rasterizeSvg(svgPath, outPath, SIZE);
console.log(`Wrote ${outPath} (${SIZE}x${SIZE})`);
