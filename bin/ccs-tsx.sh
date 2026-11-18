#!/usr/bin/env bash
# ccs-tsx.sh — start a ccs module from ccs's own folder. (The name is from when
# tsx ran the modules; the fzf bindings and ccs-delete.sh still call it.)
#
# Usage (from bin/ccs, the fzf bindings and ccs-delete.sh):
#   CCS_TSX_REAL=<runner> bash ccs-tsx.sh <module> [args…]
#   <runner> is node unless bin/ccs chose otherwise; <module> is a ccs-*.js
#   (a release) or ccs-*.ts (a checkout or a copy install: Node strips the types).
#
# Node reads the nearest package.json above the module and above the current
# folder on the way; a package.json there that Node cannot parse stops every
# module before it starts, even though ccs's own files are fine. So the module
# runs from the folder holding these scripts, and the folder the user ran ccs
# in is passed on in CCS_CWD (read where it matters: `ccs .` and
# `ccs repo add <relative path>`).
set -euo pipefail
export CCS_CWD="${CCS_CWD:-$PWD}"
cd "$(dirname "${BASH_SOURCE[0]}")"
exec "${CCS_TSX_REAL:-node}" "$@"
