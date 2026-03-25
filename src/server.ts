import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import packageJson from "../package.json";
import type { SecurityConfig, ToolName } from "./security.js";
import { validateCommand, validatePath } from "./security.js";
import { bashTool } from "./tools/bash.js";
import { editTool } from "./tools/edit.js";
import { globTool } from "./tools/glob.js";
import { grepTool } from "./tools/grep.js";
import { readTool } from "./tools/read.js";
import { writeTool } from "./tools/write.js";
import { resolvePath } from "./utils.js";

export function createServer(cwd: string, security: SecurityConfig = {}): McpServer {
  const server = new McpServer({
    name: "platter",
    version: packageJson.version,
  });

  const enabled = (name: ToolName) => !security.allowedTools || security.allowedTools.has(name);

  async function checkPath(path: string): Promise<void> {
    if (security.allowedPaths) {
      await validatePath(resolvePath(path, cwd), security.allowedPaths);
    }
  }

  function checkCommand(command: string): void {
    if (security.allowedCommands) {
      validateCommand(command, security.allowedCommands);
    }
  }

  if (enabled("read")) {
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
          await checkPath(args.path);
          const result = await readTool(args, cwd);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
      },
    );
  }

  if (enabled("write")) {
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
          await checkPath(args.path);
          const result = await writeTool(args, cwd);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
      },
    );
  }

  if (enabled("edit")) {
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
          replace_all: z.boolean().optional().describe("Replace all occurrences of old_text (default false)"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
        },
      },
      async (args) => {
        try {
          await checkPath(args.path);
          const result = await editTool(args, cwd);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
      },
    );
  }

  if (enabled("bash")) {
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
          checkCommand(args.command);
          const result = await bashTool(args, cwd);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
      },
    );
  }

  if (enabled("glob")) {
    server.registerTool(
      "glob",
      {
        title: "Glob",
        description:
          "Fast file pattern matching. Returns file paths matching a glob pattern, sorted alphabetically. Supports patterns like '**/*.ts', 'src/**/*.tsx', '*.json'.",
        inputSchema: {
          pattern: z.string().describe("Glob pattern to match files against (e.g. '**/*.ts')"),
          path: z
            .string()
            .optional()
            .describe("Directory to search in (relative or absolute). Defaults to working directory."),
        },
        annotations: {
          readOnlyHint: true,
        },
      },
      async (args) => {
        try {
          await checkPath(args.path ?? cwd);
          const result = await globTool(args, cwd);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
      },
    );
  }

  if (enabled("grep")) {
    server.registerTool(
      "grep",
      {
        title: "Grep",
        description:
          "Search file contents using ripgrep. Supports regex patterns, file filtering, and multiple output modes. Requires ripgrep (rg) to be installed.",
        inputSchema: {
          pattern: z.string().describe("Regular expression pattern to search for"),
          path: z
            .string()
            .optional()
            .describe("File or directory to search in (relative or absolute). Defaults to working directory."),
          glob: z.string().optional().describe("Glob pattern to filter files (e.g. '*.js', '*.{ts,tsx}')"),
          output_mode: z
            .enum(["content", "files_with_matches", "count"])
            .optional()
            .describe(
              "Output mode: 'content' shows matching lines, 'files_with_matches' shows file paths (default), 'count' shows match counts per file",
            ),
          context: z
            .number()
            .optional()
            .describe("Number of lines to show before and after each match (content mode only)"),
          before_context: z
            .number()
            .optional()
            .describe("Number of lines to show before each match (content mode only)"),
          after_context: z.number().optional().describe("Number of lines to show after each match (content mode only)"),
          case_insensitive: z.boolean().optional().describe("Case insensitive search (default false)"),
          fixed_strings: z
            .boolean()
            .optional()
            .describe("Treat pattern as a literal string, not a regex (default false)"),
        },
        annotations: {
          readOnlyHint: true,
        },
      },
      async (args) => {
        try {
          await checkPath(args.path ?? cwd);
          const result = await grepTool(args, cwd);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
      },
    );
  }

  return server;
}
