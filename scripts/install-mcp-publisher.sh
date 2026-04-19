#!/usr/bin/env bash
# Install the mcp-publisher CLI into ./.bin so we can submit to the
# official MCP registry without a sudo global install.
#
# Upstream: https://github.com/modelcontextprotocol/registry/releases
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p .bin

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
url="https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_${os}_${arch}.tar.gz"

echo "Downloading mcp-publisher (${os}/${arch})..."
curl -fsSL "$url" | tar xz -C .bin mcp-publisher
chmod +x .bin/mcp-publisher

echo "Installed: $(./.bin/mcp-publisher --version 2>&1 | head -1)"
echo "Path:      $(realpath .bin/mcp-publisher)"
