import assert from "node:assert/strict";
import test from "node:test";
import { publisherEventKinds } from "../src/index.mjs";
import { maxQueueAgeSeconds, maxQueueAttempts, queueSnapshot } from "../src/queue-health.mjs";

test("measures only due, undelivered publisher events, including active leases",async()=>{
  let sql,args;
  const pool={query:async(query,values)=>{sql=query;args=values;return {rows:[{due:3,leased:1,retrying:0,oldest_due_seconds:901}]};}};
  const result=await queueSnapshot(pool,"https://uploads.clips.gg/worker-media",900);
  assert.deepEqual(result,{event:"media_publisher_health",healthy:false,due:3,leased:1,retryingAtLimit:0,oldestDueSeconds:901,maxQueueAgeSeconds:900,maxAttempts:5});
  assert.match(sql,/delivered_at IS NULL/);
  assert.match(sql,/available_at<=clock_timestamp\(\)/);
  assert.deepEqual(args,[publisherEventKinds(true),5]);
  assert.ok(!args[0].includes("paid.turbo.dispatch"));
});

test("healthy empty queue is distinct from an unavailable database",async()=>{
  const snapshot=await queueSnapshot({query:async()=>({rows:[{due:0,leased:0,retrying:0,oldest_due_seconds:0}]})},null,900);
  assert.equal(snapshot.healthy,true);
  const retry=await queueSnapshot({query:async()=>({rows:[{due:0,leased:0,retrying:1,oldest_due_seconds:0}]})},null,900);
  assert.equal(retry.healthy,false);
  await assert.rejects(queueSnapshot({query:async()=>{throw new Error("db unavailable");}},null,900),/db unavailable/);
  await assert.rejects(queueSnapshot({query:async()=>({rows:[{due:0,leased:1,retrying:0,oldest_due_seconds:0}]})},null,900),/snapshot_invalid/);
  assert.ok(publisherEventKinds(false).includes("paid.bits.reconcile_receipt"));
});

test("rejects invalid monitoring thresholds rather than silently masking backlog",()=>{
  assert.equal(maxQueueAgeSeconds(undefined),900);
  assert.equal(maxQueueAgeSeconds("30"),30);
  for(const value of ["0","1.5","not-a-number","86401"]) assert.throws(()=>maxQueueAgeSeconds(value),/invalid/);
  assert.equal(maxQueueAttempts(undefined),5);
  for(const value of ["0","1.5","not-a-number","1001"]) assert.throws(()=>maxQueueAttempts(value),/invalid/);
});
