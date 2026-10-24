import test from "node:test";
import assert from "node:assert/strict";
import { falCancelUrl,falInput,falRequestId,falResultUrl,falStatusUrl,falVideoResult,falVideoUrl,submitFalTurbo } from "../src/fal-turbo.mjs";
import { falConformArgs,falHasAudio,falResultErrorDisposition,falSubmitOutcome } from "../src/paid-turbo.mjs";

const signedImage="https://r2.example.test/private/start.png?X-Amz-Signature=abc";
const snapshot={schemaVersion:1,prompt:"A short safe scene",resolution:"480P",durationSeconds:15,promptExpansionMode:"disabled",enableSafetyChecker:true,syncMode:false};

test("builds one fixed Turbo request with private retained output and provider retries disabled",async()=>{
  const original=globalThis.fetch;let submitted;
  globalThis.fetch=async(url,init)=>{
    submitted={url:String(url),init,body:JSON.parse(init.body)};
    return new Response(JSON.stringify({request_id:"request_123"}),{status:200,headers:{"Content-Type":"application/json"}});
  };
  try{
    assert.deepEqual(await submitFalTurbo("secret",snapshot,signedImage,null),{requestId:"request_123"});
  }finally{globalThis.fetch=original;}
  assert.equal(submitted.url,"https://queue.fal.run/minimax/h3-max-turbo/image-to-video");
  assert.equal(submitted.init.headers.Authorization,"Key secret");
  assert.equal(submitted.init.headers["X-Fal-No-Retry"],"1");
  assert.equal(submitted.init.headers["x-app-fal-disable-fallback"],"true");
  assert.equal(submitted.init.headers["X-Fal-Store-IO"],"0");
  assert.deepEqual(JSON.parse(submitted.init.headers["X-Fal-Object-Lifecycle-Preference"]),{
    expiration_duration_seconds:3600,initial_acl:{default:"forbid",rules:[]},
  });
  assert.deepEqual(submitted.body,{prompt:snapshot.prompt,duration:15,resolution:"480P",prompt_expansion_mode:"disabled",
    enable_safety_checker:true,sync_mode:false,image_url:signedImage});
});

test("adds only a valid approved end anchor and rejects malformed request identities",()=>{
  assert.equal(falInput(snapshot,signedImage,"https://r2.example.test/private/end.png?sig=def").end_image_url,
    "https://r2.example.test/private/end.png?sig=def");
  assert.equal(falInput(snapshot,"https://v3b.fal.media/files/b/store-1/frame.png",null).image_url,
    "https://v3b.fal.media/files/b/store-1/frame.png");
  assert.throws(()=>falInput(snapshot,"http://r2.example.test/frame.png?sig=bad",null),/fal_input_invalid/);
  assert.equal(falRequestId("request/secret"),null);
  assert.equal(falStatusUrl("request_123"),"https://queue.fal.run/minimax/h3-max-turbo/requests/request_123/status");
  assert.equal(falResultUrl("request_123"),"https://queue.fal.run/minimax/h3-max-turbo/requests/request_123");
  assert.equal(falCancelUrl("request_123"),"https://queue.fal.run/minimax/h3-max-turbo/requests/request_123/cancel");
});

test("accepts only private fal CDN video outputs",()=>{
  assert.equal(falVideoUrl("https://v3b.fal.media/files/b/store-1/video.mp4"),"https://v3b.fal.media/files/b/store-1/video.mp4");
  assert.equal(falVideoUrl("https://fal.media/files/b/store/video.mp4"),null);
  assert.equal(falVideoUrl("https://v3b.fal.media/files/b/store/video.mp4?public=1"),null);
  assert.deepEqual(falVideoResult({video:{url:"https://v3b.fal.media/files/b/store/video.mp4",content_type:"video/mp4",file_size:1024}},2048),
    {url:"https://v3b.fal.media/files/b/store/video.mp4",bytes:1024});
  assert.throws(()=>falVideoResult({video:{url:"https://v3.fal.media/files/b/store/video.mp4",content_type:"video/mp4",file_size:1024}},2048),/fal_video_result_invalid/);
});

test("keeps ambiguous Fal acknowledgments consumed instead of authorizing another submission",()=>{
  assert.equal(falSubmitOutcome("fal_http_400"),"paid_unfulfilled");
  assert.equal(falSubmitOutcome("fal_http_408"),"consumed_uncertain");
  assert.equal(falSubmitOutcome("fal_http_503"),"consumed_uncertain");
  assert.equal(falSubmitOutcome("fal_request_uncertain"),"consumed_uncertain");
});

test("retries temporary result throttles and only fails repeated permanent provider errors",()=>{
  assert.equal(falResultErrorDisposition("fal_http_408",5),"retry");
  assert.equal(falResultErrorDisposition("fal_cdn_http_429",5),"retry");
  assert.equal(falResultErrorDisposition("fal_http_503",5),"retry");
  assert.equal(falResultErrorDisposition("fal_http_404",1),"retry");
  assert.equal(falResultErrorDisposition("fal_http_404",3),"failed");
  assert.equal(falResultErrorDisposition("fal_video_result_invalid",1),"failed");
});

test("conforms silent Fal video with padded AAC and preserves provider audio when present",()=>{
  const profile={output_width:1280,output_height:720,output_fps_num:24,output_fps_den:1};
  assert.equal(falHasAudio({streams:[{codec_type:"video"}]}),false);
  assert.equal(falHasAudio({streams:[{codec_type:"video"},{codec_type:"audio"}]}),true);
  assert.throws(()=>falHasAudio({}),/fal_input_probe_invalid/);
  const silent=falConformArgs("input.mp4","silent.mp4",profile,false);
  assert.ok(silent.includes("anullsrc=channel_layout=stereo:sample_rate=48000"));
  assert.ok(silent.includes("1:a:0"));
  assert.ok(silent.includes("apad"));
  assert.ok(silent.includes("-shortest"));
  const voiced=falConformArgs("input.mp4","voiced.mp4",profile,true);
  assert.ok(voiced.includes("0:a:0"));
  assert.ok(!voiced.includes("anullsrc=channel_layout=stereo:sample_rate=48000"));
});
