import { afterEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { pool } from "./database";

let createdPool: ReturnType<typeof pool> | undefined;

afterEach(async () => {
  await createdPool?.end();
  createdPool = undefined;
  globalThis.__sloptogetherPool = undefined;
  vi.unstubAllEnvs();
});

it("rejects the shared Clips.gg database unless explicitly opted in", () => {
  vi.stubEnv("DATABASE_URL", "postgresql://sloptogether_app@db.lkyaaokrpbqucjrnhrps.supabase.co/postgres");
  vi.stubEnv("SLOPTOGETHER_USE_CLIPSGG_DATABASE", "false");
  expect(() => pool()).toThrow(/schema-scoped sloptogether_app login/);
});

it("rejects a shared-project superuser even when shared mode is enabled", () => {
  vi.stubEnv("DATABASE_URL", "postgresql://postgres@db.lkyaaokrpbqucjrnhrps.supabase.co/postgres");
  vi.stubEnv("SLOPTOGETHER_USE_CLIPSGG_DATABASE", "true");
  expect(() => pool()).toThrow(/schema-scoped sloptogether_app login/);
});

it("accepts the shared Clips.gg database only with the explicit opt-in and scoped login", () => {
  vi.stubEnv("DATABASE_URL", "postgresql://sloptogether_app@db.lkyaaokrpbqucjrnhrps.supabase.co/postgres");
  vi.stubEnv("SLOPTOGETHER_USE_CLIPSGG_DATABASE", "true");
  createdPool = pool();
  expect(createdPool).toBeTruthy();
});
