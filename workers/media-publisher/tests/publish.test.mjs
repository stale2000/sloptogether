import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { classifyPreAirRequest, InvalidPublishError, normalizePublishPayload, packageHls, parseHlsPlaylist, requireEndpointFrame, validateHlsProfile } from "../src/publish.mjs";
import { parseProbeJson, validateMediaMetadata } from "../src/metadata.mjs";

const exec=promisify(execFile);

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

test("pre-air selection waits for approval and falls back on failure or expiry",()=>{
  assert.deepEqual(classifyPreAirRequest(null),{kind:"base"});
  assert.deepEqual(classifyPreAirRequest({state:"pending",binding_valid:true,expired:false,job_state:"running"}),{kind:"waiting"});
  assert.deepEqual(classifyPreAirRequest({state:"pending",binding_valid:true,expired:false,job_state:"succeeded",output_asset_id:"child",output_status:"approved",output_approval:"approved",output_screen_state:"clear"}),{kind:"upscale",assetId:"child"});
  assert.deepEqual(classifyPreAirRequest({state:"pending",binding_valid:true,expired:false,job_state:"succeeded",output_asset_id:"child",output_status:"validated",output_approval:null}),{kind:"waiting"});
  for(const state of ["failed","cancelled","expired"])
    assert.deepEqual(classifyPreAirRequest({state:"pending",binding_valid:true,expired:false,job_state:state}),{kind:"fallback",reason:`upscale_${state}`});
  assert.deepEqual(classifyPreAirRequest({state:"pending",binding_valid:true,expired:true,job_state:"running"}),{kind:"fallback",reason:"deadline_expired"});
  assert.deepEqual(classifyPreAirRequest({state:"pending",binding_valid:false}),{kind:"waiting",reason:"binding_invalid"});
  assert.deepEqual(classifyPreAirRequest({state:"pending",binding_valid:null}),{kind:"waiting",reason:"binding_invalid"});
  assert.deepEqual(classifyPreAirRequest({state:"pending",binding_valid:null,expired:true}),{kind:"invalid_fallback",reason:"binding_invalid"});
});

async function verifyPackaging(sourceWidth,sourceHeight){
  const directory=await mkdtemp(join(tmpdir(),"sloptogether-lowres-publish-"));
  try{
    const source=join(directory,"source.mp4");
    await exec("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i",`color=c=blue:s=${sourceWidth}x${sourceHeight}:r=24:d=1`,
      "-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=1","-c:v","libx264","-pix_fmt","yuv420p",
      "-c:a","aac","-shortest",source],{timeout:60_000});
    const before=createHash("sha256").update(await readFile(source)).digest("hex");
    const sourceProbe=await exec("ffprobe",["-v","error","-count_frames","-show_entries",
      "format=format_name,duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames",
      "-of","json",source]);
    assert.equal(validateMediaMetadata(parseProbeJson(sourceProbe.stdout),{width:sourceWidth,height:sourceHeight,fpsNum:24,fpsDen:1},(await readFile(source)).length,
      {minDurationSeconds:0.5,maxDurationSeconds:2}).width,sourceWidth);
    const profile=validateHlsProfile({width:1280,height:720,fpsNum:24,fpsDen:1},{segmentSeconds:1});
    const packaged=await packageHls("ffmpeg",source,directory,profile,{maxSegments:8,minDurationSeconds:0.5,maxDurationSeconds:2});
    const probe=await exec("ffprobe",["-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","json",join(directory,packaged.segments[0].fileName)]);
    assert.deepEqual(JSON.parse(probe.stdout).streams[0],{width:1280,height:720});
    assert.equal(createHash("sha256").update(await readFile(source)).digest("hex"),before);
  }finally{await rm(directory,{recursive:true,force:true});}
}

test("packages a 512×288 source at the channel playback size without changing it",{timeout:90_000},async()=>verifyPackaging(512,288));
test("continues to package a legacy 1280×720 source",{timeout:90_000},async()=>verifyPackaging(1280,720));
