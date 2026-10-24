import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { deriveInputDigests, extractAndScreenEndpoint, moderateEndpointPrompt, moderationKeyFrom, parseJpegDimensions, validateEndpointFrame } from "../src/endpoint.mjs";

test("moderation uses only its dedicated credential and never falls back to the paid story key",()=>{
  assert.equal(moderationKeyFrom({SLOPTOGETHER_OPENAI_MODERATION_KEY:" moderation-key ",OPENAI_API_KEY:"story-key"}),"moderation-key");
  assert.equal(moderationKeyFrom({SLOPTOGETHER_OPENAI_MODERATION_KEY:" ",OPENAI_API_KEY:"story-key"}),null);
  assert.equal(moderationKeyFrom({}),null);
});

function jpegHeader(width=1280,height=720){
  const bytes=Buffer.from([0xff,0xd8,0xff,0xc0,0x00,0x0b,0x08,0,0,0,0,0x01,0x01,0x11,0x00,0xff,0xd9]);
  bytes.writeUInt16BE(height,7);bytes.writeUInt16BE(width,9);
  return bytes;
}

test("endpoint digests match the server preflight prompt-then-image hash",()=>{
  const prompt="  A small ship finds a star.  ";
  const image=jpegHeader();
  const promptDigest=createHash("sha256").update("A small ship finds a star.").digest();
  const imageDigest=createHash("sha256").update(image).digest();
  const digest=createHash("sha256").update(Buffer.concat([promptDigest,imageDigest])).digest("hex");
  const result=deriveInputDigests(prompt,[{bytes:image,contentType:"image/jpeg"}]);
  assert.equal(result.prompt,"A small ship finds a star.");
  assert.equal(result.promptDigest,promptDigest.toString("hex"));
  assert.deepEqual(result.imageDigests,[imageDigest.toString("hex")]);
  assert.equal(result.digest,digest);
});

test("JPEG endpoint frames must fit the bounded image contract and expected profile",()=>{
  const frame=jpegHeader();
  assert.deepEqual(parseJpegDimensions(frame),{width:1280,height:720});
  assert.deepEqual(validateEndpointFrame(frame,{width:1280,height:720,maxBytes:1024}),{
    width:1280,height:720,byteSize:17,contentType:"image/jpeg",
  });
  assert.throws(()=>validateEndpointFrame(frame,{width:1920,height:1080}),error=>error.code==="endpoint_width_mismatch");
  assert.throws(()=>validateEndpointFrame(Buffer.alloc(24)),error=>error.code==="endpoint_jpeg_invalid");
});

test("moderation clear/held responses preserve evidence metadata and return the moderation id",async()=>{
  const image=jpegHeader();
  let sent;
  const clear=await moderateEndpointPrompt({prompt:"A safe scene",imageBytes:image,apiKey:"test-key",fetchImpl:async(_url,request)=>{
    sent=JSON.parse(request.body);
    return {ok:true,json:async()=>({id:"mod-123",results:[{flagged:false,categories:{violence:false,adult:true},category_applied_input_types:{violence:["image"]}}]})};
  }});
  assert.equal(clear.decision,"clear");
  assert.equal(clear.moderationId,"mod-123");
  assert.deepEqual(clear.categories,{violence:false,adult:true});
  assert.deepEqual(clear.appliedInputTypes,{violence:["image"]});
  assert.equal(sent.model,"omni-moderation-latest");
  assert.equal(sent.input[1].image_url.url,`data:image/jpeg;base64,${image.toString("base64")}`);

  const held=await moderateEndpointPrompt({prompt:"A risky scene",imageBytes:image,apiKey:"test-key",fetchImpl:async()=>({ok:true,json:async()=>({results:[{flagged:true,categories:{violence:true}}]})})});
  assert.equal(held.decision,"held");
});

test("missing moderation configuration and HTTP or response failures are explicitly unavailable",async()=>{
  const image=jpegHeader();let calls=0;
  const missing=await moderateEndpointPrompt({prompt:"scene",imageBytes:image,apiKey:"",fetchImpl:async()=>{calls++;throw new Error("must not call")}});
  assert.equal(missing.decision,"unavailable");
  assert.equal(missing.unavailableCode,"input_moderation_not_configured");
  assert.equal(calls,0);

  const http=await moderateEndpointPrompt({prompt:"scene",imageBytes:image,apiKey:"test-key",fetchImpl:async()=>({ok:false})});
  assert.equal(http.decision,"unavailable");
  assert.equal(http.unavailableCode,"input_moderation_unavailable");
  const malformed=await moderateEndpointPrompt({prompt:"scene",imageBytes:image,apiKey:"test-key",fetchImpl:async()=>({ok:true,json:async()=>({results:[]})})});
  assert.equal(malformed.decision,"unavailable");
  assert.equal(malformed.unavailableCode,"input_moderation_invalid_response");
});

test("frame extraction feeds a bounded JPEG into an unavailable result without failing the clip",async()=>{
  const frame=jpegHeader();let args;
  const result=await extractAndScreenEndpoint({videoPath:"/private/approved.mp4",prompt:"A safe ending",apiKey:"",fetchImpl:async()=>{throw new Error("must not call")},config:{timeoutMs:5000},execFileImpl:async(_ffprobe,probeArgs)=>{
    assert.equal(probeArgs.includes("-count_frames"),true);
    return {stdout:"360\n"};
  },spawnImpl:(_ffmpeg,spawnArgs)=>{
    args=spawnArgs;
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
    queueMicrotask(()=>{child.stdout.end(frame);child.stderr.end();child.emit("close",0,null)});
    return child;
  }});
  assert.equal(args.includes("-xerror"),true);
  assert.equal(args[args.indexOf("-vf")+1],"select=eq(n\\,359)");
  assert.equal(args[args.indexOf("-vcodec")+1],"mjpeg");
  assert.equal(result.decision,"unavailable");
  assert.equal(result.unavailableCode,"input_moderation_not_configured");
  assert.equal(result.contentType,"image/jpeg");
  assert.equal(result.width,1280);
  assert.equal(result.height,720);
  assert.equal(result.frameBytes.toString("hex"),frame.toString("hex"));
  assert.equal(result.digest.length,64);
});
