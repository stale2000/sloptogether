export class InvalidMediaError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "InvalidMediaError";
    this.code = code;
  }
}

function rational(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  const [numerator, denominator, extra] = value.split("/");
  if (extra !== undefined || numerator === undefined) return null;
  const n = Number(numerator);
  const d = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || n <= 0 || d <= 0) return null;
  return n / d;
}

function reject(code, message) {
  throw new InvalidMediaError(code, message);
}

/** Use the job's target; legacy upscales predate target fields and were 1080p. */
export function expectedArtifactDimensions(current) {
  const planned=current?.planning_payload??{};
  const fallbackWidth=current?.stage==="video_upscale"?1920:Number(current?.output_width);
  const fallbackHeight=current?.stage==="video_upscale"?1080:Number(current?.output_height);
  const width=planned.outputWidth==null||planned.outputWidth===""?fallbackWidth:Number(planned.outputWidth);
  const height=planned.outputHeight==null||planned.outputHeight===""?fallbackHeight:Number(planned.outputHeight);
  return {width,height};
}

/** Validate decoded container metadata against a channel's pinned output profile. */
export function validateMediaMetadata(probe, expected, byteSize, options = {}) {
  const maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
  const minDuration = options.minDurationSeconds ?? 13;
  const maxDuration = options.maxDurationSeconds ?? 17;

  if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > maxBytes) {
    reject("media_size_invalid", "The MP4 file size is outside the accepted range.");
  }
  const formatName = typeof probe?.format?.format_name === "string" ? probe.format.format_name.split(",") : [];
  if (!formatName.includes("mp4") && !formatName.includes("mov")) {
    reject("media_container_invalid", "The uploaded file is not a supported MP4 container.");
  }
  const durationSeconds = Number(probe?.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds < minDuration || durationSeconds > maxDuration) {
    reject("media_duration_invalid", `The clip must be between ${minDuration} and ${maxDuration} seconds.`);
  }

  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const videos = streams.filter((stream) => stream?.codec_type === "video");
  if (videos.length !== 1) reject("media_video_stream_invalid", "The file must contain exactly one video stream.");
  const video = videos[0];
  if(video.codec_name!=="h264")reject("media_video_codec_invalid","The clip must use the browser-compatible H.264 video profile.");
  const width = Number(video.width);
  const height = Number(video.height);
  const outputWidth = Number(expected?.width);
  const outputHeight = Number(expected?.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width !== outputWidth || height !== outputHeight || width * 9 !== height * 16) {
    reject("media_dimensions_invalid", "The clip does not match the channel's exact 16:9 output dimensions.");
  }

  const fps = rational(video.avg_frame_rate) ?? rational(video.r_frame_rate);
  const expectedFps = Number(expected?.fpsNum) / Number(expected?.fpsDen);
  if (!fps || !Number.isFinite(expectedFps) || expectedFps <= 0 || Math.abs(fps - expectedFps) > 0.02) {
    reject("media_framerate_invalid", "The clip does not match the channel's configured frame rate.");
  }

  const decodedFrames=Number(video.nb_read_frames);
  const frameCount=decodedFrames;
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) {
    reject("media_frame_count_invalid", "The video frame count could not be verified.");
  }
  if(Math.abs(frameCount-durationSeconds*fps)>2)reject("media_frame_count_invalid","The decoded frame count does not match the clip duration and frame rate.");
  const audio=streams.filter(stream=>stream?.codec_type==="audio");
  if(audio.length!==1||audio[0]?.codec_name!=="aac")reject("media_audio_stream_invalid","The clip must contain one browser-compatible AAC dialogue/audio track.");

  return {
    width,
    height,
    fpsNum: Number(expected.fpsNum),
    fpsDen: Number(expected.fpsDen),
    frameCount,
    durationSeconds: Number(durationSeconds.toFixed(6)),
  };
}

export function parseProbeJson(raw) {
  let probe;
  try {
    probe = JSON.parse(raw);
  } catch {
    throw new InvalidMediaError("media_probe_json_invalid", "ffprobe returned invalid metadata.");
  }
  if (!probe || typeof probe !== "object" || !probe.format || !Array.isArray(probe.streams)) {
    throw new InvalidMediaError("media_probe_json_invalid", "ffprobe did not return the expected metadata.");
  }
  return probe;
}

export function trustedSystemApprovalCandidate(current,now=Date.now()){
  const role=current?.stage==="video_base"?"generation":current?.stage==="video_upscale"?"upscale":null;
  return Boolean(role&&current.producer_key_id&&current.producer_key_id===current.execution_key_id&&current.execution_binding_id
    &&current.execution_revoked_at===null&&current.key_revoked_at===null
    &&(!current.key_expires_at||current.key_expires_at.getTime()>now)
    &&current.execution_policy_revision===current.channel_policy_revision
    &&Array.isArray(current.execution_key_scopes)&&current.execution_key_scopes.includes("artifact:system_approve")
    &&current.execution_role===role);
}

export function trustedUploaderApprovalPath(current){
  if(!current||current.upload_policy_revision!==current.channel_policy_revision||typeof current.uploaded_by_twitch_user_id!=="string")return null;
  const uploader=current.uploaded_by_twitch_user_id;
  if(Array.isArray(current.upload_approval_bypass_ids)&&current.upload_approval_bypass_ids.includes(uploader))return "trusted_uploader_policy";
  if(uploader===current.owner_twitch_user_id&&Array.isArray(current.role_based_upload_bypass)&&current.role_based_upload_bypass.includes("broadcaster"))return "trusted_uploader_policy";
  if(current.uploader_is_recent_moderator===true&&Array.isArray(current.role_based_upload_bypass)&&current.role_based_upload_bypass.includes("moderator"))return "trusted_uploader_policy";
  return null;
}
