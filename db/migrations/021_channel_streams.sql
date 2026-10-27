BEGIN;

-- A Twitch channel may own multiple independent SlopTogether programs.
-- Channel policy and identity remain shared; each stream gets its own story
-- branch, published program, playhead, and producer lease.
CREATE TABLE sloptogether.streams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  is_default boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (twitch_channel_id,slug)
);
CREATE UNIQUE INDEX one_default_stream_per_channel ON sloptogether.streams(twitch_channel_id) WHERE is_default;

INSERT INTO sloptogether.streams(twitch_channel_id,slug,display_name,is_default,created_by)
SELECT twitch_channel_id,'main','Main stream',true,owner_twitch_user_id FROM sloptogether.channels;

ALTER TABLE sloptogether.branches ADD COLUMN stream_id uuid REFERENCES sloptogether.streams(id) ON DELETE CASCADE;
UPDATE sloptogether.branches b SET stream_id=s.id
FROM sloptogether.streams s WHERE s.twitch_channel_id=b.twitch_channel_id AND s.is_default;
ALTER TABLE sloptogether.branches ALTER COLUMN stream_id SET NOT NULL;
DROP INDEX sloptogether.one_selected_branch_per_channel;
CREATE UNIQUE INDEX one_selected_branch_per_stream ON sloptogether.branches(stream_id) WHERE is_selected AND archived_at IS NULL;
CREATE INDEX branches_by_stream ON sloptogether.branches(stream_id,created_at) WHERE archived_at IS NULL;

CREATE FUNCTION sloptogether.initialize_channel_stream() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stream_key uuid; branch_key uuid;
BEGIN
  INSERT INTO sloptogether.streams(twitch_channel_id,slug,display_name,is_default,created_by)
    VALUES(NEW.twitch_channel_id,'main','Main stream',true,NEW.owner_twitch_user_id) RETURNING id INTO stream_key;
  INSERT INTO sloptogether.branches(twitch_channel_id,stream_id,name,is_selected,created_by)
    VALUES(NEW.twitch_channel_id,stream_key,'Main story',true,NEW.owner_twitch_user_id) RETURNING id INTO branch_key;
  INSERT INTO sloptogether.segments(twitch_channel_id,branch_id,ordinal,state) VALUES(NEW.twitch_channel_id,branch_key,0,'open');
  INSERT INTO sloptogether.playback_sessions(twitch_channel_id,stream_id) VALUES(NEW.twitch_channel_id,stream_key);
  INSERT INTO sloptogether.program_manifests(twitch_channel_id,stream_id,program_epoch,manifest_revision) VALUES(NEW.twitch_channel_id,stream_key,1,0);
  RETURN NEW;
END $$;
CREATE TRIGGER initialize_channel_stream AFTER INSERT ON sloptogether.channels
FOR EACH ROW EXECUTE FUNCTION sloptogether.initialize_channel_stream();

ALTER TABLE sloptogether.interrupt_requests ADD COLUMN stream_id uuid REFERENCES sloptogether.streams(id);
UPDATE sloptogether.interrupt_requests ir SET stream_id=s.id
FROM sloptogether.streams s WHERE s.twitch_channel_id=ir.broadcaster_twitch_id AND s.is_default;
ALTER TABLE sloptogether.interrupt_requests ALTER COLUMN stream_id SET NOT NULL;

ALTER TABLE sloptogether.program_items ADD COLUMN stream_id uuid REFERENCES sloptogether.streams(id);
UPDATE sloptogether.program_items pi SET stream_id=coalesce(
  (SELECT b.stream_id FROM sloptogether.segments seg JOIN sloptogether.branches b ON b.id=seg.branch_id WHERE seg.id=pi.segment_id),
  (SELECT s.id FROM sloptogether.streams s WHERE s.twitch_channel_id=pi.twitch_channel_id AND s.is_default)
);
ALTER TABLE sloptogether.program_items ALTER COLUMN stream_id SET NOT NULL;
DROP INDEX sloptogether.program_order_per_epoch;
CREATE UNIQUE INDEX program_order_per_stream_epoch ON sloptogether.program_items(stream_id,program_epoch,item_order);
CREATE INDEX program_items_stream_order ON sloptogether.program_items(stream_id,program_epoch,item_order) WHERE committed_at IS NOT NULL;

ALTER TABLE sloptogether.program_manifests ADD COLUMN stream_id uuid REFERENCES sloptogether.streams(id);
UPDATE sloptogether.program_manifests pm SET stream_id=s.id
FROM sloptogether.streams s WHERE s.twitch_channel_id=pm.twitch_channel_id AND s.is_default;
ALTER TABLE sloptogether.program_manifests ALTER COLUMN stream_id SET NOT NULL;
ALTER TABLE sloptogether.program_manifests DROP CONSTRAINT program_manifests_pkey;
ALTER TABLE sloptogether.program_manifests ADD CONSTRAINT program_manifests_pkey PRIMARY KEY(stream_id,program_epoch);

