import { createHash } from "node:crypto";
import { z } from "zod";
import { findChannel, isBanned, requireContentReviewer } from "./channels";
import { transaction } from "./db";
import { ApiError, assertSameOrigin, readJson } from "./http";
import { inputAsset, screenPromptAndImages } from "./preflight";
import { requestPrincipal } from "./principals";
import { getStream } from "./stream-service";

const input = z.object({assetId:z.string().uuid(),prompt:z.string().trim().min(1).max(1000)}).strict();

/** Explicit reviewer action: add an image to a stream without creating a render. */
export async function addStreamSeedFrame(locator:string, request:Request, streamSlug:string) {
  assertSameOrigin(request);
  const channel=await findChannel(locator);
  const principal=await requestPrincipal(request);
  if(!principal)throw new ApiError(401,"login_required");
  if(principal.kind!=="session")throw new ApiError(403,"reviewer_session_required");
  const actor=await requireContentReviewer(channel,principal);
  const stream=await getStream(channel.twitch_channel_id,streamSlug);
  const body=await readJson(request,input);
  const image=await inputAsset(channel.twitch_channel_id,body.assetId,actor);
  const screen=await screenPromptAndImages({channelId:channel.twitch_channel_id,prompt:body.prompt,images:[image]});
  if(screen.decision!=="clear")throw new ApiError(409,"input_screen_not_clear");
  const digest=createHash("sha256").update(image.bytes).digest();
  return transaction(async client=>{
    const locked=await client.query<{policy_revision:number}>("SELECT policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[channel.twitch_channel_id]);
    if(!locked.rows[0]||locked.rows[0].policy_revision!==channel.policy_revision)throw new ApiError(409,"channel_policy_changed");
    if(await isBanned(channel.twitch_channel_id,actor,client))throw new ApiError(403,"channel_ban_active");
    const asset=await client.query<{id:string}>(`SELECT id FROM sloptogether.assets WHERE id=$1 AND twitch_channel_id=$2
      AND uploaded_by_twitch_user_id=$3 AND media_kind='image' AND status IN ('quarantine','validated','approved') AND sha256=$4 FOR UPDATE`,[body.assetId,channel.twitch_channel_id,actor,digest]);
    if(!asset.rowCount)throw new ApiError(409,"image_asset_changed");
    const evidence=await client.query<{id:string}>(`SELECT id FROM sloptogether.input_screens WHERE twitch_channel_id=$1
      AND input_sha256=$2 AND effective_state='clear' AND expires_at>now() ORDER BY created_at DESC LIMIT 1`,[channel.twitch_channel_id,Buffer.from(screen.digest,"hex")]);
    if(!evidence.rows[0])throw new ApiError(409,"input_screen_missing");
    const boundary=await client.query<{id:string}>(`INSERT INTO sloptogether.boundary_revisions(twitch_channel_id,asset_id,created_by,moderation_evidence_id)
      VALUES($1,$2,$3,$4) RETURNING id`,[channel.twitch_channel_id,body.assetId,actor,evidence.rows[0].id]);
    await client.query("UPDATE sloptogether.assets SET status='approved' WHERE id=$1 AND status IN ('quarantine','validated')",[body.assetId]);
    await client.query("INSERT INTO sloptogether.stream_seed_frames(stream_id,boundary_revision_id,twitch_channel_id,created_by) VALUES($1,$2,$3,$4)",[stream.id,boundary.rows[0]!.id,channel.twitch_channel_id,actor]);
    await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state)
      VALUES($1,$2,'stream.seed_frame.added','boundary_revision',$3,$4::jsonb)`,[channel.twitch_channel_id,actor,boundary.rows[0]!.id,JSON.stringify({streamId:stream.id,assetId:body.assetId})]);
    return {boundaryRevisionId:boundary.rows[0]!.id,assetId:body.assetId};
  });
}
