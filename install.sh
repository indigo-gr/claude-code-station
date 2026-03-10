#!/usr/bin/env bash
# Claude Code Recall (ccr) installer - copies bin/ to ~/.claude/scripts/ and ensures PATH
set -euo pipefail

INSTALL_DIR="$HOME/.claude/scripts"
REPO_BIN="$(cd "$(dirname "$0")" && pwd)/bin"

echo "Claude Code Recall (ccr) installer"
echo "===================================="
echo ""

# Check dependencies
MISSING=()
command -v fzf &>/dev/null || MISSING+=("fzf")
command -v tsx &>/dev/null || MISSING+=("tsx (npm install -g tsx)")
command -v node &>/dev/null || MISSING+=("node")

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "Missing dependencies:"
  for dep in "${MISSING[@]}"; do
    echo "  - $dep"
  done
  echo ""
  echo "Please install them first:"
  echo "  brew install fzf       # macOS"
  echo "  apt install fzf        # Ubuntu/Debian"
  echo "  npm install -g tsx"
  echo ""
  read -r -p "Continue anyway? (y/N): " cont
  [[ "$cont" == "y" || "$cont" == "Y" ]] || exit 1
fi

# Create install directory
mkdir -p "$INSTALL_DIR"

# Copy files
echo "Installing to ${INSTALL_DIR}/ ..."
cp "$REPO_BIN/ccr" "$INSTALL_DIR/ccr"
cp "$REPO_BIN/ccr-parse.ts" "$INSTALL_DIR/ccr-parse.ts"
cp "$REPO_BIN/ccr-preview.ts" "$INSTALL_DIR/ccr-preview.ts"
cp "$REPO_BIN/ccr-delete.sh" "$INSTALL_DIR/ccr-delete.sh"
chmod +x "$INSTALL_DIR/ccr" "$INSTALL_DIR/ccr-delete.sh"

echo "  ccr"
echo "  ccr-parse.ts"
echo "  ccr-preview.ts"
echo "  ccr-delete.sh"

# Check PATH
if echo "$PATH" | tr ':' '\n' | grep -q "$INSTALL_DIR"; then
  echo ""
  echo "PATH already includes ${INSTALL_DIR}"
else
  echo ""
  echo "Add this to your shell config (~/.zshrc or ~/.bashrc):"
  echo ""
  echo "  export PATH=\"\$HOME/.claude/scripts:\$PATH\""
  echo ""
fi

echo ""
echo "Done! Run 'ccr' to start (open a new terminal or source your shell config)."
echo ""
echo "Optional: set CCR_CMD for custom claude command:"
echo "  export CCR_CMD=\"opr claude\"   # 1Password wrapper example"
