BEGIN;

ALTER TABLE sloptogether.channels
  ADD COLUMN preair_upscale_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN preair_upscale_wait_seconds integer NOT NULL DEFAULT 1200
    CHECK (preair_upscale_wait_seconds BETWEEN 60 AND 3600);

CREATE TABLE sloptogether.preair_upscale_requests (
  base_asset_id uuid PRIMARY KEY REFERENCES sloptogether.assets(id),
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id),
  segment_revision_id uuid NOT NULL REFERENCES sloptogether.segment_revisions(id),
  base_sha256 bytea NOT NULL CHECK (octet_length(base_sha256)=32),
  upscale_job_id uuid NOT NULL UNIQUE REFERENCES sloptogether.jobs(id),
  deadline_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','selected','fallback')),
  selected_asset_id uuid REFERENCES sloptogether.assets(id),
  fallback_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK ((state='selected') = (selected_asset_id IS NOT NULL)),
  CHECK ((state='pending') = (resolved_at IS NULL))
);

REVOKE ALL ON sloptogether.preair_upscale_requests FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sloptogether_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON sloptogether.preair_upscale_requests TO sloptogether_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON sloptogether.preair_upscale_requests TO service_role;
  END IF;
END $$;

-- Called only after the exact base asset has been approved, in the same
-- transaction as its publication event. Lock in the same channel/segment
-- order as moderation and publication.
CREATE FUNCTION sloptogether.schedule_preair_upscale(p_asset_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, sloptogether AS $$
DECLARE
  source record;
  target_width integer;
  target_height integer;
  recipe text;
  recipe_hash text;
  new_job uuid;
  new_attempt uuid;
  deadline timestamptz;
BEGIN
  SELECT c.twitch_channel_id,c.owner_twitch_user_id,c.preair_upscale_wait_seconds,
    a.id AS asset_id,a.sha256,a.width,a.height,j.segment_revision_id,i.id AS screen_id,i.expires_at
  INTO source
  FROM sloptogether.assets a
  JOIN sloptogether.job_attempts ja ON ja.output_asset_id=a.id AND ja.state='succeeded'
  JOIN sloptogether.jobs j ON j.id=ja.job_id AND j.stage='video_base' AND j.state='succeeded' AND j.interrupt_id IS NULL
  JOIN sloptogether.segment_revisions r ON r.id=j.segment_revision_id AND r.planning_mode='continuation'
  JOIN sloptogether.segments s ON s.id=r.segment_id AND s.selected_revision_id=r.id
  JOIN sloptogether.branches b ON b.id=s.branch_id AND b.twitch_channel_id=s.twitch_channel_id AND b.is_selected AND b.archived_at IS NULL
  JOIN sloptogether.channels c ON c.twitch_channel_id=a.twitch_channel_id AND c.twitch_channel_id=j.twitch_channel_id AND c.twitch_channel_id=s.twitch_channel_id
  JOIN LATERAL (SELECT aa.input_screen_id,aa.decision FROM sloptogether.artifact_approvals aa
    WHERE aa.asset_id=a.id AND aa.sha256=a.sha256 ORDER BY aa.created_at DESC,aa.id DESC LIMIT 1) approval ON approval.decision='approved'
  JOIN sloptogether.input_screens i ON i.id=approval.input_screen_id AND i.twitch_channel_id=c.twitch_channel_id
  WHERE a.id=p_asset_id AND a.status='approved' AND a.media_kind='video' AND a.content_type='video/mp4' AND a.sha256 IS NOT NULL
    AND c.is_enabled AND c.visibility<>'private' AND c.preair_upscale_enabled AND i.effective_state='clear'
    AND r.input_sha256=j.input_sha256
    AND i.id=coalesce(NULLIF(j.planning_payload->>'inputScreenId','')::uuid,
      (SELECT p.input_screen_id FROM sloptogether.proposals p WHERE p.segment_revision_id=j.segment_revision_id AND p.input_screen_id IS NOT NULL ORDER BY p.created_at DESC LIMIT 1),
      (SELECT sp.screen_id FROM sloptogether.story_plan_attempts sp JOIN sloptogether.segment_revisions rs ON rs.segment_id=sp.resulting_segment_id
        WHERE rs.id=j.segment_revision_id AND sp.screen_id IS NOT NULL ORDER BY sp.created_at DESC LIMIT 1))
    AND (i.expires_at IS NULL OR i.expires_at>now()) AND s.state NOT IN ('played','retired')
    AND NOT EXISTS (SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM sloptogether.bans b WHERE b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>now())
      AND (b.scope='global' OR b.twitch_channel_id=c.twitch_channel_id)
      AND b.twitch_user_id IN (j.requested_by,coalesce(a.uploaded_by_twitch_user_id,'')))
  FOR UPDATE OF c,s,b,a,j,ja,i;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM sloptogether.preair_upscale_requests WHERE base_asset_id=p_asset_id) THEN RETURN NULL; END IF;
  IF source.width IS NULL OR source.height IS NULL OR source.width<1 OR source.height<1
     OR source.width*9<>source.height*16 OR source.width>=1920 OR source.height>=1080 THEN RETURN NULL; END IF;
  IF source.width<=512 AND source.height<=288 THEN
    target_width:=1184; target_height:=666;
    recipe:='sol-h3-upscale-pruna-fast-1184-v1';
    recipe_hash:='8bd316e466037db6e4ec4e9b0b3c6b010274020df16c1609e788bb97b8fd6848';
  ELSE
    target_width:=1920; target_height:=1080;
    recipe:='sol-h3-upscale-pruna-fast';
    recipe_hash:='e0b4949fbbc02e31b0dc697fc2bedc5a7a1efe57d5d96fe908013d89a3bf8b8c';
  END IF;
  deadline:=now()+source.preair_upscale_wait_seconds*interval '1 second';
  IF source.expires_at IS NOT NULL THEN deadline:=least(deadline,source.expires_at); END IF;
  IF deadline<=now()+interval '30 seconds' THEN RETURN NULL; END IF;
  new_job:=gen_random_uuid(); new_attempt:=gen_random_uuid();
  INSERT INTO sloptogether.jobs(id,twitch_channel_id,segment_revision_id,stage,execution_mode,state,recipe_id,recipe_sha256,input_sha256,requested_by,parent_asset_id,planning_payload,result_deadline_at)
    VALUES(new_job,source.twitch_channel_id,source.segment_revision_id,'video_upscale','pull_worker','ready',recipe,decode(recipe_hash,'hex'),source.sha256,source.owner_twitch_user_id,source.asset_id,
      jsonb_build_object('inputScreenId',source.screen_id,'outputWidth',target_width,'outputHeight',target_height),deadline);
  INSERT INTO sloptogether.job_attempts(id,job_id,attempt_number,fence,client_idempotency_key,state,attempt_deadline_at,input_sha256)
    VALUES(new_attempt,new_job,1,1,'job:'||new_job::text||':attempt:1','ready',deadline,source.sha256);
  INSERT INTO sloptogether.preair_upscale_requests(base_asset_id,twitch_channel_id,segment_revision_id,base_sha256,upscale_job_id,deadline_at)
    VALUES(source.asset_id,source.twitch_channel_id,source.segment_revision_id,source.sha256,new_job,deadline);
  INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state)
    VALUES(source.twitch_channel_id,source.owner_twitch_user_id,'upscale.preair_scheduled','asset',source.asset_id::text,
      jsonb_build_object('jobId',new_job,'deadlineAt',deadline,'recipeId',recipe));
  RETURN new_job;
END;
$$;

REVOKE ALL ON FUNCTION sloptogether.schedule_preair_upscale(uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sloptogether_app') THEN
    GRANT EXECUTE ON FUNCTION sloptogether.schedule_preair_upscale(uuid) TO sloptogether_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT EXECUTE ON FUNCTION sloptogether.schedule_preair_upscale(uuid) TO service_role;
  END IF;
END $$;

COMMIT;
