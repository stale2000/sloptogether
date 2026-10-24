import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import pg from "pg";
import { assertLocalDemoDatabase, assertLocalDemoEnvironment } from "./local-demo-guard.mjs";

const { Pool } = pg;
const channelId = "900000001";
const prompt = "Continue seamlessly from the previous scene: the same small white maintenance robot stands beside the blue crystal beacon in the moon garden. The beacon lights a path through the garden and the robot points toward a distant moon station, then waves. Keep the same animation style, character proportions and night-blue palette. One gentle continuous camera move, clear action, family friendly, no text or logos. The robot says, ‘On to the next star!’";
const videoPath = process.env.FAL_SMOKE_VIDEO ?? "/tmp/sloptogether-fal-test/fourth-1280x720.mp4";
const startPath = process.env.FAL_SMOKE_START_FRAME ?? "/tmp/sloptogether-fal-test/continuity.png";
const endPath = process.env.FAL_SMOKE_END_FRAME ?? "/tmp/sloptogether-fal-test/fourth-end.png";
const databaseUrl = process.env.DATABASE_URL;
const storageUrl = process.env.SLOPTOGETHER_LOCAL_S3_ENDPOINT;
const publicUrl = process.env.PUBLIC_APP_URL;
assertLocalDemoEnvironment({ nodeEnv: process.env.NODE_ENV, databaseUrl, storageUrl, publicUrl });

const [video, start, end] = await Promise.all([readFile(videoPath), readFile(startPath), readFile(endPath)]);
const sha = (data) => createHash("sha256").update(data).digest();
const startSha = sha(start);
const endSha = sha(end);
const inputScreenId = randomUUID();
const startAssetId = randomUUID();
const endAssetId = randomUUID();
const startBoundaryId = randomUUID();
const endBoundaryId = randomUUID();
const revisionId = randomUUID();
const jobId = randomUUID();
const attemptId = randomUUID();
const screenHash = sha(Buffer.from(JSON.stringify({ prompt, images: [startSha.toString("hex"), endSha.toString("hex")] })));
const revisionHash = sha(Buffer.from(JSON.stringify({ prompt, screen: screenHash.toString("hex"), start: startBoundaryId, end: endBoundaryId, mode: "planned_anchors" })));
const recipeId = "minimax/h3-max-turbo/image-to-video";
const recipeHash = sha(Buffer.from(recipeId));
const secret = process.env.SLOPTOGETHER_OPENAI_MODERATION_KEY;
if (!secret) throw new Error("moderation_key_missing");

