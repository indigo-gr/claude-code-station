#!/usr/bin/env tsx
/**
 * ccs-delete-session.ts — Remove one session row from the state cache.
 *
 * Invoked by ccs-delete.sh after the JSONL file has been deleted, so the
 * stale row disappears from the fzf list on the next reload. Uses a bound
 * parameter via ccs-db.ts (audit M-3) instead of interpolating the UUID into
 * a sqlite3 CLI string.
 *
 * Usage: tsx ccs-delete-session.ts <session-uuid>
 * Exit codes: 0 = row deleted or not present, 1 = bad args / DB failure.
 */

import { existsSync } from "node:fs";
import { getPaths } from "./ccs-config.ts";
import { openDb, deleteSession } from "./ccs-db.ts";
import { UUID_RE } from "./ccs-utils.ts";

function main(): number {
  const uuid = process.argv[2] ?? "";
  if (!UUID_RE.test(uuid)) {
    process.stderr.write("[ccs-delete-session] invalid session UUID\n");
    return 1;
  }

  const paths = getPaths();
  if (!existsSync(paths.stateDb)) {
    // No cache, nothing to clean up.
    return 0;
  }

  try {
    const handle = openDb(paths.stateDb, { skipMigrate: true });
    try {
      deleteSession(handle.db, uuid);
    } finally {
      handle.close();
    }
    return 0;
  } catch (err) {
    process.stderr.write(
      `[ccs-delete-session] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

process.exit(main());
