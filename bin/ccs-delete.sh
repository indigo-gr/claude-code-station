#!/usr/bin/env bash
# ccs-delete.sh - Delete a Claude Code session file with confirmation
# Args: sessionId

set -euo pipefail

SESSION_ID="${1:-}"
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

if [[ -z "$SESSION_ID" ]] || [[ ! "$SESSION_ID" =~ $UUID_RE ]]; then
  echo "❌ Invalid session ID"
  read -r -p "Press Enter to continue..."
  exit 1
fi

PROJECTS_DIR="$HOME/.claude/projects"
TARGET=""

for dir in "$PROJECTS_DIR"/*/; do
  FILE="${dir}${SESSION_ID}.jsonl"
  if [[ -f "$FILE" ]]; then
    TARGET="$FILE"
    break
  fi
done

if [[ -z "$TARGET" ]]; then
  echo "❌ Session file not found"
  read -r -p "Press Enter to continue..."
  exit 1
fi

# Show file info
SIZE=$(du -h "$TARGET" | cut -f1)
echo "━━━ Delete Session ━━━"
echo "📄 $TARGET"
echo "📏 $SIZE"
echo ""
read -r -p "Delete this session? (y/N): " confirm

if [[ "$confirm" == "y" || "$confirm" == "Y" ]]; then
  rm "$TARGET"
  # Also remove subagents directory if it exists
  SUBAGENT_DIR="${PROJECTS_DIR}/$(basename "$(dirname "$TARGET")")/${SESSION_ID}"
  if [[ -d "$SUBAGENT_DIR" ]]; then
    rm -rf "$SUBAGENT_DIR"
  fi
  echo "✅ Deleted"
else
  echo "Cancelled"
fi

read -r -p "Press Enter to continue..."
