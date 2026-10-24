import test from "node:test";
import assert from "node:assert/strict";
import { InvalidPublishError, normalizePublishPayload, parseHlsPlaylist, requireEndpointFrame, validateHlsProfile } from "../src/publish.mjs";

test("normalizes only the asset identity from publish messages",()=>{
  const result=normalizePublishPayload({assetId:"4e1b3699-62d6-450d-bfc3-b18cf32ed7a4",approvalPath:"untrusted-client-value"});
  assert.deepEqual(result,{assetId:"4e1b3699-62d6-450d-bfc3-b18cf32ed7a4"});
  assert.throws(()=>normalizePublishPayload({assetId:"not-a-uuid"}),error=>error instanceof InvalidPublishError);
});

test("accepts only the channel's valid even 16:9 HLS profile",()=>{
  assert.deepEqual(validateHlsProfile({width:1280,height:720,fpsNum:24,fpsDen:1}),{
    width:1280,height:720,fpsNum:24,fpsDen:1,fps:24,segmentSeconds:2,
  });
  assert.throws(()=>validateHlsProfile({width:1280,height:700,fpsNum:24,fpsDen:1}),error=>error.code==="publish_profile_dimensions_invalid");
  assert.throws(()=>validateHlsProfile({width:1280,height:720,fpsNum:0,fpsDen:1}),error=>error.code==="publish_profile_framerate_invalid");
});

test("parses a complete ordered MPEG-TS playlist",()=>{
  const segments=parseHlsPlaylist(`#EXTM3U
#EXT-X-VERSION:3
#EXTINF:2.000000,
segment-000.ts
#EXTINF:1.250000,
segment-001.ts
#EXT-X-ENDLIST
`);
  assert.deepEqual(segments,[
    {sequence:0,durationSeconds:2,fileName:"segment-000.ts"},
    {sequence:1,durationSeconds:1.25,fileName:"segment-001.ts"},
  ]);
});

test("rejects incomplete or unsafe HLS playlist references",()=>{
  assert.throws(()=>parseHlsPlaylist("#EXTM3U\n#EXTINF:2,\n../secret.ts\n#EXT-X-ENDLIST"),error=>error.code==="hls_segment_uri_invalid");
  assert.throws(()=>parseHlsPlaylist("#EXTM3U\n#EXTINF:2,\nsegment-000.ts"),error=>error.code==="hls_playlist_incomplete");
  assert.throws(()=>parseHlsPlaylist("#EXTM3U\n#EXTINF:0,\nsegment-000.ts\n#EXT-X-ENDLIST"),error=>error.code==="hls_segment_duration_invalid");
});

test("retries publication when a continuation endpoint frame could not be extracted",()=>{
  assert.throws(()=>requireEndpointFrame({decision:"unavailable",unavailableCode:"endpoint_frame_timeout"}),error=>error.code==="endpoint_frame_timeout");
  const endpoint={decision:"unavailable",unavailableCode:"input_moderation_not_configured",frameBytes:Buffer.from("jpeg"),imageDigests:["a".repeat(64)]};
  assert.equal(requireEndpointFrame(endpoint),endpoint);
});
