import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { formatSize, resolvePath } from "../utils.js";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

export async function readTool(args: { path: string; offset?: number; limit?: number }, cwd: string): Promise<string> {
  const absolutePath = resolvePath(args.path, cwd);

  await access(absolutePath, constants.R_OK);

  const buffer = await readFile(absolutePath);

  // Check if it's an image
  const mimeType = detectImageMime(buffer);
  if (mimeType) {
    return `[Image file: ${mimeType}, ${formatSize(buffer.length)}] (base64 image data not included in text response — use the MCP image content type)`;
  }

  const text = buffer.toString("utf-8");
  const allLines = text.split("\n");
  const totalLines = allLines.length;

  const startLine = args.offset ? Math.max(0, args.offset - 1) : 0;
  const startLineDisplay = startLine + 1;

  if (startLine >= allLines.length) {
    throw new Error(`Offset ${args.offset} is beyond end of file (${allLines.length} lines total)`);
  }

  let selectedLines: string[];
  let userLimited = false;

  if (args.limit !== undefined) {
    const endLine = Math.min(startLine + args.limit, allLines.length);
    selectedLines = allLines.slice(startLine, endLine);
    userLimited = endLine < allLines.length;
  } else {
    selectedLines = allLines.slice(startLine);
  }

  // Apply truncation (line + byte limits)
  const outputLines: string[] = [];
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" | null = null;

  for (let i = 0; i < selectedLines.length && i < MAX_LINES; i++) {
    const line = selectedLines[i];
    const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0);

    if (i === 0 && lineBytes > MAX_BYTES) {
      // First line exceeds byte limit
      return `[Line ${startLineDisplay} is ${formatSize(Buffer.byteLength(line, "utf-8"))}, exceeds ${formatSize(MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${args.path} | head -c ${MAX_BYTES}]`;
    }

    if (outputBytes + lineBytes > MAX_BYTES) {
      truncatedBy = "bytes";
      break;
    }

    outputLines.push(line);
    outputBytes += lineBytes;
  }

  if (!truncatedBy && outputLines.length >= MAX_LINES && selectedLines.length > MAX_LINES) {
    truncatedBy = "lines";
  }

  let result = outputLines.join("\n");

  if (truncatedBy) {
    const endLineDisplay = startLineDisplay + outputLines.length - 1;
    const nextOffset = endLineDisplay + 1;
    if (truncatedBy === "lines") {
      result += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
    } else {
      result += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines} (${formatSize(MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
    }
  } else if (userLimited) {
    const remaining = totalLines - (startLine + selectedLines.length);
    const nextOffset = startLine + selectedLines.length + 1;
    result += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  }

  return result;
}

function detectImageMime(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return "image/gif";
  // WebP: starts with RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  )
    return "image/webp";
  return null;
}
