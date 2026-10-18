/**
 * Tests for bin/ccs-time.ts — unified DB timestamp parsing (audit logic
 * H-2 / M-1: naive SQLite datetimes are UTC and must not be parsed as local).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { normalizeDbTime, parseDbTime } from "../bin/ccs-time.ts";

describe("normalizeDbTime", () => {
  test("passes ISO 8601 values through untouched", () => {
    assert.equal(
      normalizeDbTime("2026-06-12T03:04:05.000Z"),
      "2026-06-12T03:04:05.000Z",
    );
  });

  test("converts SQLite naive datetime to explicit UTC", () => {
    assert.equal(normalizeDbTime("2026-06-12 03:04:05"), "2026-06-12T03:04:05Z");
  });
});

describe("parseDbTime", () => {
  test("naive datetime parses as UTC, not local time (audit H-2)", () => {
    const naive = parseDbTime("2026-06-12 03:04:05");
    const explicit = Date.parse("2026-06-12T03:04:05Z");
    assert.equal(naive, explicit);
  });

  test("ISO and equivalent naive forms agree", () => {
    assert.equal(
      parseDbTime("2026-06-12 03:04:05"),
      parseDbTime("2026-06-12T03:04:05Z"),
    );
  });

  test("returns NaN for garbage", () => {
    assert.ok(Number.isNaN(parseDbTime("not-a-date")));
  });
});
