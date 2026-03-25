# platter

*Your computer, served on a platter.*

MCP server that exposes **Read**, **Write**, **Edit**, **Bash**, **Glob**, and **Grep** tools over Stdio and StreamableHTTP transports. Built with [Bun](https://bun.sh), compiles to standalone executables. The **grep** tool requires [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) to be installed on the host.

Designed to be used by browser-based (or any MCP-compatible) agents — like [Hadrian](https://github.com/ScriptSmith/hadrian) — to control a computer.

## Tools

| Tool | Description |
|------|-------------|
| **read** | Read file contents with pagination (offset/limit). Truncates at 2000 lines or 50KB. |
| **write** | Create or overwrite files. Auto-creates parent directories. |
| **edit** | Find-and-replace with exact (or fuzzy Unicode) matching. Requires a unique match, or use `replace_all` to replace every occurrence. Returns a unified diff. |
| **bash** | Execute shell commands with optional timeout. Output truncated to last 2000 lines or 50KB. |
| **glob** | Fast file pattern matching. Returns paths matching a glob pattern (e.g. `**/*.ts`). |
| **grep** | Search file contents using [ripgrep](https://github.com/BurntSushi/ripgrep). Supports regex, file filtering, context lines, and multiple output modes. Requires `rg` to be installed. |

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
      --auth-token <token>       Bearer token for HTTP auth (auto-generated if omitted)
      --no-auth                  Disable bearer token authentication

Restrictions:
      --tools <list>             Comma-separated tools to enable (default: all)
                                 Valid: read, write, edit, bash, glob, grep
      --allow-path <path>        Restrict file tools to this path (repeatable)
      --allow-command <regex>    Allow bash commands matching this pattern (repeatable)
                                 Pattern must match the entire command string

  -h, --help                     Show help message
  -v, --version                  Show version number
```

### Restrictions

You can limit which tools are registered, which filesystem paths file tools can access, and which commands the bash tool can execute.

#### Tool selection

Only register specific tools — unregistered tools are completely hidden from MCP clients:

```bash
platter --tools read,glob,grep              # read-only server
platter --tools read,write,edit             # no bash/search
```

#### Path restrictions

Restrict file-accessing tools (read, write, edit, glob, grep) to one or more directory trees. Paths are resolved to absolute form and symlinks are resolved via `realpath` to prevent escaping:

```bash
platter --allow-path /home/user/project
platter --allow-path /home/user/project --allow-path /tmp
```

#### Command restrictions

Only allow bash commands whose **entire** command string matches at least one regex pattern:

```bash
platter --allow-command "git( .*)?"                        # git only
platter --allow-command "git( .*)?" --allow-command "npm( .*)?"  # git or npm
platter --allow-command "ls( .*)?" --allow-command "cat .*"      # ls or cat
```

Patterns are anchored: `--allow-command "git( .*)?"` compiles to `^(?:git( .*)?)$`, so `git status` matches but `rm -rf / && git status` does not.

#### Combined example

```bash
# Locked-down: read-only tools, scoped to one directory
platter --tools read,glob,grep --allow-path /home/user/project

# Full tools, but bash restricted to git/npm, files restricted to project
platter --allow-path ./my-project --allow-command "git( .*)?" --allow-command "npm( .*)?"
```

Active restrictions are logged to stderr at startup.

### Authentication

In HTTP mode, platter requires a bearer token on every request (`Authorization: Bearer <token>` header). By default a random token is generated at startup and printed to stderr. You can also provide your own:

```bash
platter -t http --auth-token my-secret-token
```

To disable authentication entirely (e.g. behind a reverse proxy that handles auth):

```bash
platter -t http --no-auth
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

The server validates the `Host` header to prevent [DNS rebinding attacks](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-w48q-cv73-mx4w). When `--cors-origin` is set, the `Origin` header is also validated server-side (not just via CORS response headers).

## Security

### Network (HTTP mode)

- **Bearer token authentication** — required by default (RFC 6750). A random 256-bit token is generated at startup unless you provide `--auth-token` or disable auth with `--no-auth`.
- **Host header validation** — prevents [DNS rebinding attacks](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-w48q-cv73-mx4w). Localhost binds accept only `127.0.0.1`, `localhost`, and `::1`; remote binds accept only the specified `--host`.
- **Origin validation** — when `--cors-origin` is set to a specific origin, requests with a mismatched `Origin` header are actively rejected with 403 (not just filtered by CORS response headers).

### Restrictions (best-effort)

`--tools`, `--allow-path`, and `--allow-command` are **defense-in-depth** controls. They raise the bar significantly but are not a sandbox. The limitations below should be understood before relying on them in a threat model.

#### What they do well

- **Tool selection** is enforced at registration time — disabled tools are never exposed via the MCP protocol. There is no way for a client to invoke or discover them.
- **Path validation** resolves symlinks via `realpath()` on both the target and each allowed path before comparison, preventing traversal via `../` or symlinked directories. For write targets that don't exist yet, the nearest existing ancestor is resolved instead.
- **Command validation** anchors regex patterns to match the full command string, preventing trivial bypasses like appending `&& malicious-command`.

#### Known limitations and bypasses

- **Bash is inherently unrestricted.** When the bash tool is enabled, a sufficiently creative command can bypass `--allow-path` entirely (e.g. `cat /etc/passwd`). If you set `--allow-path` without also setting `--allow-command` or removing bash from `--tools`, a warning is printed at startup. For strong file-access control, either disable bash (`--tools read,write,edit,glob,grep`) or pair `--allow-path` with a tight `--allow-command` allowlist.
- **Command regex operates on the raw string.** It does not parse shell syntax. Patterns like `--allow-command "git( .*)?"` block `rm && git status` (because the full string doesn't match), but a determined attacker could construct commands that the regex matches yet that execute unintended code — for example, if an allowed pattern is too broad. Write patterns as narrowly as possible.
- **Symlink TOCTOU.** Path validation resolves symlinks at check time. If a symlink target is changed between the check and the actual file operation, the validation can be bypassed. This is a fundamental limitation of userspace path checking.
- **Glob/grep search scope.** `--allow-path` validates the search directory for glob and grep, but results within that directory tree may include symlinks pointing outside it. The content of those symlink targets could be returned in grep output or listed by glob.
- **No process-level sandboxing.** All restrictions are enforced in application code within the platter process. They do not use OS-level mechanisms (seccomp, namespaces, pledge, etc.). A vulnerability in platter itself, Bun, or a dependency could bypass all restrictions.

For high-security deployments, combine these restrictions with OS-level isolation (containers, VMs, dedicated users with limited filesystem permissions).

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
