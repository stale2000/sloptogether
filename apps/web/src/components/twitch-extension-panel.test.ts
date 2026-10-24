import { describe, expect, it } from "vitest";
import { bitsReceiptOutcome, isLateReceiptGracePending } from "./twitch-extension-panel";

describe("bitsReceiptOutcome", () => {
  it("keeps receipt-seen purchases pending and locked", () => {
    expect(bitsReceiptOutcome("receipt_seen")).toMatchObject({ pending: true, error: false });
    expect(bitsReceiptOutcome("expired")).toMatchObject({ pending: false, error: false });
    expect(bitsReceiptOutcome("receipt_unverified")).toMatchObject({ pending: true, error: false });
  });

  it("distinguishes terminal payment outcomes without implying a retry", () => {
    expect(bitsReceiptOutcome("reserved")).toMatchObject({ pending: false, error: false });
    expect(bitsReceiptOutcome("paid_unfulfilled")).toMatchObject({ pending: false, error: true });
    expect(bitsReceiptOutcome("consumed_rejected")).toMatchObject({ pending: false, error: true });
    expect(bitsReceiptOutcome("verified_unallocated")).toMatchObject({ pending: false, error: true });
  });
});

describe("isLateReceiptGracePending",()=>{
  it("keeps the intent bound briefly for a delayed Twitch completion callback",()=>{
    expect(isLateReceiptGracePending("expired",false,"2026-10-24T10:00:00Z",Date.parse("2026-10-24T10:05:00Z"))).toBe(true);
    expect(isLateReceiptGracePending("expired",true,"2026-10-24T10:00:00Z",Date.parse("2026-10-24T10:05:00Z"))).toBe(false);
    expect(isLateReceiptGracePending("expired",false,"2026-10-24T10:00:00Z",Date.parse("2026-10-24T10:11:00Z"))).toBe(false);
  });
});
