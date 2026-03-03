#!/usr/bin/env bash
set -euo pipefail

# claude-pg-mem installer
# Installs from GitHub repo: https://github.com/DataToRag/claude-pg-mem
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/DataToRag/claude-pg-mem/main/install.sh | bash
#   # or
#   git clone https://github.com/DataToRag/claude-pg-mem && cd claude-pg-mem && ./install.sh

REPO="DataToRag/claude-pg-mem"
INSTALL_DIR="${HOME}/.claude-pg-mem/cli"
MIN_NODE_VERSION=22

# ── Helpers ──────────────────────────────────────────────────────────────

info()  { printf '\033[1;34m[info]\033[0m  %s\n' "$*"; }
ok()    { printf '\033[1;32m[ok]\033[0m    %s\n' "$*"; }
err()   { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }
die()   { err "$@"; exit 1; }

check_node() {
  command -v node >/dev/null 2>&1 || die "Node.js is required (>= v${MIN_NODE_VERSION}). Install from https://nodejs.org"
  local ver
  ver=$(node -v | sed 's/^v//' | cut -d. -f1)
  [ "$ver" -ge "$MIN_NODE_VERSION" ] 2>/dev/null || die "Node.js >= v${MIN_NODE_VERSION} required (found v$(node -v | sed 's/^v//'))"
}

check_pnpm() {
  command -v pnpm >/dev/null 2>&1 || {
    info "pnpm not found, installing via corepack..."
    corepack enable 2>/dev/null || npm install -g pnpm
  }
}

# ── Main ─────────────────────────────────────────────────────────────────

main() {
  info "Installing claude-pg-mem..."
  echo

  # Prerequisites
  check_node
  check_pnpm

  # Determine install method: local clone vs fresh download
  if [ -f "package.json" ] && grep -q '"claude-pg-mem"' package.json 2>/dev/null; then
    # Running from inside the repo
    info "Installing from local repo..."
    INSTALL_DIR="$(pwd)"
  else
    # Clone fresh
    if [ -d "$INSTALL_DIR" ]; then
      info "Updating existing installation..."
      cd "$INSTALL_DIR"
      git pull --ff-only 2>/dev/null || {
        info "Pull failed, re-cloning..."
        cd ..
        rm -rf "$INSTALL_DIR"
        git clone "https://github.com/${REPO}.git" "$INSTALL_DIR"
        cd "$INSTALL_DIR"
      }
    else
      info "Cloning repository..."
      mkdir -p "$(dirname "$INSTALL_DIR")"
      git clone "https://github.com/${REPO}.git" "$INSTALL_DIR"
      cd "$INSTALL_DIR"
    fi
  fi

  # Install dependencies
  info "Installing dependencies..."
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install

  # Build TypeScript
  info "Building..."
  pnpm run build

  # Build plugin bundles
  info "Building plugin bundles..."
  pnpm run build:plugin

  # Link CLI globally
  info "Linking CLI..."
  pnpm link --global 2>/dev/null || npm link

  # Verify CLI is available
  if command -v claude-pg-mem >/dev/null 2>&1; then
    ok "CLI installed: $(which claude-pg-mem)"
  else
    # Add to PATH hint
    err "CLI not found in PATH after linking."
    echo "  Add this to your shell profile (~/.zshrc or ~/.bashrc):"
    echo "    export PATH=\"\$(pnpm bin -g):\$PATH\""
    echo "  Then restart your shell."
  fi

  echo
  ok "claude-pg-mem installed successfully!"
  echo
  info "Next steps:"
  echo "  1. Set your Neon Postgres URL:"
  echo "     claude-pg-mem config set DATABASE_URL \"postgres://user:pass@host/db\""
  echo "  2. Push the schema:"
  echo "     claude-pg-mem db push"
  echo "  3. Register as Claude Code plugin:"
  echo "     claude-pg-mem install"
  echo "  4. Start the worker:"
  echo "     claude-pg-mem start"
  echo "  5. Restart Claude Code"
  echo
}

main "$@"
