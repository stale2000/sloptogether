BEGIN;

-- Migration 018 creates this schema-scoped role without login capability.
-- Enable connections while preserving its restricted privilege boundary.
ALTER ROLE sloptogether_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

COMMIT;
