import "server-only";

import { interruptSettingsSchema } from "@sloptogether/contracts";
import type { PoolClient } from "pg";

// These settings do not change who can contribute, review, or bypass review.
export const nonAuthoritySettings = new Set([
  "story_world_prompt", "h3_style_profile", "owner_budget_cap_usd",
  "chat_voting_enabled", "preair_upscale_enabled", "preair_upscale_wait_seconds",
]);
const nonAuthorityPatchFields = new Set([
  "storyWorldPrompt", "h3StyleProfile", "ownerBudgetCapUsd", "chatVotingEnabled",
  "preairUpscaleEnabled", "preairUpscaleWaitSeconds",
]);

export function isSafeTrustedPolicyAudit(action:string,state:unknown):boolean {
  if(action==="subscriber_interrupt.settings")return interruptSettingsSchema.safeParse(state).success;
  if(action!=="channel.settings.update"||!state||typeof state!=="object"||Array.isArray(state))return false;
  const fields=Object.keys(state);
  return fields.length>0&&fields.every(field=>nonAuthorityPatchFields.has(field));
}

/** Called only while the channel row is locked in the settings transaction. */
export async function carryForwardTrustedExecutions(client:PoolClient,channelId:string,newPolicyRevision:number):Promise<void>{
  // Advance only grants that matched the immediately preceding policy. A
  // stale, revoked, expired, mismatched or banned grant cannot be revived.
  await client.query(`UPDATE sloptogether.trusted_executions te SET policy_revision=$2
    FROM sloptogether.application_keys k
    WHERE te.twitch_channel_id=$1 AND te.policy_revision=$2-1 AND te.revoked_at IS NULL
      AND k.key_id=te.key_id AND k.twitch_channel_id=te.twitch_channel_id
      AND k.issuing_twitch_user_id=te.issuer_twitch_user_id
      AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())
      AND CASE te.execution_role WHEN 'generation' THEN 'worker:generation'
        WHEN 'upscale' THEN 'worker:upscale' WHEN 'story_producer' THEN 'story:write_future'
        WHEN 'streamer_control' THEN 'streamer:control' END=ANY(k.scopes)
      AND NOT EXISTS (SELECT 1 FROM sloptogether.bans b WHERE b.twitch_user_id=te.issuer_twitch_user_id
        AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>now())
        AND (b.scope='global' OR b.twitch_channel_id=te.twitch_channel_id))`,[channelId,newPolicyRevision]);
}
