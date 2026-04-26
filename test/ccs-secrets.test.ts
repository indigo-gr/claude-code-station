/**
 * Tests for bin/ccs-secrets.ts
 *
 * Regression suite for Phase 6-A additions to SECRET_PATTERNS +
 * maskSecrets(). Each pattern is exercised against a realistic payload
 * to guard against silent regex drift.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { maskSecrets, SECRET_PATTERNS } from "../bin/ccs-secrets.ts";

describe("maskSecrets — Phase 6-A additions", () => {
  test("masks AWS STS token (ASIA prefix)", () => {
    const input = "token=ASIAIOSFODNN7EXAMPLE more text";
    const out = maskSecrets(input);
    assert.ok(out.includes("[REDACTED]"));
    assert.ok(!out.includes("ASIAIOSFODNN7EXAMPLE"));
  });

  test("masks Stripe live secret key", () => {
    // Assemble fake key at runtime to avoid GitHub push protection
    // false-positive on hardcoded test literals.
    const fakeKey = "sk_" + "live_" + "X".repeat(28);
    const input = `STRIPE=${fakeKey} extra`;
    const out = maskSecrets(input);
    assert.ok(!out.includes(fakeKey));
    assert.ok(out.includes("[REDACTED]"));
  });

  test("masks Stripe test secret key", () => {
    const fakeKey = "sk_" + "test_" + "X".repeat(28);
    const input = `STRIPE_TEST=${fakeKey}`;
    const out = maskSecrets(input);
    assert.ok(!out.includes(fakeKey));
  });

  test("masks Twilio Account SID", () => {
    const fakeSid = "A" + "C" + "0".repeat(32);
    const input = `accountSid: ${fakeSid} value`;
    const out = maskSecrets(input);
    assert.ok(!out.match(/AC[a-f0-9]{32}/));
  });

  test("masks JWT token", () => {
    // A realistic 3-segment JWT
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const input = `Authorization: ${jwt}`;
    const out = maskSecrets(input);
    assert.ok(!out.includes(jwt));
    assert.ok(out.includes("[REDACTED]"));
  });

  test("masks postgres connection URL with password", () => {
    const input =
      "DATABASE_URL=postgres://admin:supersecret123@db.example.com:5432/mydb";
    const out = maskSecrets(input);
    assert.ok(!out.includes("supersecret123"));
    assert.ok(!out.includes("admin"));
  });

  test("masks mysql connection URL", () => {
    const input = "mysql://root:p%40ss@localhost:3306/app";
    const out = maskSecrets(input);
    assert.ok(!out.includes("p%40ss"));
  });

  test("does not mask innocuous strings", () => {
    const input = "Hello world — this is a normal message 2026-04-14";
    const out = maskSecrets(input);
    assert.equal(out, input);
  });

  test("SECRET_PATTERNS contains at least 19 entries", () => {
    assert.ok(SECRET_PATTERNS.length >= 19);
  });
});
