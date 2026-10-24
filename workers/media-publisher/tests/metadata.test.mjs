import test from "node:test";
import assert from "node:assert/strict";
import { InvalidMediaError, parseProbeJson, trustedSystemApprovalCandidate, trustedUploaderApprovalPath, validateMediaMetadata } from "../src/metadata.mjs";

const expected={width:1280,height:720,fpsNum:24,fpsDen:1};
const validProbe={
  format:{format_name:"mov,mp4,m4a,3gp,3g2,mj2",duration:"15.000000"},
  streams:[
    {codec_type:"video",codec_name:"h264",width:1280,height:720,avg_frame_rate:"24/1",r_frame_rate:"24/1",nb_frames:"360",nb_read_frames:"360"},
    {codec_type:"audio",codec_name:"aac"},
  ],
};

test("accepts one MP4 video stream matching the channel output profile",()=>{
  assert.deepEqual(validateMediaMetadata(validProbe,expected,8_000_000),{
    width:1280,height:720,fpsNum:24,fpsDen:1,frameCount:360,durationSeconds:15,
  });
});

test("rejects invalid container, dimensions, frame rate, duration and size",()=>{
  const cases=[
    [{...validProbe,format:{...validProbe.format,format_name:"matroska,webm"}},"media_container_invalid"],
    [{...validProbe,streams:[{...validProbe.streams[0],width:1920}]},"media_dimensions_invalid"],
    [{...validProbe,streams:[{...validProbe.streams[0],avg_frame_rate:"30/1"}]},"media_framerate_invalid"],
    [{...validProbe,format:{...validProbe.format,duration:"20"}},"media_duration_invalid"],
  ];
  for(const [probe,code] of cases){
    assert.throws(()=>validateMediaMetadata(probe,expected,8_000_000),error=>error instanceof InvalidMediaError&&error.code===code);
  }
  assert.throws(()=>validateMediaMetadata(validProbe,expected,200_000_000),error=>error.code==="media_size_invalid");
});

test("rejects files with no single video stream and malformed ffprobe JSON",()=>{
  assert.throws(()=>validateMediaMetadata({...validProbe,streams:[]},expected,8_000_000),error=>error.code==="media_video_stream_invalid");
  assert.throws(()=>parseProbeJson("not-json"),error=>error.code==="media_probe_json_invalid");
});

test("requires decoded frames, H.264 video and an AAC audio stream",()=>{
  assert.throws(()=>validateMediaMetadata({...validProbe,streams:[{...validProbe.streams[0],codec_name:"mpeg4"},validProbe.streams[1]]},expected,8_000_000),error=>error.code==="media_video_codec_invalid");
  assert.throws(()=>validateMediaMetadata({...validProbe,streams:[validProbe.streams[0]]},expected,8_000_000),error=>error.code==="media_audio_stream_invalid");
  assert.throws(()=>validateMediaMetadata({...validProbe,streams:[{...validProbe.streams[0],nb_read_frames:"N/A"},validProbe.streams[1]]},expected,8_000_000),error=>error.code==="media_frame_count_invalid");
});

test("grants trusted auto-approval only to current channel-scoped key bindings",()=>{
  const current={stage:"video_base",producer_key_id:"key",execution_key_id:"key",execution_binding_id:"binding",execution_revoked_at:null,key_revoked_at:null,key_expires_at:null,
    execution_policy_revision:7,channel_policy_revision:7,execution_key_scopes:["worker:generation","artifact:system_approve"],execution_role:"generation"};
  assert.equal(trustedSystemApprovalCandidate(current),true);
  assert.equal(trustedSystemApprovalCandidate({...current,execution_policy_revision:6}),false);
  assert.equal(trustedSystemApprovalCandidate({...current,key_revoked_at:new Date()}),false);
  assert.equal(trustedSystemApprovalCandidate({...current,execution_key_scopes:["worker:generation"]}),false);
  assert.equal(trustedSystemApprovalCandidate({...current,execution_role:"upscale"}),false);
});

test("recognizes only current channel upload-bypass grants",()=>{
  const current={uploaded_by_twitch_user_id:"42",owner_twitch_user_id:"1",upload_policy_revision:5,channel_policy_revision:5,
    upload_approval_bypass_ids:["42"],role_based_upload_bypass:[],uploader_is_recent_moderator:false};
  assert.equal(trustedUploaderApprovalPath(current),"trusted_uploader_policy");
  assert.equal(trustedUploaderApprovalPath({...current,upload_approval_bypass_ids:[],role_based_upload_bypass:["broadcaster"],uploaded_by_twitch_user_id:"1"}),"trusted_uploader_policy");
  assert.equal(trustedUploaderApprovalPath({...current,upload_approval_bypass_ids:[],role_based_upload_bypass:["moderator"],uploader_is_recent_moderator:true}),"trusted_uploader_policy");
  assert.equal(trustedUploaderApprovalPath({...current,channel_policy_revision:6}),null);
});
