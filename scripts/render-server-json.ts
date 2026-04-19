#!/usr/bin/env bun
/**
 * Render mcpb/server.template.json into a concrete server.json for the MCP
 * registry: substitutes __VERSION__ and the four __SHA256_<OS>_<ARCH>__
 * placeholders by hashing the .mcpb bundles found in --mcpb-dir.
 *
 * Usage:
 *   bun run scripts/render-server-json.ts --version 2.0.1 --mcpb-dir dist [--out server.json]
 *
 * If --out is omitted, the rendered JSON is printed to stdout.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    "mcpb-dir": { type: "string" },
    out: { type: "string" },
  },
});

const version = values.version;
const mcpbDir = resolve(values["mcpb-dir"] ?? "dist");

if (!version) {
  console.error("--version is required");
  process.exit(1);
}

const TARGETS: Array<readonly [string, string]> = [
  ["linux", "x64"],
  ["linux", "arm64"],
  ["darwin", "x64"],
  ["darwin", "arm64"],
];

const projectRoot = resolve(import.meta.dir, "..");
const templatePath = join(projectRoot, "mcpb", "server.template.json");
let rendered = readFileSync(templatePath, "utf8").replace(/__VERSION__/g, version);

for (const [os, arch] of TARGETS) {
  const filePath = join(mcpbDir, `platter-${os}-${arch}.mcpb`);
  if (!existsSync(filePath)) {
    console.error(`Missing mcpb: ${filePath}`);
    process.exit(1);
  }
  const sha = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  const placeholder = `__SHA256_${os.toUpperCase()}_${arch.toUpperCase()}__`;
  if (!rendered.includes(placeholder)) {
    console.error(`Template missing placeholder: ${placeholder}`);
    process.exit(1);
  }
  rendered = rendered.replace(placeholder, sha);
}

// Validate before emitting so we fail loudly instead of shipping malformed JSON.
JSON.parse(rendered);

if (values.out) {
  writeFileSync(values.out, rendered);
  console.error(`Wrote ${values.out}`);
} else {
  process.stdout.write(rendered);
}
