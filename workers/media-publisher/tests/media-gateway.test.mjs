import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import test from "node:test";
import { createMediaGatewayStorage, requiredEnvironment } from "../src/index.mjs";

const ticketKey="test-media-gateway-ticket-key-with-enough-entropy";
const config={mediaGatewayUrl:"https://uploads.clips.gg/worker-media",uploadTicketKey:ticketKey,bucket:"sloptogether-media"};

function decodeTicket(value){
  const [encoded,signature]=value.split(".");
  assert.equal(signature,createHmac("sha256",ticketKey).update(encoded).digest("base64url"));
  return JSON.parse(Buffer.from(encoded,"base64url").toString("utf8"));
}

test("gateway GET tickets are scoped to the source key and stream bounded bytes",async()=>{
  const source=new Uint8Array([1,2,3,4]);
  const previous=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{
    assert.equal(url,config.mediaGatewayUrl);
    assert.equal(init.method,"GET");
    assert.equal(init.headers["User-Agent"],"SlopTogether-Worker/0.1");
    assert.equal("Authorization" in init.headers,false);
    const ticket=decodeTicket(init.headers["X-Worker-Artifact-Ticket"]);
    assert.deepEqual({purpose:ticket.purpose,operation:ticket.operation,channelId:ticket.channelId,storageKey:ticket.storageKey},
      {purpose:"media_publisher",operation:"get",channelId:"123",storageKey:"private/123/artifacts/asset/output.mp4"});
    return new Response(source,{headers:{"Content-Length":String(source.length),"Content-Type":"video/mp4"}});
  };
  try{
    const storage=createMediaGatewayStorage(config);
    const result=await storage.send(new GetObjectCommand({Bucket:config.bucket,Key:"private/123/artifacts/asset/output.mp4"}));
    const chunks=[];for await(const chunk of result.Body)chunks.push(chunk);
    assert.equal(result.ContentLength,source.length);
    assert.equal(result.ContentType,"video/mp4");
    assert.deepEqual(Buffer.concat(chunks),Buffer.from(source));
  }finally{globalThis.fetch=previous;}
});

test("gateway PUT and DELETE tickets authorize one exact object operation",async()=>{
  const previous=globalThis.fetch;
  const bytes=Buffer.from([9,8,7]);
  const seen=[];
  globalThis.fetch=async(url,init)=>{
    const ticket=decodeTicket(init.headers["X-Worker-Artifact-Ticket"]);
    seen.push({url,method:init.method,ticket,body:init.body});
    return init.method==="PUT"?Response.json({etag:"etag-1"},{status:201}):new Response(null,{status:204});
  };
  try{
    const storage=createMediaGatewayStorage(config);
    const put=await storage.send(new PutObjectCommand({Bucket:config.bucket,Key:"private/123/hls/asset/000-abcd.ts",Body:bytes,ContentType:"video/mp2t"}));
    await storage.send(new DeleteObjectCommand({Bucket:config.bucket,Key:"incoming/123/attempt/output.mp4"}));
    assert.equal(put.ETag,"etag-1");
    assert.deepEqual(seen.map(x=>[x.method,x.ticket.operation,x.ticket.channelId,x.ticket.byteSize]),[["PUT","put","123",3],["DELETE","delete","123",0]]);
    assert.deepEqual(seen[0].body,bytes);
  }finally{globalThis.fetch=previous;}
});

test("gateway storage rejects foreign buckets and unscoped keys before sending",async()=>{
  let calls=0;const previous=globalThis.fetch;globalThis.fetch=async()=>{calls++;return Response.json({});};
  try{
    const storage=createMediaGatewayStorage(config);
    await assert.rejects(storage.send(new GetObjectCommand({Bucket:"other-bucket",Key:"private/123/a.mp4"})),/media_gateway_bucket_invalid/);
    await assert.rejects(storage.send(new DeleteObjectCommand({Bucket:config.bucket,Key:"public/123/a.mp4"})),/media_gateway_key_invalid/);
    assert.equal(calls,0);
  }finally{globalThis.fetch=previous;}
});

test("gateway mode requires the scoped ticket key but not raw R2 credentials",()=>{
  const env={DATABASE_URL:"postgresql://app@127.0.0.1/sloptogether",R2_BUCKET_NAME:"sloptogether-media",
    SLOPTOGETHER_MEDIA_GATEWAY_URL:config.mediaGatewayUrl,SLOPTOGETHER_UPLOAD_TICKET_KEY:ticketKey};
  const parsed=requiredEnvironment(env);
  assert.equal(parsed.mediaGatewayUrl,config.mediaGatewayUrl);
  assert.equal(parsed.bucket,"sloptogether-media");
  assert.equal(parsed.accessKeyId,null);
  assert.equal(parsed.secretAccessKey,null);
  assert.throws(()=>requiredEnvironment({...env,SLOPTOGETHER_MEDIA_GATEWAY_URL:"https://attacker.example/worker-media"}),/SLOPTOGETHER_MEDIA_GATEWAY_URL_invalid/);
});
