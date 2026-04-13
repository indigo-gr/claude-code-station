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

ls "$INSTALL_DIR" | grep -E '^ccs' | sed 's/^/  /'

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
