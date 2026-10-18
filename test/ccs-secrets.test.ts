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

  test("masks Twilio Account SID with uppercase hex (review C-3)", () => {
    const fakeSid = "A" + "C" + "0A1B2C3D".repeat(4);
    const out = maskSecrets(`sid=${fakeSid}`);
    assert.ok(!out.includes(fakeSid));
    assert.ok(out.includes("[REDACTED]"));
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

// Coverage for the 2026-06-12 audit M-1 leak table: every format below was
// measured to pass through maskSecrets() unredacted before the fix.
describe("maskSecrets — audit M-1 additions", () => {
  test("masks GitLab PAT (glpat-)", () => {
    const fake = "glpat-" + "x".repeat(20);
    const out = maskSecrets(`use ${fake} for CI`);
    assert.ok(!out.includes(fake));
    assert.ok(out.includes("[REDACTED]"));
  });

  test("masks GitHub fine-grained PAT (github_pat_)", () => {
    const fake = "github_pat_" + "11A".padEnd(22, "B") + "_" + "c".repeat(40);
    const out = maskSecrets(`token: ${fake}`);
    assert.ok(!out.includes(fake));
  });

  test("masks Google OAuth client secret (GOCSPX-)", () => {
    const fake = "GOCSPX-" + "a1B2".repeat(6);
    const out = maskSecrets(`client_secret=${fake}`);
    assert.ok(!out.includes(fake));
  });

  test("masks SendGrid API key (SG.xxx.yyy)", () => {
    const fake = "SG." + "k".repeat(22) + "." + "v".repeat(43);
    const out = maskSecrets(`sendgrid ${fake}`);
    assert.ok(!out.includes(fake));
  });

  test("masks npm token (npm_)", () => {
    const fake = "npm_" + "A1b2C3d4".repeat(4) + "Efgh";
    const out = maskSecrets(`//registry.npmjs.org/:_authToken=${fake}`);
    assert.ok(!out.includes(fake));
  });

  test("masks Slack incoming-webhook URL", () => {
    // Assemble at runtime so the full literal never appears in source —
    // otherwise GitHub push protection flags this fixture as a real webhook.
    const url =
      "https://hooks.slack.com/" + "services/" + "T00000000/B00000000/" + "X".repeat(24);
    const out = maskSecrets(`post to ${url} please`);
    assert.ok(!out.includes("services/T00000000"));
  });

  test("masks generic KEY=value assignments", () => {
    const out = maskSecrets("OPENAI_API_KEY=abcd1234efgh5678 and more");
    assert.ok(!out.includes("abcd1234efgh5678"));
  });

  test("masks https URL with embedded credentials", () => {
    const out = maskSecrets("fetch https://user:Sup3rSecret@example.com/repo.git");
    assert.ok(!out.includes("Sup3rSecret"));
  });

  test("does not mask prose mentioning the word key", () => {
    const input = "rotate the key: see the runbook for details";
    assert.equal(maskSecrets(input), input);
  });
});