const moderate = async (image) => {
  const response = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "omni-moderation-latest", input: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/png;base64,${image.toString("base64")}` } }] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`moderation_failed_${response.status}`);
  const result = (await response.json()).results?.[0];
  if (typeof result?.flagged !== "boolean") throw new Error("moderation_response_invalid");
  if (result.flagged) throw new Error("local_clip_moderation_held");
  return result;
};
const [startModeration, endModeration] = await Promise.all([moderate(start), moderate(end)]);

const pool = new Pool({ connectionString: databaseUrl, max: 1, application_name: "sloptogether-local-fal-continuation" });
const storage = new S3Client({ region: "us-east-1", endpoint: storageUrl, forcePathStyle: true, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
try {
  const identity = await pool.query("SELECT current_database() AS database_name,current_setting('data_directory') AS data_directory,host(inet_server_addr()) AS server_address,inet_server_port() AS server_port");
  assertLocalDemoDatabase(identity.rows[0] ?? {});
  const channel = await pool.query("SELECT owner_twitch_user_id,policy_revision,output_width,output_height FROM sloptogether.channels WHERE twitch_channel_id=$1 AND twitch_login='localdemo' AND is_enabled", [channelId]);
  if (!channel.rowCount || channel.rows[0].owner_twitch_user_id !== channelId) throw new Error("local_demo_channel_invalid");
  if (Number(channel.rows[0].output_width) !== 1280 || Number(channel.rows[0].output_height) !== 720) throw new Error("local_demo_profile_changed");

  const slot = await pool.query(`SELECT id,branch_id,ordinal FROM sloptogether.segments
    WHERE twitch_channel_id=$1 AND ordinal=3 AND state='open' AND selected_revision_id IS NULL AND protected_at IS NULL`, [channelId]);
  const key = await pool.query(`SELECT k.key_id FROM sloptogether.application_keys k JOIN sloptogether.trusted_executions te ON te.key_id=k.key_id
    WHERE k.twitch_channel_id=$1 AND k.display_name='Local Fal smoke worker' AND k.revoked_at IS NULL
      AND k.worker_roles @> ARRAY['generation']::text[] AND k.scopes @> ARRAY['worker:generation','artifact:system_approve']::text[]
      AND te.execution_role='generation' AND te.revoked_at IS NULL LIMIT 1`, [channelId]);
  if (!slot.rowCount || !key.rowCount) throw new Error("local_demo_continuation_inputs_missing");

  const storageKeys = {
    start: `private/${channelId}/images/${startAssetId}/start.png`,
    end: `private/${channelId}/images/${endAssetId}/end.png`,
  };
  await Promise.all([
    storage.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: storageKeys.start, Body: start, ContentLength: start.length, ContentType: "image/png" })),
    storage.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: storageKeys.end, Body: end, ContentLength: end.length, ContentType: "image/png" })),
  ]);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE", [channelId]);
    if (Number(locked.rows[0]?.policy_revision) !== Number(channel.rows[0].policy_revision)) throw new Error("local_demo_policy_changed");
    const currentSlot = await client.query("SELECT id FROM sloptogether.segments WHERE id=$1 AND state='open' AND selected_revision_id IS NULL AND protected_at IS NULL FOR UPDATE", [slot.rows[0].id]);
    if (!currentSlot.rowCount) throw new Error("local_demo_slot_changed");
    const nextRevision = await client.query("SELECT coalesce(max(revision),0)+1 AS revision FROM sloptogether.segment_revisions WHERE segment_id=$1", [slot.rows[0].id]);
    await client.query(`INSERT INTO sloptogether.input_screens(id,twitch_channel_id,input_sha256,prompt_sha256,image_sha256s,moderation_model,moderation_policy_revision,provider_result_id,
      category_flags,applied_input_types,automated_state,effective_state,expires_at)
      VALUES($1,$2,$3,$4,$5,'omni-moderation-latest',1,$6,'{}'::jsonb,'{"prompt":true,"images":true}'::jsonb,'clear','clear',now()+interval '1 day')`,
    [inputScreenId, channelId, screenHash, sha(Buffer.from(prompt)), [startSha.toString("hex"), endSha.toString("hex")], `${startModeration.id ?? ""},${endModeration.id ?? ""}`]);
    await client.query(`INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,byte_size,width,height,status,uploaded_by_twitch_user_id)
      VALUES($1,$2,$3,$4,'image','image/png',$5,1280,720,'approved',$6),($7,$2,$8,$9,'image','image/png',$10,1280,720,'approved',$6)`,
    [startAssetId, channelId, storageKeys.start, startSha, start.length, channelId, endAssetId, storageKeys.end, endSha, end.length]);
    await client.query(`INSERT INTO sloptogether.boundary_revisions(id,twitch_channel_id,asset_id,transformation,created_by,moderation_evidence_id)
      VALUES($1,$2,$3,'{"kind":"fal_stream_continuation_start"}'::jsonb,$4,$5),($6,$2,$7,'{"kind":"fal_stream_continuation_end"}'::jsonb,$4,$5)`,
    [startBoundaryId, channelId, startAssetId, channelId, inputScreenId, endBoundaryId, endAssetId]);
    await client.query(`INSERT INTO sloptogether.segment_revisions(id,segment_id,revision,prompt,visual_prompt,dialogue,start_boundary_revision_id,requested_end_boundary_revision_id,
      planning_mode,provider_recipe_id,input_sha256,requested_by,state)
      VALUES($1,$2,$9,$3,$3,'On to the next star!',$4,$5,'planned_anchors',$6,$7,$8,'selected')`,
    [revisionId, slot.rows[0].id, prompt, startBoundaryId, endBoundaryId, recipeId, revisionHash, channelId, nextRevision.rows[0].revision]);
    await client.query("UPDATE sloptogether.segments SET selected_revision_id=$2,state='rendering',protected_at=now() WHERE id=$1", [slot.rows[0].id, revisionId]);
    await client.query(`UPDATE sloptogether.application_keys SET recipe_ids=array_append(recipe_ids,$2)
      WHERE key_id=$1 AND NOT($2=ANY(recipe_ids))`, [key.rows[0].key_id, recipeId]);
    await client.query(`UPDATE sloptogether.trusted_executions SET recipe_ids=array_append(recipe_ids,$2)
      WHERE key_id=$1 AND NOT($2=ANY(recipe_ids)) AND execution_role='generation'`, [key.rows[0].key_id, recipeId]);
    await client.query(`INSERT INTO sloptogether.jobs(id,twitch_channel_id,segment_revision_id,stage,execution_mode,state,recipe_id,recipe_sha256,input_sha256,
      requested_by,planning_payload,priority,result_deadline_at)
      VALUES($1,$2,$3,'video_base','pull_worker','ready',$4,$5,$6,$7,$8::jsonb,100,now()+interval '1 hour')`,
    [jobId, channelId, revisionId, recipeId, recipeHash, revisionHash, channelId, JSON.stringify({ inputScreenId, startBoundaryRevisionId: startBoundaryId, startFrameAssetId: startAssetId, falRequestId: "01a16f66-7535-77b2-8e1d-d3b2f333bc43", outputWidth: 1280, outputHeight: 720 })]);
    await client.query(`INSERT INTO sloptogether.job_attempts(id,job_id,attempt_number,fence,client_idempotency_key,state,attempt_deadline_at,input_sha256)
      VALUES($1,$2,1,1,$3,'ready',now()+interval '1 hour',$4)`, [attemptId, jobId, `local-fal-continuation:${jobId}`, revisionHash]);
    await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state)
      VALUES($1,$2,'local_demo.fal_continuation','job',$3,$4::jsonb)`, [channelId, channelId, jobId, JSON.stringify({ segmentId: slot.rows[0].id, falRequestId: "01a16f66-7535-77b2-8e1d-d3b2f333bc43", moderation: "clear" })]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }

  console.log(JSON.stringify({ status: "ready_for_local_worker_upload", jobId, segmentId: slot.rows[0].id, falRequestId: "01a16f66-7535-77b2-8e1d-d3b2f333bc43", moderation: "clear", bytes: video.length }));
} finally { await storage.destroy(); await pool.end(); }