ALTER TABLE sloptogether.playback_sessions ADD COLUMN stream_id uuid REFERENCES sloptogether.streams(id);
UPDATE sloptogether.playback_sessions ps SET stream_id=s.id
FROM sloptogether.streams s WHERE s.twitch_channel_id=ps.twitch_channel_id AND s.is_default;
ALTER TABLE sloptogether.playback_sessions ALTER COLUMN stream_id SET NOT NULL;
ALTER TABLE sloptogether.playback_sessions DROP CONSTRAINT playback_sessions_twitch_channel_id_key;
ALTER TABLE sloptogether.playback_sessions ADD CONSTRAINT playback_sessions_stream_id_key UNIQUE(stream_id);

ALTER TABLE sloptogether.jobs ADD COLUMN stream_id uuid REFERENCES sloptogether.streams(id);
UPDATE sloptogether.jobs j SET stream_id=coalesce(
  (SELECT b.stream_id FROM sloptogether.segment_revisions sr JOIN sloptogether.segments seg ON seg.id=sr.segment_id JOIN sloptogether.branches b ON b.id=seg.branch_id WHERE sr.id=j.segment_revision_id),
  (SELECT ir.stream_id FROM sloptogether.interrupt_requests ir WHERE ir.id=j.interrupt_id),
  (SELECT s.id FROM sloptogether.streams s WHERE s.twitch_channel_id=j.twitch_channel_id AND s.is_default)
);
ALTER TABLE sloptogether.jobs ALTER COLUMN stream_id SET NOT NULL;
CREATE INDEX ready_jobs_by_stream ON sloptogether.jobs(stream_id,stage,priority DESC,created_at) WHERE state='ready';

ALTER TABLE sloptogether.story_producers ADD COLUMN stream_id uuid REFERENCES sloptogether.streams(id);
UPDATE sloptogether.story_producers sp SET stream_id=s.id
FROM sloptogether.streams s WHERE s.twitch_channel_id=sp.twitch_channel_id AND s.is_default;
ALTER TABLE sloptogether.story_producers ALTER COLUMN stream_id SET NOT NULL;
DROP INDEX sloptogether.one_active_story_producer_per_channel;
CREATE UNIQUE INDEX one_active_story_producer_per_stream ON sloptogether.story_producers(stream_id) WHERE released_at IS NULL;

ALTER TABLE sloptogether.story_plan_attempts ADD COLUMN stream_id uuid REFERENCES sloptogether.streams(id);
UPDATE sloptogether.story_plan_attempts a SET stream_id=s.id
FROM sloptogether.streams s WHERE s.twitch_channel_id=a.twitch_channel_id AND s.is_default;
ALTER TABLE sloptogether.story_plan_attempts ALTER COLUMN stream_id SET NOT NULL;

CREATE FUNCTION sloptogether.assign_stream_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stream_id IS NULL THEN
    IF TG_TABLE_NAME='interrupt_requests' THEN
      SELECT id INTO NEW.stream_id FROM sloptogether.streams WHERE twitch_channel_id=NEW.broadcaster_twitch_id AND is_default;
    ELSIF TG_TABLE_NAME='jobs' AND NEW.segment_revision_id IS NOT NULL THEN
      SELECT b.stream_id INTO NEW.stream_id FROM sloptogether.segment_revisions sr
        JOIN sloptogether.segments seg ON seg.id=sr.segment_id JOIN sloptogether.branches b ON b.id=seg.branch_id
        WHERE sr.id=NEW.segment_revision_id;
    ELSIF TG_TABLE_NAME='jobs' AND NEW.interrupt_id IS NOT NULL THEN
      SELECT stream_id INTO NEW.stream_id FROM sloptogether.interrupt_requests WHERE id=NEW.interrupt_id;
    ELSIF TG_TABLE_NAME='story_plan_attempts' THEN
      SELECT stream_id INTO NEW.stream_id FROM sloptogether.story_producers WHERE id=NEW.producer_id;
    END IF;
    IF NEW.stream_id IS NULL AND TG_TABLE_NAME<>'interrupt_requests' THEN
      SELECT id INTO NEW.stream_id FROM sloptogether.streams WHERE twitch_channel_id=NEW.twitch_channel_id AND is_default;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assign_job_stream BEFORE INSERT ON sloptogether.jobs
FOR EACH ROW EXECUTE FUNCTION sloptogether.assign_stream_context();
CREATE TRIGGER assign_story_producer_stream BEFORE INSERT ON sloptogether.story_producers
FOR EACH ROW EXECUTE FUNCTION sloptogether.assign_stream_context();
CREATE TRIGGER assign_story_plan_stream BEFORE INSERT ON sloptogether.story_plan_attempts
FOR EACH ROW EXECUTE FUNCTION sloptogether.assign_stream_context();
CREATE TRIGGER assign_interrupt_stream BEFORE INSERT ON sloptogether.interrupt_requests
FOR EACH ROW EXECUTE FUNCTION sloptogether.assign_stream_context();

REVOKE ALL ON sloptogether.streams FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON sloptogether.streams TO service_role;
  END IF;
END;
$$;

COMMIT;
