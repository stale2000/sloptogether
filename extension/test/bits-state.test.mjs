import assert from "node:assert/strict";
import test from "node:test";
import { bitsOutcome, isLateReceiptGracePending } from "../src/bits-state.mjs";

test("keeps unverified Bits receipts pending and locked", () => {
  assert.deepEqual(bitsOutcome("receipt_seen"), { pending: true, error: false, text: "Receipt received. Verification in progress; do not use Bits again yet." });
  assert.deepEqual(bitsOutcome("receipt_unverified"), { pending: true, error: false, text: "Receipt not verified. No render started; do not use Bits again yet." });
  assert.equal(bitsOutcome("expired").pending, false);
});

test("does not imply a spent Turbo attempt can be reused", () => {
  assert.equal(bitsOutcome("reserved").error, false);
  assert.equal(bitsOutcome("paid_unfulfilled").error, true);
  assert.equal(bitsOutcome("consumed_rejected").error, true);
  assert.equal(bitsOutcome("verified_unallocated").error, true);
  assert.doesNotMatch(Object.values(bitsOutcome("consumed_rejected")).join(" "), /donate|donation|purchase|buy|spend|support/i);
});

test("holds an expired intent briefly for a delayed Twitch receipt", () => {
  const expiry = "2026-10-24T10:00:00Z";
  assert.equal(isLateReceiptGracePending("expired", false, expiry, Date.parse("2026-10-24T10:05:00Z")), true);
  assert.equal(isLateReceiptGracePending("expired", true, expiry, Date.parse("2026-10-24T10:05:00Z")), false);
  assert.equal(isLateReceiptGracePending("expired", false, expiry, Date.parse("2026-10-24T10:11:00Z")), false);
});
