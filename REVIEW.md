# Code Review Guidelines

## Always check
- Security: command injection via unvalidated session IDs or paths
- UUID validation before any shell execution or file access
- Secret patterns in preview output must be masked
- File size limits enforced before reading session files
- No `eval` usage

## Style
- Shell scripts: `set -euo pipefail`, quote all variables
- TypeScript: strict types, no `any`
- Cross-platform compatibility (macOS, Linux X11, Wayland)

## Skip
- Formatting-only changes
