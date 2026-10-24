import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import gateway from "../src/index.ts";

const secret="upload-ticket-secret-longer-than-32-characters";
const uploadId="123e4567-e89b-42d3-a456-426614174000";

function signedTicket(payload){
  const encoded=Buffer.from(JSON.stringify(payload)).toString("base64url");
  return encoded+"."+createHmac("sha256",secret).update(encoded).digest("base64url");
}

test("native uploads need a valid ticket and accept a missing Content-Length",async()=>{
  const bytes=new Uint8Array([1,2,3,4]);
  const payload={version:1,uploadId,channelId:"123",storageKey:"incoming/123/attempt/video.mp4",contentType:"video/mp4",maxBytes:bytes.length,expiresAt:new Date(Date.now()+60000).toISOString()};
  const ticket=signedTicket(payload);
  let written=0;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async (_url,options)=>{
    assert.equal(options.headers["x-upload-gateway-secret"],"gateway-secret");
    return Response.json({authorized:true,...payload});
  };
  try{
    const env={APP_ORIGIN:"https://clips.gg",UPLOAD_TICKET_KEY:secret,UPLOAD_GATEWAY_SECRET:"gateway-secret",MEDIA_BUCKET:{head:async()=>null,delete:async()=>assert.fail("valid streamed upload must stay stored"),put:async(_key,body)=>{for await(const chunk of body)written+=chunk.length;return {}}}};
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
