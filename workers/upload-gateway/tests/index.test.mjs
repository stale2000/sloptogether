import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import gateway from "../src/index.ts";

globalThis.FixedLengthStream ??= class extends TransformStream {
  constructor(length) {
    let written = 0;
    super({
      transform(chunk, controller) {
        written += chunk.byteLength;
        if (written > length) throw new Error("fixed_length_stream_too_long");
        controller.enqueue(chunk);
      },
      flush() {
        if (written !== length) throw new Error("fixed_length_stream_length_mismatch");
      },
    });
  }
};

const secret="upload-ticket-secret-longer-than-32-characters";
const uploadId="123e4567-e89b-42d3-a456-426614174000";

function signedTicket(payload,key=secret){
  const encoded=Buffer.from(JSON.stringify(payload)).toString("base64url");
  return encoded+"."+createHmac("sha256",key).update(encoded).digest("base64url");
}

test("native uploads need a valid ticket and accept a missing Content-Length",async()=>{
  const bytes=new Uint8Array([1,2,3,4]);
  const payload={version:1,uploadId,channelId:"123",storageKey:"incoming/123/attempt/video.mp4",contentType:"video/mp4",maxBytes:bytes.length,expiresAt:new Date(Date.now()+60000).toISOString()};
  const ticket=signedTicket(payload);
  let written=0;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async (url,options)=>{
    assert.equal(String(url),`https://sloptogether.vercel.app/sloptogether/api/v1/internal/uploads/${uploadId}/authorize`);
    assert.equal(options.headers["x-upload-gateway-secret"],"gateway-secret");
    return Response.json({authorized:true,...payload});
  };
  try{
    const env={APP_ORIGIN:"https://sloptogether.vercel.app",UPLOAD_TICKET_KEY:secret,UPLOAD_GATEWAY_SECRET:"gateway-secret",MEDIA_BUCKET:{head:async()=>null,delete:async()=>assert.fail("valid streamed upload must stay stored"),put:async(_key,body)=>{for await(const chunk of body)written+=chunk.length;return {}}}};
    const request=new Request(`https://uploads.example/uploads/${uploadId}?ticket=${encodeURIComponent(ticket)}`,{method:"PUT",headers:{"Content-Type":"video/mp4"},body:bytes});
    assert.equal(request.headers.get("origin"),null);
    assert.equal(request.headers.get("content-length"),null);
    const response=await gateway.fetch(request,env);
    assert.equal(response.status,201);
    assert.equal(written,bytes.length);
  }finally{globalThis.fetch=originalFetch;}
});

test("browser uploads from an unapproved origin fail before storage",async()=>{
  const response=await gateway.fetch(new Request(`https://uploads.example/uploads/${uploadId}?ticket=invalid`,{method:"PUT",headers:{Origin:"https://attacker.example","Content-Type":"video/mp4"},body:new Uint8Array([1])}),{});
  assert.equal(response.status,403);
});

test("browser upload CORS uses Clips.gg's canonical www origin",async()=>{
  const allowed=await gateway.fetch(new Request(`https://uploads.example/uploads/${uploadId}`,{method:"OPTIONS",headers:{Origin:"https://www.clips.gg"}}),{});
  assert.equal(allowed.status,204);
  assert.equal(allowed.headers.get("access-control-allow-origin"),"https://www.clips.gg");
  const apex=await gateway.fetch(new Request(`https://uploads.example/uploads/${uploadId}`,{method:"PUT",headers:{Origin:"https://clips.gg"}}),{});
  assert.equal(apex.status,403);
});

test("worker media tickets stream only the exact channel-scoped R2 object",async()=>{
  const bytes=new Uint8Array([1,2,3,4]);
  const payload={version:1,purpose:"worker_asset_read",channelId:"123",leaseId:uploadId,assetId:"423e4567-e89b-42d3-a456-426614174000",fence:7,
    storageKey:"private/123/images/asset/frame.png",contentType:"image/png",byteSize:bytes.length,expiresAt:new Date(Date.now()+60000).toISOString()};
  let requestedKey="";
  const env={UPLOAD_TICKET_KEY:secret,PUBLISHER_UPLOAD_TICKET_KEY:"publisher-only-ticket-secret-longer-than-32-characters",
    MEDIA_BUCKET:{get:async key=>{requestedKey=key;return {body:new Response(bytes).body,size:bytes.length,etag:"frame-etag"}}}};
  const response=await gateway.fetch(new Request("https://uploads.clips.gg/worker-media",{headers:{"X-Worker-Artifact-Ticket":signedTicket(payload)}}),env);
  assert.equal(response.status,200);
  assert.equal(requestedKey,payload.storageKey);
  assert.equal(response.headers.get("content-type"),"image/png");
  assert.equal(response.headers.get("content-length"),String(bytes.length));
  assert.equal(response.headers.get("cache-control"),"private, no-store");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);
});

