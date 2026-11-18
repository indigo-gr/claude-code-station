#!/usr/bin/env bash
# ccs-delete.sh - Delete a Claude Code session file with confirmation
# Args: sessionId

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# The module and its runner, as bin/ccs chose them (bin/ccs exports the runner
# in CCS_TSX_REAL): the built .js in a release, else the .ts with Node.
# This script is invoked by path (never symlinked), so no $0 resolution here.
DELETE_MODULE="${SCRIPT_DIR}/ccs-delete-session.ts"
[[ -f "${SCRIPT_DIR}/ccs-delete-session.js" ]] && DELETE_MODULE="${SCRIPT_DIR}/ccs-delete-session.js"
RUNNER="${CCS_TSX_REAL:-node}"

# The words, in the language bin/ccs chose (CCS_LANG_RESOLVED; English when
# this runs on its own).
# shellcheck source=ccs-i18n.sh
source "${SCRIPT_DIR}/ccs-i18n.sh"
CCS_LANG_RESOLVED="${CCS_LANG_RESOLVED:-en}"
is_lang "$CCS_LANG_RESOLVED" || CCS_LANG_RESOLVED=en
ccs_lang_use "$CCS_LANG_RESOLVED"
tx PRESS_ENTER delete_press_enter

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
  say delete_bad_id
  prompt_read "$PRESS_ENTER"
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
  say delete_not_found
  prompt_read "$PRESS_ENTER"
  exit 1
fi

# Show file info. du can fail if the file vanishes between the find loop and
# here (concurrent cleanup) — under `set -e` that would kill the script with
# no message, so fall back to "?" instead.
SIZE=$(du -h "$TARGET" 2>/dev/null | cut -f1 || echo "?")
say delete_title
echo "📄 $TARGET"
echo "📏 $SIZE"
echo ""
tx ASK delete_confirm
prompt_read "$ASK" confirm

if [[ "$confirm" == "y" || "$confirm" == "Y" ]]; then
  # Wrap rm explicitly: under `set -e` a bare rm failure (permissions, file
  # gone) would exit the script before the trailing "Press Enter" prompt, so
  # the fzf execute pane closes with no message and the user has no way to
  # know the delete failed (review C-2).
  if ! rm "$TARGET"; then
    say_err delete_failed "file=${TARGET}"
    prompt_read "$PRESS_ENTER"
    exit 1
  fi
  # Also remove subagents directory if it exists. The final-form check is a
  # defensive guard on the rm -rf argument: it must still look like
  # <projects>/<dir>/<validated-uuid> at deletion time (audit L-2).
  SUBAGENT_DIR="${PROJECTS_DIR}/$(basename "$(dirname "$TARGET")")/${SESSION_ID}"
  if [[ -d "$SUBAGENT_DIR" && "$SUBAGENT_DIR" == "$PROJECTS_DIR/"*"/$SESSION_ID" ]]; then
    if ! rm -rf "$SUBAGENT_DIR"; then
      # Main JSONL is already gone — report and continue to cache cleanup.
      say_err delete_subagent_failed "folder=${SUBAGENT_DIR}"
    fi
  fi
  # Remove the stale row from the SQLite cache so the session disappears
  # from the fzf list immediately on reload (Ctrl-D → +reload). Uses a bound
  # parameter via better-sqlite3 (audit M-3) and reports failures instead of
  # swallowing them (audit L-3).
  if [[ "$RUNNER" == */* ]] || command -v "$RUNNER" &>/dev/null; then
    # Through ccs-tsx.sh: started from ccs's own folder (see that file).
    if ! CCS_TSX_REAL="$RUNNER" bash "${SCRIPT_DIR}/ccs-tsx.sh" "$DELETE_MODULE" "$SESSION_ID"; then
      say_err delete_cache_failed
    fi
  else
    say_err delete_no_node
  fi
  say delete_done
else
  say delete_cancelled
fi

prompt_read "$PRESS_ENTER"
