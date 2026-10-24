import test from "node:test";
import assert from "node:assert/strict";
import { processComfyFrameExpiry } from "../src/comfy-frame-expiry.mjs";

const id="73afcad4-d30a-4fd8-9c33-f6c1c277a7bf";

function poolFor({removed=true,acknowledged=true}={}){
  const calls=[];
  const client={
    query:async(sql,values)=>{
      calls.push({sql,values});
      if(sql.startsWith("DELETE FROM sloptogether.comfy_frame_generations"))return {rowCount:removed?1:0,rows:removed?[{id}]:[]};
      if(sql.includes("UPDATE sloptogether.outbox SET delivered_at"))return {rowCount:acknowledged?1:0,rows:acknowledged?[{id:"9"}]:[]};
      return {rowCount:1,rows:[]};
    },
    release(){calls.push({sql:"release"});},
  };
  return {calls,connect:async()=>client};
}

test("expires a private Comfy frame row and acknowledges only its current outbox lease",async()=>{
  const pool=poolFor();
  await assert.doesNotReject(()=>processComfyFrameExpiry(pool,{id:"9",aggregateId:id,payload:{id},leaseUntil:new Date()}));
  assert.match(pool.calls[1].sql,/expires_at<=now\(\)/);
  assert.equal(pool.calls.find(call=>call.sql.includes("UPDATE sloptogether.outbox SET delivered_at")).values[1],id);
  assert.equal(pool.calls.at(-2).sql,"COMMIT");
});

test("rolls back when the cleanup lease is stale",async()=>{
  const pool=poolFor({acknowledged:false});
  await assert.rejects(()=>processComfyFrameExpiry(pool,{id:"9",aggregateId:id,payload:{id},leaseUntil:new Date()}),/comfy_frame_expiry_lease_stale/);
  assert.equal(pool.calls.at(-2).sql,"ROLLBACK");
});

test("rejects a mismatched aggregate before touching the database",async()=>{
  let connected=false;
  const pool={connect:async()=>{connected=true;throw new Error("unexpected");}};
  await assert.rejects(()=>processComfyFrameExpiry(pool,{id:"9",aggregateId:"other",payload:{id},leaseUntil:new Date()}),/comfy_frame_expiry_invalid/);
  assert.equal(connected,false);
});
