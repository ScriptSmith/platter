import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bashTool } from "./tools/bash.js";
import { editTool } from "./tools/edit.js";
import { readTool } from "./tools/read.js";
import { writeTool } from "./tools/write.js";

export function createServer(cwd: string): McpServer {
  const server = new McpServer({
    name: "platter",
    version: "1.0.0",
  });

  server.registerTool(
    "read",
    {
      title: "Read",
      description:
        "Read the contents of a file. Output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files.",
      inputSchema: {
        path: z.string().describe("Path to the file to read (relative or absolute)"),
        offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
        limit: z.number().optional().describe("Maximum number of lines to read"),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      try {
        const result = await readTool(args, cwd);
        return { content: [{ type: "text", text: result }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
    },
  );

  server.registerTool(
    "write",
    {
      title: "Write",
      description:
        "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
      inputSchema: {
        path: z.string().describe("Path to the file to write (relative or absolute)"),
        content: z.string().describe("Content to write to the file"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
    },
    async (args) => {
      try {
        const result = await writeTool(args, cwd);
        return { content: [{ type: "text", text: result }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
    },
  );

  server.registerTool(
    "edit",
    {
      title: "Edit",
      description:
        "Edit a file by replacing exact text. The old_text must match exactly (including whitespace). Supports fuzzy matching for minor Unicode/whitespace differences. The match must be unique in the file.",
      inputSchema: {
        path: z.string().describe("Path to the file to edit (relative or absolute)"),
        old_text: z.string().describe("Exact text to find and replace (must match exactly)"),
        new_text: z.string().describe("New text to replace the old text with"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    async (args) => {
      try {
        const result = await editTool(args, cwd);
        return { content: [{ type: "text", text: result }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
    },
  );

  server.registerTool(
    "bash",
    {
      title: "Bash",
      description:
        "Execute a bash command. Returns stdout and stderr combined. Output is truncated to the last 2000 lines or 50KB. Optionally provide a timeout in seconds.",
      inputSchema: {
        command: z.string().describe("Bash command to execute"),
        timeout: z.number().optional().describe("Timeout in seconds (optional, no default timeout)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
    },
    async (args) => {
      try {
        const result = await bashTool(args, cwd);
        return { content: [{ type: "text", text: result }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
    },
  );

  return server;
}
