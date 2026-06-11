#!/usr/bin/env bash
# ccs-delete.sh - Delete a Claude Code session file with confirmation
# Args: sessionId

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Same package-local tsx preference as bin/ccs (npm / copy install layouts);
# this script is invoked by path (never symlinked), so no $0 resolution here.
if [[ -x "${SCRIPT_DIR}/../node_modules/.bin/tsx" ]]; then
  TSX="${SCRIPT_DIR}/../node_modules/.bin/tsx"
elif [[ -x "${SCRIPT_DIR}/node_modules/.bin/tsx" ]]; then
  TSX="${SCRIPT_DIR}/node_modules/.bin/tsx"
else
  TSX="tsx"
fi

SESSION_ID="${1:-}"
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

# bash renders `read -p` prompts only when stdin is a TTY — with piped stdin
# (tests, scripted use) the prompt silently vanishes. Print prompts to stderr
# explicitly so they are always visible; in a TTY this looks identical, since
# `read -p` writes to stderr too.
prompt_read() { # prompt_read <prompt> [varname]
  printf '%s' "$1" >&2
  IFS= read -r "${2:-REPLY}"
}

if [[ -z "$SESSION_ID" ]] || [[ ! "$SESSION_ID" =~ $UUID_RE ]]; then
  echo "❌ Invalid session ID"
  prompt_read "Press Enter to continue..."
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
  prompt_read "Press Enter to continue..."
  exit 1
fi

# Show file info. du can fail if the file vanishes between the find loop and
# here (concurrent cleanup) — under `set -e` that would kill the script with
# no message, so fall back to "?" instead.
SIZE=$(du -h "$TARGET" 2>/dev/null | cut -f1 || echo "?")
echo "━━━ Delete Session ━━━"
echo "📄 $TARGET"
echo "📏 $SIZE"
echo ""
prompt_read "Delete this session? (y/N): " confirm

if [[ "$confirm" == "y" || "$confirm" == "Y" ]]; then
  # Wrap rm explicitly: under `set -e` a bare rm failure (permissions, file
  # gone) would exit the script before the trailing "Press Enter" prompt, so
  # the fzf execute pane closes with no message and the user has no way to
  # know the delete failed (review C-2).
  if ! rm "$TARGET"; then
    echo "❌ Failed to delete: $TARGET" >&2
    prompt_read "Press Enter to continue..."
    exit 1
  fi
  # Also remove subagents directory if it exists. The final-form check is a
  # defensive guard on the rm -rf argument: it must still look like
  # <projects>/<dir>/<validated-uuid> at deletion time (audit L-2).
  SUBAGENT_DIR="${PROJECTS_DIR}/$(basename "$(dirname "$TARGET")")/${SESSION_ID}"
  if [[ -d "$SUBAGENT_DIR" && "$SUBAGENT_DIR" == "$PROJECTS_DIR/"*"/$SESSION_ID" ]]; then
    if ! rm -rf "$SUBAGENT_DIR"; then
      # Main JSONL is already gone — report and continue to cache cleanup.
      echo "[ccs] warning: could not remove subagent dir: $SUBAGENT_DIR" >&2
    fi
  fi
  # Remove the stale row from the SQLite cache so the session disappears
  # from the fzf list immediately on reload (Ctrl-D → +reload). Uses a bound
  # parameter via better-sqlite3 (audit M-3) and reports failures instead of
  # swallowing them (audit L-3).
  if [[ "$TSX" != "tsx" ]] || command -v tsx &>/dev/null; then
    if ! "${TSX}" "${SCRIPT_DIR}/ccs-delete-session.ts" "$SESSION_ID"; then
      echo "[ccs] warning: cache row cleanup failed — a stale row may remain until the next refresh" >&2
    fi
  else
    echo "[ccs] warning: tsx not found — cache row not removed (run ccs --refresh)" >&2
  fi
  echo "✅ Deleted"
else
  echo "Cancelled"
fi

prompt_read "Press Enter to continue..."