test("worker media reads reject expired, altered and cross-channel tickets before R2",async()=>{
  let reads=0;
  const env={UPLOAD_TICKET_KEY:secret,MEDIA_BUCKET:{get:async()=>{reads++;return null}}};
  const base={version:1,purpose:"worker_asset_read",channelId:"123",leaseId:uploadId,assetId:"423e4567-e89b-42d3-a456-426614174000",fence:7,
    storageKey:"private/123/images/asset/frame.png",contentType:"image/png",byteSize:4,expiresAt:new Date(Date.now()+60000).toISOString()};
  const expired=await gateway.fetch(new Request("https://uploads.clips.gg/worker-media",{headers:{"X-Worker-Artifact-Ticket":signedTicket({...base,expiresAt:new Date(Date.now()-1000).toISOString()})}}),env);
  const crossChannel=await gateway.fetch(new Request("https://uploads.clips.gg/worker-media",{headers:{"X-Worker-Artifact-Ticket":signedTicket({...base,storageKey:"private/456/images/asset/frame.png"})}}),env);
  const tampered=signedTicket(base).replace(/.$/,"x");
  const altered=await gateway.fetch(new Request("https://uploads.clips.gg/worker-media",{headers:{"X-Worker-Artifact-Ticket":tampered}}),env);
  assert.deepEqual([expired.status,crossChannel.status,altered.status],[403,403,403]);
  assert.equal(reads,0);
});

test("worker media reads fail closed when the stored object size changed",async()=>{
  const payload={version:1,purpose:"worker_asset_read",channelId:"123",leaseId:uploadId,assetId:"423e4567-e89b-42d3-a456-426614174000",fence:7,
    storageKey:"incoming/123/attempt/output.mp4",contentType:"video/mp4",byteSize:4,expiresAt:new Date(Date.now()+60000).toISOString()};
  const env={UPLOAD_TICKET_KEY:secret,MEDIA_BUCKET:{get:async()=>({body:new Response(new Uint8Array([1,2,3,4,5])).body,size:5,etag:"unexpected"})}};
  const response=await gateway.fetch(new Request("https://uploads.clips.gg/worker-media",{headers:{"X-Worker-Artifact-Ticket":signedTicket(payload)}}),env);
  assert.equal(response.status,409);
  assert.deepEqual(await response.json(),{error:"worker_media_size_changed"});
});

test("publisher tickets use a dedicated key when configured",async()=>{
  const publisherSecret="publisher-only-ticket-secret-longer-than-32-characters";
  const payload={version:1,purpose:"media_publisher",operation:"delete",channelId:"123",storageKey:"incoming/123/attempt/output.mp4",
    contentType:"video/mp4",byteSize:0,expiresAt:new Date(Date.now()+60000).toISOString()};
  let deleted="";
  const env={UPLOAD_TICKET_KEY:secret,PUBLISHER_UPLOAD_TICKET_KEY:publisherSecret,MEDIA_BUCKET:{delete:async key=>{deleted=key}}};
  const valid=await gateway.fetch(new Request("https://uploads.clips.gg/worker-media",{method:"DELETE",headers:{"X-Worker-Artifact-Ticket":signedTicket(payload,publisherSecret)}}),env);
  const oldKey=await gateway.fetch(new Request("https://uploads.clips.gg/worker-media",{method:"DELETE",headers:{"X-Worker-Artifact-Ticket":signedTicket(payload)}}),env);
  assert.equal(valid.status,204);
  assert.equal(deleted,payload.storageKey);
  assert.equal(oldKey.status,403);
});
