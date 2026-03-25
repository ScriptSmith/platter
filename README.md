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

### Docker

```bash
docker run --rm -i ghcr.io/scriptsmith/platter             # stdio mode
docker run --rm -p 3100:3100 ghcr.io/scriptsmith/platter -t http --host 0.0.0.0  # HTTP mode
```

See [Docker](#docker-1) below for mounting paths, networking, installing extra software, and building custom images.

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

Sandbox:
      --sandbox                  Use just-bash sandbox instead of native bash
      --sandbox-fs <mode>        Filesystem backend: memory, overlay, readwrite (default: readwrite)
      --sandbox-allow-url <url>  Allow network access to URL prefix (repeatable)

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

For stronger isolation, use the just-bash sandbox, a Docker container, or both.

### Sandbox mode (just-bash)

Opt into [just-bash](https://github.com/vercel-labs/just-bash) — a TypeScript reimplementation of bash with a virtual filesystem — for true process-level isolation. No native processes are spawned; the shell runs entirely in the Bun runtime.

```bash
platter --sandbox                                          # readwrite fs, no network
platter --sandbox --sandbox-fs memory                      # pure in-memory fs
platter --sandbox --sandbox-fs overlay                     # reads from disk, writes ephemeral
platter --sandbox --sandbox-allow-url "https://api.example.com"  # allow network to prefix
```

#### Filesystem modes

| Mode | Reads | Writes | Use case |
|---|---|---|---|
| `memory` | Virtual only | Virtual only | Maximum isolation, no disk access at all |
| `readwrite` (default) | Real disk | Real disk | Sandboxed execution with real file access |
| `overlay` | Real disk | In-memory (ephemeral) | Explore files without risk of modification |

#### Network access

Network access is **disabled by default**. Use `--sandbox-allow-url` (repeatable) to allow access to specific URL prefixes. Private/loopback IPs are always denied.

```bash
platter --sandbox --sandbox-allow-url "https://api.github.com" --sandbox-allow-url "https://registry.npmjs.org"
```

#### Interaction with other restrictions

- **`--allow-path`**: In `readwrite` and `overlay` modes, each allowed path is mounted into the sandbox. In `memory` mode, `--allow-path` is ignored.
- **`--allow-command`**: Command regex validation still applies before the sandbox executes the command.
- **`--sandbox` suppresses the bash + `--allow-path` warning**, since the sandbox enforces filesystem boundaries.

#### Limitations

- **Not full bash.** just-bash is a TypeScript reimplementation — some edge cases may behave differently from GNU bash.
- **No native binaries.** Commands like `git`, `node`, `docker`, `rg`, `python` are not available. Only bash builtins and just-bash's built-in command set work.
- **Beta software.** just-bash is under active development. Test your workflows before relying on it in production.

### Container isolation (Docker)

Running platter inside a Docker container provides OS-level isolation via Linux namespaces and cgroups. The container boundary limits what the bash tool can access — even unrestricted commands can only reach the filesystems and network that the container exposes.

```bash
# Minimal: no host filesystem, no network
docker run --rm -i --network none ghcr.io/scriptsmith/platter

# Read-only project access, no bash
docker run --rm -p 3100:3100 \
  -v /home/user/project:/work:ro \
  ghcr.io/scriptsmith/platter -t http --host 0.0.0.0 --tools read,glob,grep

# Full tools, scoped to a mounted directory
docker run --rm -p 3100:3100 \
  -v /home/user/project:/work \
  ghcr.io/scriptsmith/platter -t http --host 0.0.0.0 --allow-path /work
```

#### What the container enforces

- **Filesystem boundary.** Only explicitly mounted paths (`-v`) are visible. Even with bash enabled, commands cannot read or write host paths that aren't mounted.
- **Network boundary.** `--network none` completely disables networking. Without it, the container has outbound access but no access to host-only services unless `--network host` is used.
- **Process isolation.** Processes inside the container cannot see or signal host processes.
- **Resource limits.** Docker's `--memory`, `--cpus`, and `--pids-limit` flags can cap resource usage to prevent denial of service.

#### Containers vs VMs

Containers share the host kernel — isolation is enforced by kernel features (namespaces, cgroups, seccomp). A kernel vulnerability or a misconfigured container (e.g. `--privileged`) can break the boundary. VMs run a separate kernel on virtualised hardware, so a guest compromise does not directly expose the host. If your threat model includes untrusted code that may attempt kernel exploits, run platter inside a VM (or a VM-backed container runtime like [Kata Containers](https://katacontainers.io/) or [Firecracker](https://firecracker-microvm.github.io/)). For most use cases — limiting blast radius from an AI agent — a properly configured container (non-root, capabilities dropped, `--network none`) is sufficient.

#### Combining sandbox and container

The just-bash sandbox and Docker container address different layers. Used together, they provide defense in depth:

| Layer | Protects against |
|---|---|
| **just-bash sandbox** | Arbitrary native process execution — no `git`, `curl`, `rm`, etc. Commands run in a TypeScript interpreter, not the OS shell. |
| **Docker container** | Host filesystem/network access — even if the sandbox has a bug or is bypassed, the container limits blast radius to mounted paths and allowed networks. |

```bash
# Maximum isolation: sandbox inside a container, overlay fs, no network
docker run --rm -i --network none \
  -v /home/user/project:/work:ro \
  ghcr.io/scriptsmith/platter --sandbox --sandbox-fs overlay

# Sandbox with controlled network access inside a container
docker run --rm -p 3100:3100 \
  -v /home/user/project:/work \
  ghcr.io/scriptsmith/platter -t http --host 0.0.0.0 \
    --sandbox --sandbox-allow-url "https://api.github.com"
```

For the highest security posture, also run the container as a non-root user (`--user`), drop all capabilities (`--cap-drop ALL`), and set the filesystem read-only (`--read-only`) with a tmpdir for any needed writes:

```bash
docker run --rm -p 3100:3100 \
  --user 1000:1000 \
  --cap-drop ALL \
  --read-only --tmpfs /tmp \
  -v /home/user/project:/work \
  ghcr.io/scriptsmith/platter -t http --host 0.0.0.0 --sandbox
```

See [Docker](#docker-1) for full usage instructions including mounting paths, networking, and building custom images.

## Docker

The Docker image is based on Debian Bookworm (slim) and includes ripgrep. Multi-arch images (`linux/amd64`, `linux/arm64`) are published to GitHub Container Registry on every tagged release.

```bash
docker pull ghcr.io/scriptsmith/platter           # latest release
docker pull ghcr.io/scriptsmith/platter:1.0.0      # specific version
```

### Running in stdio mode

Pipe JSON-RPC messages via stdin/stdout:

```bash
docker run --rm -i ghcr.io/scriptsmith/platter
```

### Running in HTTP mode

Bind to `0.0.0.0` inside the container so the port is reachable from the host:

```bash
docker run --rm -p 3100:3100 ghcr.io/scriptsmith/platter -t http --host 0.0.0.0
```

### Mounting paths

Mount host directories into the container and use `--cwd` or `--allow-path` to give platter access:

```bash
# Mount a project directory as the working directory
docker run --rm -p 3100:3100 \
  -v /home/user/project:/work \
  ghcr.io/scriptsmith/platter -t http --host 0.0.0.0

# Mount read-only
docker run --rm -p 3100:3100 \
  -v /home/user/project:/work:ro \
  ghcr.io/scriptsmith/platter -t http --host 0.0.0.0 --tools read,glob,grep

# Mount multiple directories with path restrictions
docker run --rm -p 3100:3100 \
  -v /home/user/project:/project \
  -v /tmp/scratch:/scratch \
  ghcr.io/scriptsmith/platter -t http --host 0.0.0.0 \
    --cwd /project \
    --allow-path /project --allow-path /scratch
```

### Networking

By default containers have full outbound network access. You can restrict this with Docker's network options:

```bash
# No network access (file-only tools)
docker run --rm --network none -i ghcr.io/scriptsmith/platter

# Access host services (e.g. a local database)
docker run --rm -p 3100:3100 --network host ghcr.io/scriptsmith/platter -t http --host 0.0.0.0
```

### Installing additional software at runtime

The image uses Debian, so you can install packages with `apt-get` at runtime. This is useful for quick experiments but adds startup latency — for production use, build a custom image instead (see below).

```bash
docker run --rm -p 3100:3100 ghcr.io/scriptsmith/platter \
  bash -c "apt-get update && apt-get install -y git nodejs && exec platter -t http --host 0.0.0.0"
```

Or interactively:

```bash
docker run --rm -it --entrypoint bash ghcr.io/scriptsmith/platter
# inside the container:
apt-get update && apt-get install -y git python3
platter -t http --host 0.0.0.0
```

### Building a custom image

Layer additional tools on top of the platter image for a ready-to-use environment:

```dockerfile
FROM ghcr.io/scriptsmith/platter:latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      curl \
      python3 \
      nodejs \
      npm \
 && rm -rf /var/lib/apt/lists/*
```

Build and run:

```bash
docker build -t my-platter .
docker run --rm -p 3100:3100 -v ~/project:/work my-platter -t http --host 0.0.0.0
```

### Building the image locally

```bash
docker build -t platter .
docker run --rm -i platter
```

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
