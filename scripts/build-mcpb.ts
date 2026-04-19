#!/usr/bin/env bun
/**
 * Package a compiled platter binary into an .mcpb bundle (MCP Bundle).
 * Rasterizes linux/platter.svg to a 256x256 PNG icon, renders the manifest
 * template for the target (os, arch), and zips the staging directory.
 *
 * Usage:
 *   bun run scripts/build-mcpb.ts --os <linux|darwin> --arch <x64|arm64> \
 *     [--binary <path>] [--out <path>]
 *
 * Defaults:
 *   --binary dist/platter-<os>-<arch>
 *   --out    dist/platter-<os>-<arch>.mcpb
 *
 * Requires `rsvg-convert` (librsvg) or ImageMagick, plus `zip`, on PATH.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rasterizeSvg } from "./lib/rasterize-svg.js";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import packageJson from "../package.json";

const MCPB_OS_VALUES = new Set(["linux", "darwin"]);
const MCPB_ARCH_VALUES = new Set(["x64", "arm64"]);

const { values } = parseArgs({
  options: {
    os: { type: "string" },
    arch: { type: "string" },
    binary: { type: "string" },
    out: { type: "string" },
  },
});

const os = values.os;
const arch = values.arch;

if (!os || !MCPB_OS_VALUES.has(os)) {
  console.error(`--os must be one of: ${[...MCPB_OS_VALUES].join(", ")}`);
  process.exit(1);
}
if (!arch || !MCPB_ARCH_VALUES.has(arch)) {
  console.error(`--arch must be one of: ${[...MCPB_ARCH_VALUES].join(", ")}`);
  process.exit(1);
}

const projectRoot = resolve(import.meta.dir, "..");
const defaultBinary = join(projectRoot, "dist", `platter-${os}-${arch}`);
const binaryPath = resolve(values.binary ?? defaultBinary);
const outPath = resolve(values.out ?? join(projectRoot, "dist", `platter-${os}-${arch}.mcpb`));

if (!existsSync(binaryPath)) {
  console.error(`Binary not found: ${binaryPath}`);
  console.error(`Compile it first with: bun run compile:${os}-${arch}`);
  process.exit(1);
}


function renderManifest(templatePath: string, version: string, platform: string): string {
  const raw = readFileSync(templatePath, "utf8");
  return raw.replace(/__VERSION__/g, version).replace(/__PLATFORM__/g, platform);
}

const mcpbPlatform = os === "linux" ? "linux" : "darwin";
const stagingRoot = mkdtempSync(join(tmpdir(), "platter-mcpb-"));

try {
  const serverDir = join(stagingRoot, "server");
  mkdirSync(serverDir, { recursive: true });

  const stagedBinary = join(serverDir, "platter");
  copyFileSync(binaryPath, stagedBinary);
  chmodSync(stagedBinary, 0o755);

  const svgPath = join(projectRoot, "linux", "platter.svg");
  if (!existsSync(svgPath)) {
    throw new Error(`Missing source SVG at ${svgPath}`);
  }
  rasterizeSvg(svgPath, join(stagingRoot, "icon.png"), 512);

  const manifestPath = join(projectRoot, "mcpb", "manifest.template.json");
  const rendered = renderManifest(manifestPath, packageJson.version, mcpbPlatform);
  // Validate JSON before writing into the bundle.
  JSON.parse(rendered);
  writeFileSync(join(stagingRoot, "manifest.json"), rendered);

  mkdirSync(dirname(outPath), { recursive: true });
  if (existsSync(outPath)) rmSync(outPath);

  // Zip from inside the staging dir so paths are relative to bundle root.
  execFileSync("zip", ["-r", outPath, "manifest.json", "icon.png", "server"], {
    cwd: stagingRoot,
    stdio: ["ignore", "ignore", "inherit"],
  });

  const sha256 = createHash("sha256").update(readFileSync(outPath)).digest("hex");
  console.log(`Wrote ${outPath}`);
  console.log(`  version: ${packageJson.version}`);
  console.log(`  platform: ${mcpbPlatform} (${arch})`);
  console.log(`  sha256: ${sha256}`);
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}
