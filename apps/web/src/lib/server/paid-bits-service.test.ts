import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({transaction:vi.fn(),query:vi.fn(),extensionPrincipal:vi.fn(),receipt:vi.fn(),getExtensionTransaction:vi.fn(),listProducts:vi.fn(),findChannel:vi.fn(),isBanned:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./db",()=>({transaction:mocks.transaction,query:mocks.query}));
vi.mock("./extension-auth",()=>({verifyExtensionRequest:mocks.extensionPrincipal,verifyExtensionBitsReceipt:mocks.receipt}));
vi.mock("./twitch",()=>({getExtensionTransaction:mocks.getExtensionTransaction,listExtensionBitsProducts:mocks.listProducts,twitchExtensionClientId:()=>"extension-client"}));
vi.mock("./channels",()=>({findChannel:mocks.findChannel,isBanned:mocks.isBanned}));

import { createExtensionBitsIntent,getExtensionBitsState,reconcilePaidBitsReceipt,recordExtensionBitsReceipt } from "./paid-bits-service";
import { ApiError } from "./http";

const intentId="73afcad4-d30a-4fd8-9c33-f6c1c277a7bf";
const transactionId="twtx-001";
const principal={channelId:"123",opaqueUserId:"opaque",linkedTwitchUserId:"456"};
const receipt={transactionId,userId:"456",occurredAt:new Date("2026-10-24T10:00:30Z"),inDevelopment:false};
interface TestClient{query:(sql:string,values?:unknown[])=>Promise<{rows:Array<Record<string,unknown>>;rowCount:number}>}

function makeClient(state:string,expiresAt=new Date("2026-10-24T10:01:00Z")){
  const calls:Array<{sql:string;values?:unknown[]}>=[];
  const client:TestClient={query:vi.fn(async(sql:string,values?:unknown[])=>{
    calls.push({sql,values});
    if(sql.includes("SELECT state,action_kind,opaque_user_id,twitch_user_id,purchase_window_started_at"))return {rows:[{
      state,action_kind:"turbo_dispatch",proposal_id:null,opaque_user_id:"opaque",twitch_user_id:"456",purchase_window_started_at:new Date("2026-10-24T10:00:00Z"),expires_at:expiresAt,receipt_transaction_id:null,
    }],rowCount:1};
    if(sql.includes("SELECT * FROM sloptogether.extension_bits_transactions"))return {rows:[],rowCount:0};
    return {rows:[],rowCount:1};
  })};
  return {client,calls};
}

function request(){
  return new Request("https://clips.gg/sloptogether/api/v1/extension/bits/receipt",{
    method:"POST",headers:{"Content-Type":"application/json","x-extension-jwt":"signed-extension-token"},
    body:JSON.stringify({intentId,transactionReceipt:"signed-bits-receipt-token-long-enough"}),
  });
}

beforeEach(()=>{
  vi.resetAllMocks();
  mocks.extensionPrincipal.mockReturnValue(principal);
  mocks.receipt.mockReturnValue(receipt);
  mocks.findChannel.mockResolvedValue({twitch_channel_id:"123",policy_revision:1});
  mocks.isBanned.mockResolvedValue(false);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});

describe("recordExtensionBitsReceipt",()=>{
  it("stores a durable reconciliation event instead of treating a missing EventSub row as a dispatch",async()=>{
    const {client,calls}=makeClient("intent_open");
    mocks.transaction.mockImplementation(async(work:(client:TestClient)=>Promise<unknown>)=>work(client));
    await expect(recordExtensionBitsReceipt(request())).resolves.toMatchObject({accepted:false,state:"receipt_seen",transactionId});
    const event=calls.find(call=>call.sql.includes("paid.bits.reconcile_receipt"));
    expect(event?.values).toEqual([intentId,JSON.stringify({intentId}),"bits-reconcile:"+intentId]);
    expect(calls.some(call=>call.sql.includes("INSERT INTO sloptogether.jobs"))).toBe(false);
  });

  it("reconciles a late signed receipt from an expired purchase window without reopening it",async()=>{
    const {client,calls}=makeClient("expired");
    mocks.transaction.mockImplementation(async(work:(client:TestClient)=>Promise<unknown>)=>work(client));
    await expect(recordExtensionBitsReceipt(request())).resolves.toMatchObject({accepted:true,state:"receipt_seen",transactionId});
    const bind=calls.find(call=>call.sql.includes("late_receipt_reconciliation_pending"));
    expect(bind).toBeDefined();
    expect(bind?.sql).not.toMatch(/SET state='receipt_seen'/);
    expect(calls.some(call=>call.sql.includes("paid.bits.reconcile_receipt"))).toBe(true);
  });
});

describe("reconcilePaidBitsReceipt",()=>{
  const internalRequest=(intentId:string,outboxId="42")=>new Request("https://clips.gg/sloptogether/api/v1/internal/bits/reconcile",{
    method:"POST",headers:{Authorization:"SlopBits "+"b".repeat(40),"Content-Type":"application/json"},
    body:JSON.stringify({intentId,outboxId,leaseUntil:new Date(Date.now()+4*60_000).toISOString()}),
  });

  function setup(receiptTime:Date){
    const intent={id:intentId,twitch_channel_id:"123",extension_client_id:"extension-client",twitch_user_id:"456",product_sku:"turbo-480p",
      amount_bits:400,reserved_usd:"0.55",receipt_transaction_id:transactionId,receipt_timestamp:receiptTime,
      purchase_window_started_at:new Date(receiptTime.getTime()-30_000),expires_at:new Date(receiptTime.getTime()+30_000),state:"receipt_seen"};
    const clientCalls:string[]=[];
    const client:TestClient={query:vi.fn(async(sql:string)=>{
      clientCalls.push(sql);
      return sql.includes("SELECT id,twitch_channel_id,twitch_user_id,receipt_transaction_id,state FROM sloptogether.paid_action_intents")
        ?{rows:[intent],rowCount:1}:{rows:[],rowCount:1};
    })};
    const queryCalls:string[]=[];
    mocks.query.mockImplementation(async(sql:string)=>{
      queryCalls.push(sql);
      if(sql.includes("SELECT id,twitch_channel_id,extension_client_id,twitch_user_id,product_sku,amount_bits,reserved_usd"))return {rows:[intent],rowCount:1};
      if(sql.includes("FROM sloptogether.extension_bits_transactions WHERE transaction_id=$1"))return {rows:[],rowCount:0};
      if(sql.includes("UPDATE sloptogether.outbox SET delivered_at"))return {rows:[{id:"42"}],rowCount:1};
      return {rows:[],rowCount:1};
    });
    mocks.transaction.mockImplementation(async(work:(client:TestClient)=>Promise<unknown>)=>work(client));
    return {clientCalls,queryCalls};
  }

  beforeEach(()=>vi.stubEnv("SLOPTOGETHER_BITS_RECONCILE_SECRET","b".repeat(40)));

  it("records an unverified support state without booking the receipt as confirmed money",async()=>{
    const {clientCalls,queryCalls}=setup(new Date(Date.now()-11*60_000));
    mocks.getExtensionTransaction.mockRejectedValue(new ApiError(404,"extension_transaction_lookup_failed"));
    await expect(reconcilePaidBitsReceipt(internalRequest(intentId))).resolves.toMatchObject({state:"receipt_unverified",reconciled:true});
    expect(clientCalls.some(sql=>sql.includes("state='receipt_unverified'"))).toBe(true);
    expect(clientCalls.some(sql=>sql.includes("INSERT INTO sloptogether.funding_authorizations"))).toBe(false);
    const ack=queryCalls.find(sql=>sql.includes("UPDATE sloptogether.outbox SET delivered_at"));
    expect(ack).toContain("id=$1::bigint");
    expect(ack).toContain("aggregate_id=$2");
    expect(ack).toContain("leased_until=$3::timestamptz");
  });

  it("keeps a recent missing transaction pending for retry without acknowledging its outbox",async()=>{
    const {clientCalls,queryCalls}=setup(new Date(Date.now()-60_000));
    mocks.getExtensionTransaction.mockRejectedValue(new ApiError(404,"extension_transaction_lookup_failed"));
    await expect(reconcilePaidBitsReceipt(internalRequest(intentId))).rejects.toMatchObject({status:503,code:"bits_transaction_not_yet_visible"});
    expect(clientCalls.some(sql=>sql.includes("state='receipt_unverified'"))).toBe(false);
    expect(queryCalls.some(sql=>sql.includes("UPDATE sloptogether.outbox SET delivered_at"))).toBe(false);
  });
});

describe("Bits subscription readiness",()=>{
  it("does not expose purchase products without a currently verified EventSub subscription",async()=>{
    for(const [key,value] of Object.entries({
      SLOPTOGETHER_BITS_TURBO_ENABLED:"true",SLOPTOGETHER_BITS_POLICY_APPROVED:"true",SLOPTOGETHER_BITS_EVENTSUB_READY:"true",
      SLOPTOGETHER_BITS_DISPATCH_READY:"true",SLOPTOGETHER_BITS_RECONCILE_SECRET:"r".repeat(40),
      SLOPTOGETHER_BITS_RECONCILE_URL:"http://localhost:3000/sloptogether/api/v1/internal/bits/reconcile",
      PUBLIC_APP_URL:"http://localhost:3000/sloptogether",TWITCH_EXTENSION_CLIENT_ID:"extension-client",
      SLOPTOGETHER_BITS_TURBO_PRODUCTS_JSON:JSON.stringify([{sku:"turbo-480p",amountBits:400,resolution:"480P",reservedUsd:0.55}]),
    }))vi.stubEnv(key,value);
    mocks.extensionPrincipal.mockReturnValue({channelId:"123",linkedTwitchUserId:"456",opaqueUserId:"opaque"});
    mocks.query.mockResolvedValue({rows:[],rowCount:0});
    await expect(getExtensionBitsState(new Request("https://clips.gg/sloptogether/api/v1/extension/bits/state")))
      .rejects.toMatchObject({status:503,code:"bits_eventsub_unavailable"});
    expect(mocks.listProducts).not.toHaveBeenCalled();
  });

  it("rechecks and locks the verified Bits subscription before creating a paid intent",async()=>{
    for(const [key,value] of Object.entries({
      SLOPTOGETHER_BITS_TURBO_ENABLED:"true",SLOPTOGETHER_BITS_POLICY_APPROVED:"true",SLOPTOGETHER_BITS_EVENTSUB_READY:"true",
      SLOPTOGETHER_BITS_DISPATCH_READY:"true",SLOPTOGETHER_BITS_RECONCILE_SECRET:"r".repeat(40),
      SLOPTOGETHER_BITS_RECONCILE_URL:"http://localhost:3000/sloptogether/api/v1/internal/bits/reconcile",
      PUBLIC_APP_URL:"http://localhost:3000/sloptogether",TWITCH_EXTENSION_CLIENT_ID:"extension-client",
      SLOPTOGETHER_BITS_TURBO_PRODUCTS_JSON:JSON.stringify([{sku:"turbo-480p",amountBits:400,resolution:"480P",reservedUsd:0.55}]),
    }))vi.stubEnv(key,value);
    mocks.listProducts.mockResolvedValue([{sku:"turbo-480p",amountBits:400,displayName:"480P Turbo",inDevelopment:false}]);
    mocks.query.mockResolvedValue({rows:[{subscription_id:"bits-subscription"}],rowCount:1});
    const calls:Array<{sql:string;values?:unknown[]}> = [];
    const client:TestClient={query:vi.fn(async(sql:string,values?:unknown[])=>{
      calls.push({sql,values});
      if(sql.includes("SELECT subscription_id FROM sloptogether.extension_bits_eventsub_subscriptions"))return {rows:[{subscription_id:"bits-subscription"}],rowCount:1};
      if(sql.includes("SELECT policy_revision FROM sloptogether.channels"))return {rows:[{policy_revision:1}],rowCount:1};
      if(sql.includes("SELECT count(*)::text AS count"))return {rows:[{count:"0"}],rowCount:1};
      if(sql.includes("SELECT s.id AS segment_id"))return {rows:[{segment_id:"73afcad4-d30a-4fd8-9c33-f6c1c277a7bf",revision_id:"72afcad4-d30a-4fd8-9c33-f6c1c277a7bf",prompt:"A safe test prompt.",input_sha256:Buffer.alloc(32),input_screen_id:"71afcad4-d30a-4fd8-9c33-f6c1c277a7bf",screen_sha256:Buffer.alloc(32),moderation_model:"omni-moderation-latest",moderation_policy_revision:1,start_boundary_revision_id:"70afcad4-d30a-4fd8-9c33-f6c1c277a7bf",start_asset_id:"69afcad4-d30a-4fd8-9c33-f6c1c277a7bf",start_sha256:Buffer.alloc(32),requested_end_boundary_revision_id:null,dependency_resolution_id:null}],rowCount:1};
      return {rows:[],rowCount:1};
    })};
    mocks.transaction.mockImplementation(async(work:(client:TestClient)=>Promise<unknown>)=>work(client));
    const request=new Request("https://clips.gg/sloptogether/api/v1/extension/bits/intents",{method:"POST",headers:{"Content-Type":"application/json","x-extension-jwt":"signed-extension-token"},body:JSON.stringify({sku:"turbo-480p"})});
    await expect(createExtensionBitsIntent(request)).resolves.toMatchObject({sku:"turbo-480p"});
    expect(calls.some(call=>call.sql.includes("state='enabled' FOR SHARE"))).toBe(true);
  });

  it("refuses an intent if the verified Bits subscription is revoked after product lookup",async()=>{
    for(const [key,value] of Object.entries({
      SLOPTOGETHER_BITS_TURBO_ENABLED:"true",SLOPTOGETHER_BITS_POLICY_APPROVED:"true",SLOPTOGETHER_BITS_EVENTSUB_READY:"true",
      SLOPTOGETHER_BITS_DISPATCH_READY:"true",SLOPTOGETHER_BITS_RECONCILE_SECRET:"r".repeat(40),
      SLOPTOGETHER_BITS_RECONCILE_URL:"http://localhost:3000/sloptogether/api/v1/internal/bits/reconcile",
      PUBLIC_APP_URL:"http://localhost:3000/sloptogether",TWITCH_EXTENSION_CLIENT_ID:"extension-client",
      SLOPTOGETHER_BITS_TURBO_PRODUCTS_JSON:JSON.stringify([{sku:"turbo-480p",amountBits:400,resolution:"480P",reservedUsd:0.55}]),
    }))vi.stubEnv(key,value);
    mocks.listProducts.mockResolvedValue([{sku:"turbo-480p",amountBits:400,displayName:"480P Turbo",inDevelopment:false}]);
    let reads=0;
    mocks.query.mockImplementation(async()=>({rows:++reads===1?[{subscription_id:"bits-subscription"}]:[],rowCount:reads===1?1:0}));
    const calls:string[]=[];
    const client:TestClient={query:vi.fn(async(sql:string)=>{calls.push(sql);if(sql.includes("SELECT subscription_id FROM sloptogether.extension_bits_eventsub_subscriptions"))return {rows:[],rowCount:0};return {rows:[],rowCount:1};})};
    mocks.transaction.mockImplementation(async(work:(client:TestClient)=>Promise<unknown>)=>work(client));
    const request=new Request("https://clips.gg/sloptogether/api/v1/extension/bits/intents",{method:"POST",headers:{"Content-Type":"application/json","x-extension-jwt":"signed-extension-token"},body:JSON.stringify({sku:"turbo-480p"})});
    await expect(createExtensionBitsIntent(request)).rejects.toMatchObject({status:503,code:"bits_eventsub_unavailable"});
    expect(calls.some(sql=>sql.includes("INSERT INTO sloptogether.paid_action_intents"))).toBe(false);
  });
});
