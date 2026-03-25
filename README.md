# platter

*Your computer, served on a platter.*

MCP server that exposes **Read**, **Write**, **Edit**, and **Bash** tools over Stdio and StreamableHTTP transports. Built with [Bun](https://bun.sh), compiles to standalone executables with zero runtime dependencies.

Designed to be used by browser-based (or any MCP-compatible) agents — like [Hadrian](https://github.com/ScriptSmith/hadrian) — to control a computer.

## Tools

| Tool | Description |
|------|-------------|
| **read** | Read file contents with pagination (offset/limit). Truncates at 2000 lines or 50KB. |
| **write** | Create or overwrite files. Auto-creates parent directories. |
| **edit** | Find-and-replace with exact (or fuzzy Unicode) matching. Requires a unique match. Returns a unified diff. |
| **bash** | Execute shell commands with optional timeout. Output truncated to last 2000 lines or 50KB. |

## Quick start

### From a release binary

Download the binary for your platform from [Releases](https://github.com/ScriptSmith/platter/releases), make it executable, and run:

```bash
chmod +x platter-linux-x64
./platter-linux-x64                        # stdio mode
./platter-linux-x64 -t http               # HTTP mode on :3100
```

### From source

```bash
bun install
bun run dev                                # run directly from TypeScript
bun run compile                            # build standalone binary for current platform
```

## Usage

```
platter [options]

Options:
  -t, --transport <stdio|http>   Transport mode (default: stdio)
  -p, --port <number>            HTTP port (default: 3100)
      --host <address>           HTTP bind address (default: 127.0.0.1)
      --cwd <path>               Working directory for tools (default: current directory)
      --cors-origin <origin>     Allowed CORS origin (default: * — reflects request origin)
  -h, --help                     Show help message
  -v, --version                  Show version number
```

### Stdio mode

For use with Claude Desktop, Cursor, and other MCP clients that spawn a subprocess:

```json
{
  "mcpServers": {
    "platter": {
      "command": "/path/to/platter"
    }
  }
}
```

### HTTP mode (StreamableHTTP)

For browser-based agents and remote connections:

```bash
platter -t http -p 3100
```

The server exposes a single endpoint at `/mcp` that handles:
- `POST /mcp` — JSON-RPC messages (initialize, tool calls)
- `GET /mcp` — SSE notification stream
- `DELETE /mcp` — session teardown

CORS is enabled for all origins by default (reflects the request `Origin`). To restrict to a specific origin:

```bash
platter -t http --cors-origin https://myapp.example.com
```

Sessions are managed via the `Mcp-Session-Id` header per the StreamableHTTP spec.

## Build

```bash
bun install
bun run build             # bundle to dist/
bun run compile           # standalone binary for current platform → ./platter
bun run compile:all       # cross-compile for linux-x64, linux-arm64, darwin-x64, darwin-arm64
bun run format            # format with Biome
bun run format:check      # check formatting
bun run lint              # lint with Biome
bun run typecheck         # typecheck with TypeScript
```

## License

MIT
