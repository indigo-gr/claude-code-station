#!/usr/bin/env bash
# Claude Code Station (ccs) installer — copies bin/ to ~/.claude/scripts/ and ensures PATH
set -euo pipefail

INSTALL_DIR="$HOME/.claude/scripts"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ccs"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/ccs"
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_BIN="${REPO_ROOT}/bin"
WITH_DEPS=0

for arg in "$@"; do
  case "$arg" in
    --with-deps) WITH_DEPS=1 ;;
    -h|--help)
      echo "Usage: install.sh [--with-deps]"
      echo "  --with-deps   Run 'npm install' automatically if node_modules is missing."
      exit 0 ;;
  esac
done

echo "Claude Code Station (ccs) installer"
echo "===================================="
echo ""

# ── Dependency check ────────────────────────────────────────────────────────
MISSING=()
if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
  (( NODE_MAJOR >= 20 )) || MISSING+=("node >= 20 (found $(node -v))")
else
  MISSING+=("node >= 20")
fi
# fzf >= 0.42.0 required for the change-header binding used by Ctrl-Y/Ctrl-I toasts.
if command -v fzf &>/dev/null; then
  FZF_VER=$(fzf --version 2>/dev/null | awk '{print $1}')
  if [[ -n "$FZF_VER" ]] && [[ "$(printf '%s\n0.42.0\n' "$FZF_VER" | sort -V | head -n1)" != "0.42.0" ]]; then
    MISSING+=("fzf >= 0.42.0 (found $FZF_VER; 'change-header' binding requires 0.42+)")
  fi
else
  MISSING+=("fzf >= 0.42.0 (brew install fzf / apt install fzf)")
fi
command -v tsx    &>/dev/null || MISSING+=("tsx (npm install -g tsx)")
command -v claude &>/dev/null || MISSING+=("claude (Claude Code CLI)")

if (( ${#MISSING[@]} > 0 )); then
  echo "Missing or insufficient dependencies:"
  for dep in "${MISSING[@]}"; do echo "  - $dep"; done
  echo ""
  read -r -p "Continue anyway? (y/N): " cont
  [[ "$cont" == "y" || "$cont" == "Y" ]] || exit 1
fi

# ── npm install (opt-in) ────────────────────────────────────────────────────
if [[ ! -d "${REPO_ROOT}/node_modules" ]]; then
  if (( WITH_DEPS )); then
    echo "Running 'npm install' ..."
    (cd "$REPO_ROOT" && npm install)
  else
    echo "Note: node_modules not found. Run 'npm install' separately, or re-run with --with-deps."
  fi
fi

# ── Copy scripts ────────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
echo "Installing to ${INSTALL_DIR}/ ..."
cp -p "$REPO_BIN/ccs" "$INSTALL_DIR/"
for f in "$REPO_BIN"/ccs-*.ts "$REPO_BIN"/ccs-*.sh; do
  [[ -e "$f" ]] && cp -p "$f" "$INSTALL_DIR/"
done
chmod +x "$INSTALL_DIR/ccs"
[[ -e "$INSTALL_DIR/ccs-delete.sh" ]] && chmod +x "$INSTALL_DIR/ccs-delete.sh"

# find, not `ls | grep` (shellcheck SC2010): ls output is for humans and
# breaks on unusual filenames; -maxdepth 1 keeps it to the install dir itself.
find "$INSTALL_DIR" -maxdepth 1 -name 'ccs*' -exec basename {} \; | sort | sed 's/^/  /'

# ── Runtime dependency resolution (backlog HIGH: node_modules) ──────────────
# tsx resolves better-sqlite3/yaml by walking up from the SCRIPT's directory,
# not the caller's cwd — so the installed copies under ~/.claude/scripts/
# need a node_modules within reach. Symlink the repo checkout's tree (short-
# term fix; npm-package distribution is the long-term plan, see backlog).
if [[ -d "${REPO_ROOT}/node_modules" ]]; then
  ln -sfn "${REPO_ROOT}/node_modules" "$INSTALL_DIR/node_modules"
  echo ""
  echo "Linked runtime deps: ${INSTALL_DIR}/node_modules -> ${REPO_ROOT}/node_modules"
  echo "(Keep this repo checkout in place — the installed scripts resolve better-sqlite3/yaml through it.)"
else
  echo ""
  echo "WARNING: ${REPO_ROOT}/node_modules not found — installed scripts will fail to"
  echo "         resolve better-sqlite3/yaml. Run 'npm install' in the repo (or re-run"
  echo "         with --with-deps), then run install.sh again."
fi

# ── Initialize config/cache dirs (ccs-config.ts populates template on first run) ─
mkdir -p -m 0700 "$CONFIG_DIR" "$CACHE_DIR"

# ── Legacy ccr notice ───────────────────────────────────────────────────────
if ls "$INSTALL_DIR"/ccr* &>/dev/null; then
  echo ""
  echo "# Found legacy ccr — remove with: rm ${INSTALL_DIR}/ccr*"
fi

# ── PATH check ──────────────────────────────────────────────────────────────
if echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  echo ""
  echo "PATH already includes ${INSTALL_DIR}"
else
  echo ""
  echo "Add this to ~/.zshrc or ~/.bashrc:"
  echo "  export PATH=\"\$HOME/.claude/scripts:\$PATH\""
fi

echo ""
echo "Done! Now run 'ccs' to start (open a new terminal or source your shell config)."
echo "Optional: export CCS_CMD=\"opr claude\"   # e.g. 1Password wrapper"
