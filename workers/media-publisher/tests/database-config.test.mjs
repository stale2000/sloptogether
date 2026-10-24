import test from "node:test";
import assert from "node:assert/strict";
import { assertDatabaseTarget,databasePoolOptions } from "../src/index.mjs";

const sharedHost="db.lkyaaokrpbqucjrnhrps.supabase.co";

test("allows the approved Clips.gg project only with the scoped login and opt-in",()=>{
  const url=`postgresql://sloptogether_app@${sharedHost}/postgres?sslmode=require`;
  assert.equal(assertDatabaseTarget(url,{SLOPTOGETHER_USE_CLIPSGG_DATABASE:"true"}).username,"sloptogether_app");
  assert.throws(()=>assertDatabaseTarget(url,{}),/schema-scoped sloptogether_app/);
  assert.throws(()=>assertDatabaseTarget(`postgresql://postgres@${sharedHost}/postgres?sslmode=require`,{SLOPTOGETHER_USE_CLIPSGG_DATABASE:"true"}),/schema-scoped sloptogether_app/);
});

test("allows the Clips.gg IPv4 transaction pooler only with the project-scoped app login",()=>{
  const url="postgresql://sloptogether_app.lkyaaokrpbqucjrnhrps@aws-1-us-east-2.pooler.supabase.com:6543/postgres?sslmode=require";
  assert.equal(assertDatabaseTarget(url,{SLOPTOGETHER_USE_CLIPSGG_DATABASE:"true"}).username,"sloptogether_app.lkyaaokrpbqucjrnhrps");
  assert.throws(()=>assertDatabaseTarget(url,{}),/schema-scoped sloptogether_app/);
  assert.throws(()=>assertDatabaseTarget("postgresql://postgres.lkyaaokrpbqucjrnhrps@aws-1-us-east-2.pooler.supabase.com:6543/postgres?sslmode=require",{SLOPTOGETHER_USE_CLIPSGG_DATABASE:"true"}),/schema-scoped sloptogether_app/);
});

test("continues to accept the local demo database",()=>{
  assert.equal(assertDatabaseTarget("postgresql://postgres@127.0.0.1:56432/sloptogether",{}).hostname,"127.0.0.1");
});

test("uses verified CA TLS for the shared pooler and rejects missing CA configuration",()=>{
  const url="postgresql://sloptogether_app.lkyaaokrpbqucjrnhrps@aws-1-us-east-2.pooler.supabase.com:6543/postgres?sslmode=require";
  const ca="-----BEGIN CERTIFICATE-----\nproduction-ca\n-----END CERTIFICATE-----";
  const options=databasePoolOptions(url,{SLOPTOGETHER_USE_CLIPSGG_DATABASE:"true",SLOPTOGETHER_DATABASE_SSL_CA:ca});
  assert.equal(new URL(options.connectionString).searchParams.has("sslmode"),false);
  assert.deepEqual(options.ssl,{ca,rejectUnauthorized:true});
  assert.throws(()=>databasePoolOptions(url,{SLOPTOGETHER_USE_CLIPSGG_DATABASE:"true"}),/SSL_CA_required/);
});
