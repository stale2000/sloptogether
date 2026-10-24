import test from "node:test";
import assert from "node:assert/strict";
import { processBitsReconcileMessage } from "../src/bits-reconcile.mjs";

const intentId="73afcad4-d30a-4fd8-9c33-f6c1c277a7bf";
const config={publicAppUrl:"http://localhost:3000/sloptogether",bitsReconcileUrl:"http://localhost:3000/sloptogether/api/v1/internal/bits/reconcile",bitsReconcileSecret:"b".repeat(40)};
const message={id:"17",aggregateId:intentId,leaseUntil:new Date("2026-10-24T10:01:00Z"),payload:{intentId}};

test("posts a fenced receipt reconciliation to the configured internal API",async()=>{
  let request;
  const result=await processBitsReconcileMessage({config,message,fetchImpl:async(url,options)=>{
    request={url:String(url),options};return new Response(JSON.stringify({state:"reserved"}),{status:200});
  }});
  assert.equal(result.status,"reconciled");
  assert.equal(result.state,"reserved");
  assert.equal(request.url,config.bitsReconcileUrl);
  assert.equal(request.options.headers.Authorization,"SlopBits "+config.bitsReconcileSecret);
  assert.deepEqual(JSON.parse(request.options.body),{intentId,outboxId:"17",leaseUntil:"2026-10-24T10:01:00.000Z"});
  assert.equal(request.options.redirect,"error");
});

test("rejects malformed outbox identity and missing internal credentials",async()=>{
  let calls=0;
  const fetchImpl=async()=>{calls++;return new Response("{}",{status:200});};
  await assert.rejects(processBitsReconcileMessage({config,message:{...message,aggregateId:"wrong"},fetchImpl}),error=>error.code==="bits_reconcile_payload_invalid");
  await assert.rejects(processBitsReconcileMessage({config:{...config,bitsReconcileSecret:""},message,fetchImpl}),error=>error.code==="bits_reconcile_not_configured");
  await assert.rejects(processBitsReconcileMessage({config:{...config,bitsReconcileUrl:"https://attacker.example/reconcile"},message,fetchImpl}),error=>error.code==="bits_reconcile_not_configured");
  assert.equal(calls,0);
});

test("retries server and response failures rather than acknowledging the outbox",async()=>{
  await assert.rejects(processBitsReconcileMessage({config,message,fetchImpl:async()=>new Response("",{status:503})}),error=>error.code==="bits_reconcile_http_503");
  await assert.rejects(processBitsReconcileMessage({config,message,fetchImpl:async()=>new Response("not-json",{status:200})}),error=>error.code==="bits_reconcile_response_invalid");
});
