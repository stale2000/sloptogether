-- These trigger functions use schema-qualified table references, so an empty
-- search_path preserves their behavior while preventing name resolution from
-- depending on session-controlled schemas.
ALTER FUNCTION sloptogether.initialize_channel_stream() SET search_path = '';
ALTER FUNCTION sloptogether.assign_stream_context() SET search_path = '';
