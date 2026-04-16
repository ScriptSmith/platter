#!/usr/bin/env bash
# User-level installer for Platter on Linux.
#
# Usage:
#   ./install.sh [--binary PATH] [--yes]    install (default)
#   ./install.sh --uninstall [--yes]        remove everything this script put in place
#
# Installs:
#   ~/.local/bin/platter                               — binary
#   ~/.local/share/applications/platter.desktop        — launcher entry
#   ~/.local/share/icons/hicolor/scalable/apps/platter.svg
#   ~/.config/systemd/user/platter.service             — systemd user unit
#
# Does NOT touch /etc or require sudo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BIN_DIR="${HOME}/.local/bin"
APPS_DIR="${HOME}/.local/share/applications"
ICON_DIR="${HOME}/.local/share/icons/hicolor/scalable/apps"
UNIT_DIR="${HOME}/.config/systemd/user"

BIN_DST="${BIN_DIR}/platter"
DESKTOP_DST="${APPS_DIR}/platter.desktop"
ICON_DST="${ICON_DIR}/platter.svg"
UNIT_DST="${UNIT_DIR}/platter.service"

MODE="install"
BINARY_SRC=""
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --uninstall) MODE="uninstall" ;;
        --install) MODE="install" ;;
        --binary) BINARY_SRC="${2:?--binary requires a path}"; shift ;;
        --yes|-y) ASSUME_YES=1 ;;
        -h|--help)
            sed -n '2,15p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
    shift
done

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31m==>\033[0m %s\n' "$*" >&2; }

confirm() {
    [[ $ASSUME_YES -eq 1 ]] && return 0
    local prompt="$1"
    read -r -p "${prompt} [y/N] " reply
    [[ "$reply" == "y" || "$reply" == "Y" ]]
}

detect_binary() {
    if [[ -n "$BINARY_SRC" ]]; then
        [[ -f "$BINARY_SRC" ]] || { err "--binary path not found: $BINARY_SRC"; exit 1; }
        echo "$BINARY_SRC"
        return
    fi
    # Look next to the script first (tarball layout), then the repo root.
    for candidate in \
        "$SCRIPT_DIR/platter" \
        "$SCRIPT_DIR/../platter" \
        "$SCRIPT_DIR/../dist/platter-linux-x64" \
        "$SCRIPT_DIR/../dist/platter-linux-arm64"; do
        if [[ -f "$candidate" ]]; then
            echo "$candidate"
            return
        fi
    done
    err "Could not find a platter binary. Pass --binary /path/to/platter."
    exit 1
}

install_files() {
    local src
    src="$(detect_binary)"
    say "Installing binary from $src"

    mkdir -p "$BIN_DIR" "$APPS_DIR" "$ICON_DIR" "$UNIT_DIR"

    install -m 0755 "$src" "$BIN_DST"
    install -m 0644 "$SCRIPT_DIR/platter.svg" "$ICON_DST"
    install -m 0644 "$SCRIPT_DIR/platter.service" "$UNIT_DST"

    # Template the .desktop file with the absolute binary path. gnome-shell
    # launches .desktop entries with its own PATH, which on some distros
    # does not include ~/.local/bin — so "Exec=platter --tray" silently
    # fails to resolve. Using an absolute path sidesteps that.
    sed "s|^Exec=.*|Exec=${BIN_DST} --tray|" \
        "$SCRIPT_DIR/platter.desktop" > "$DESKTOP_DST"
    chmod 0644 "$DESKTOP_DST"

    if command -v desktop-file-validate >/dev/null 2>&1; then
        if ! desktop-file-validate "$DESKTOP_DST"; then
            warn "desktop-file-validate reported issues on $DESKTOP_DST (continuing)"
        fi
    fi

    if command -v gtk-update-icon-cache >/dev/null 2>&1; then
        gtk-update-icon-cache -f -q "${HOME}/.local/share/icons/hicolor" 2>/dev/null || true
    fi

    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database -q "$APPS_DIR" 2>/dev/null || true
    fi

    say "Reloading systemd user units"
    systemctl --user daemon-reload || warn "systemctl --user daemon-reload failed"

    cat <<EOF

Installed:
  $BIN_DST
  $DESKTOP_DST
  $ICON_DST
  $UNIT_DST

To start and enable the tray on login:
  systemctl --user enable --now platter.service

To check status:
  systemctl --user status platter.service
  journalctl --user -u platter.service -f

Config lives in:
  ~/.config/platter/config.json

If your menu bar is on GNOME, install the "AppIndicator and
KStatusNotifierItem Support" extension — GNOME does not show tray icons
natively.
EOF

    if confirm "Enable and start platter.service now?"; then
        systemctl --user enable --now platter.service || warn "enable --now failed"
    fi
}

uninstall_files() {
    say "Stopping and disabling platter.service (if running)"
    systemctl --user disable --now platter.service 2>/dev/null || true

    for f in "$UNIT_DST" "$DESKTOP_DST" "$ICON_DST" "$BIN_DST"; do
        if [[ -e "$f" ]]; then
            say "Removing $f"
            rm -f "$f"
        fi
    done

    systemctl --user daemon-reload || true

    if command -v gtk-update-icon-cache >/dev/null 2>&1; then
        gtk-update-icon-cache -f -q "${HOME}/.local/share/icons/hicolor" 2>/dev/null || true
    fi
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database -q "$APPS_DIR" 2>/dev/null || true
    fi

    say "Done. Note: ~/.config/platter/config.json was not removed (run 'rm -rf ~/.config/platter' to wipe persisted state)."
}

case "$MODE" in
    install) install_files ;;
    uninstall) uninstall_files ;;
esac
