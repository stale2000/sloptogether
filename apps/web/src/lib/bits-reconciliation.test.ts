import { describe, expect, it } from "vitest";
import { bitsReconcileEndpointMatchesApp,bitsTransactionMatchesReceiptTarget } from "./bits-reconciliation";

const target={channelId:"123",extensionClientId:"ext",twitchUserId:"456",sku:"turbo-480p",amountBits:400,transactionId:"tx-1",
  purchaseWindowStartedAt:new Date("2026-10-24T10:00:00Z"),expiresAt:new Date("2026-10-24T10:01:00Z")};
const transaction={id:"tx-1",broadcasterId:"123",extensionClientId:"ext",userId:"456",sku:"turbo-480p",amountBits:400,
  timestamp:new Date("2026-10-24T10:00:30Z"),inDevelopment:false};

describe("bitsReconcileEndpointMatchesApp",()=>{
  it("requires the same public app origin and internal reconciliation path",()=>{
    expect(bitsReconcileEndpointMatchesApp("https://clips.gg/sloptogether/api/v1/internal/bits/reconcile","https://clips.gg/sloptogether")).toBe(true);
    expect(bitsReconcileEndpointMatchesApp("https://attacker.example/reconcile","https://clips.gg/sloptogether")).toBe(false);
    expect(bitsReconcileEndpointMatchesApp("https://clips.gg/api/v1/internal/bits/reconcile","https://clips.gg/sloptogether")).toBe(false);
    expect(bitsReconcileEndpointMatchesApp("http://clips.gg/sloptogether/api/v1/internal/bits/reconcile","http://clips.gg/sloptogether")).toBe(false);
    expect(bitsReconcileEndpointMatchesApp("http://localhost:3000/sloptogether/api/v1/internal/bits/reconcile","http://localhost:3000/sloptogether")).toBe(true);
  });
});

describe("bitsTransactionMatchesReceiptTarget",()=>{
  it("requires an exact authoritative transaction match inside the purchase window",()=>{
    expect(bitsTransactionMatchesReceiptTarget(target,transaction)).toBe(true);
  });

  it("rejects another transaction, channel, purchaser, product, amount or environment",()=>{
    for(const override of [
      {id:"tx-2"},{broadcasterId:"999"},{userId:"999"},{sku:"turbo-1080p"},{amountBits:1100},{inDevelopment:true},
    ])expect(bitsTransactionMatchesReceiptTarget(target,{...transaction,...override})).toBe(false);
  });

  it("rejects transactions timestamped outside the serialized purchase window",()=>{
    expect(bitsTransactionMatchesReceiptTarget(target,{...transaction,timestamp:new Date("2026-10-24T09:59:59Z")})).toBe(false);
    expect(bitsTransactionMatchesReceiptTarget(target,{...transaction,timestamp:new Date("2026-10-24T10:01:01Z")})).toBe(false);
  });
});
