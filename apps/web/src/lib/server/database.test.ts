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

it("accepts the IPv4 transaction pooler only with the project-scoped app login", () => {
  vi.stubEnv("DATABASE_URL", "postgresql://sloptogether_app.lkyaaokrpbqucjrnhrps@aws-1-us-east-2.pooler.supabase.com:6543/postgres");
  vi.stubEnv("SLOPTOGETHER_USE_CLIPSGG_DATABASE", "true");
  createdPool = pool();
  expect(createdPool).toBeTruthy();
});

it("rejects an unscoped pooler role even when shared mode is enabled", () => {
  vi.stubEnv("DATABASE_URL", "postgresql://postgres.lkyaaokrpbqucjrnhrps@aws-1-us-east-2.pooler.supabase.com:6543/postgres");
  vi.stubEnv("SLOPTOGETHER_USE_CLIPSGG_DATABASE", "true");
  expect(() => pool()).toThrow(/schema-scoped sloptogether_app login/);
});

it("uses the Supabase CA and removes conflicting sslmode settings for verified pooler TLS",()=>{
  const ca="-----BEGIN CERTIFICATE-----\nproduction-ca\n-----END CERTIFICATE-----";
  vi.stubEnv("DATABASE_URL","postgresql://sloptogether_app.lkyaaokrpbqucjrnhrps@aws-1-us-east-2.pooler.supabase.com:6543/postgres?sslmode=require");
  vi.stubEnv("SLOPTOGETHER_USE_CLIPSGG_DATABASE","true");
  vi.stubEnv("SLOPTOGETHER_DATABASE_SSL_CA",ca);
  createdPool=pool();
  const options=(createdPool as unknown as {options:{connectionString:string;ssl:{ca:string;rejectUnauthorized:boolean}}}).options;
  expect(new URL(options.connectionString).searchParams.has("sslmode")).toBe(false);
  expect(options.ssl).toEqual({ca,rejectUnauthorized:true});
});

it("normalizes the escaped newlines used by Vercel certificate environment variables",()=>{
  const ca="-----BEGIN CERTIFICATE-----\nproduction-ca\n-----END CERTIFICATE-----";
  vi.stubEnv("DATABASE_URL","postgresql://sloptogether_app.lkyaaokrpbqucjrnhrps@aws-1-us-east-2.pooler.supabase.com:6543/postgres");
  vi.stubEnv("SLOPTOGETHER_USE_CLIPSGG_DATABASE","true");
  vi.stubEnv("SLOPTOGETHER_DATABASE_SSL_CA",ca.replace(/\n/g,"\\n"));
  createdPool=pool();
  const options=(createdPool as unknown as {options:{ssl:{ca:string}}}).options;
  expect(options.ssl.ca).toBe(ca);
});

it("requires verified CA configuration for the shared database in production",()=>{
  vi.stubEnv("NODE_ENV","production");
  vi.stubEnv("DATABASE_URL","postgresql://sloptogether_app.lkyaaokrpbqucjrnhrps@aws-1-us-east-2.pooler.supabase.com:6543/postgres");
  vi.stubEnv("SLOPTOGETHER_USE_CLIPSGG_DATABASE","true");
  vi.stubEnv("SLOPTOGETHER_DATABASE_SSL_CA","");
  expect(()=>pool()).toThrow(/required for verified Clips.gg database TLS/);
});
