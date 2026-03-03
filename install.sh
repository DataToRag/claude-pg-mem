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
BIN_DIR="${HOME}/.local/bin"
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

ensure_bin_dir() {
  mkdir -p "$BIN_DIR"

  # Add ~/.local/bin to PATH in shell profile if not already present
  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
    local shell_profile=""
    case "${SHELL:-/bin/bash}" in
      */zsh)  shell_profile="$HOME/.zshrc" ;;
      */bash)
        if [ -f "$HOME/.bash_profile" ]; then
          shell_profile="$HOME/.bash_profile"
        else
          shell_profile="$HOME/.bashrc"
        fi
        ;;
      *) shell_profile="$HOME/.profile" ;;
    esac

    if [ -n "$shell_profile" ] && ! grep -q '\.local/bin' "$shell_profile" 2>/dev/null; then
      info "Adding ~/.local/bin to PATH in $shell_profile"
      echo '' >> "$shell_profile"
      echo '# claude-pg-mem' >> "$shell_profile"
      echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$shell_profile"
    fi

    export PATH="$BIN_DIR:$PATH"
  fi
}

install_wrapper() {
  local node_path
  node_path="$(command -v node)"
  local entry_point="$INSTALL_DIR/dist/index.js"

  cat > "$BIN_DIR/claude-pg-mem" <<WRAPPER
#!/usr/bin/env bash
exec "$node_path" "$entry_point" "\$@"
WRAPPER
  chmod +x "$BIN_DIR/claude-pg-mem"
}

# ── Main ─────────────────────────────────────────────────────────────────

main() {
  info "Installing claude-pg-mem..."
  echo

  # Prerequisites
  check_node
  check_pnpm
  ensure_bin_dir

  # Determine install method: local clone vs fresh download
  if [ -f "package.json" ] && grep -q '"claude-pg-mem"' package.json 2>/dev/null; then
    # Running from inside the repo — copy to install dir
    info "Installing from local repo..."
    if [ "$(pwd)" != "$INSTALL_DIR" ]; then
      mkdir -p "$INSTALL_DIR"
      rsync -a --exclude node_modules --exclude .git --exclude dist . "$INSTALL_DIR/"
      cd "$INSTALL_DIR"
    fi
  else
    # Clone fresh
    if [ -d "$INSTALL_DIR/.git" ]; then
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
      rm -rf "$INSTALL_DIR"
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

  # Install CLI wrapper to ~/.local/bin
  info "Installing CLI to $BIN_DIR..."
  install_wrapper

  # Verify
  if command -v claude-pg-mem >/dev/null 2>&1; then
    ok "CLI installed: $(which claude-pg-mem)"
  else
    ok "CLI installed to $BIN_DIR/claude-pg-mem"
    echo "  Restart your shell or run:"
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
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
