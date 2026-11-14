#!/usr/bin/env bash
# ccs-tsx.sh — start a ccs module with tsx from ccs's own folder.
#
# Usage (from bin/ccs, the fzf bindings and ccs-delete.sh):
#   CCS_TSX_REAL=<tsx> bash ccs-tsx.sh <module.ts> [args…]
#
# Node resolves tsx's preload (--require) from the CURRENT folder and reads
# the nearest package.json above it on the way; a package.json there that
# Node cannot parse stops every module before it starts, even though ccs's
# own files are fine. So the module runs from the folder holding these
# scripts, and the folder the user ran ccs in is passed on in CCS_CWD (read
# where it matters: `ccs .` and `ccs repo add <relative path>`).
set -euo pipefail
export CCS_CWD="${CCS_CWD:-$PWD}"
cd "$(dirname "${BASH_SOURCE[0]}")"
exec "${CCS_TSX_REAL:-tsx}" "$@"
