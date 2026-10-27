BEGIN;

-- The publisher needs the same schema-only table access as the web runtime but
-- must use its own login so its credential can be stored only on the publisher.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sloptogether_publisher') THEN
    CREATE ROLE sloptogether_publisher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$$;

GRANT sloptogether_app TO sloptogether_publisher;

COMMIT;
