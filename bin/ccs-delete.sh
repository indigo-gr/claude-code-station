#!/usr/bin/env bash
# ccs-delete.sh - Delete a Claude Code session file with confirmation
# Args: sessionId

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
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
  # Also remove subagents directory if it exists. The final-form check is a
  # defensive guard on the rm -rf argument: it must still look like
  # <projects>/<dir>/<validated-uuid> at deletion time (audit L-2).
  SUBAGENT_DIR="${PROJECTS_DIR}/$(basename "$(dirname "$TARGET")")/${SESSION_ID}"
  if [[ -d "$SUBAGENT_DIR" && "$SUBAGENT_DIR" == "$PROJECTS_DIR/"*"/$SESSION_ID" ]]; then
    rm -rf "$SUBAGENT_DIR"
  fi
  # Remove the stale row from the SQLite cache so the session disappears
  # from the fzf list immediately on reload (Ctrl-D → +reload). Uses a bound
  # parameter via better-sqlite3 (audit M-3) and reports failures instead of
  # swallowing them (audit L-3).
  if command -v tsx &>/dev/null; then
    if ! tsx "${SCRIPT_DIR}/ccs-delete-session.ts" "$SESSION_ID"; then
      echo "[ccs] warning: cache row cleanup failed — a stale row may remain until the next refresh" >&2
    fi
  else
    echo "[ccs] warning: tsx not found — cache row not removed (run ccs --refresh)" >&2
  fi
  echo "✅ Deleted"
else
  echo "Cancelled"
fi

read -r -p "Press Enter to continue..."
