import test from "node:test";
import assert from "node:assert/strict";
import { assertDatabaseTarget } from "../src/index.mjs";

const sharedHost="db.lkyaaokrpbqucjrnhrps.supabase.co";

test("allows the approved Clips.gg project only with the scoped login and opt-in",()=>{
  const url=`postgresql://sloptogether_app@${sharedHost}/postgres?sslmode=require`;
  assert.equal(assertDatabaseTarget(url,{SLOPTOGETHER_USE_CLIPSGG_DATABASE:"true"}).username,"sloptogether_app");
  assert.throws(()=>assertDatabaseTarget(url,{}),/schema-scoped sloptogether_app/);
  assert.throws(()=>assertDatabaseTarget(`postgresql://postgres@${sharedHost}/postgres?sslmode=require`,{SLOPTOGETHER_USE_CLIPSGG_DATABASE:"true"}),/schema-scoped sloptogether_app/);
});

test("continues to accept the local demo database",()=>{
  assert.equal(assertDatabaseTarget("postgresql://postgres@127.0.0.1:56432/sloptogether",{}).hostname,"127.0.0.1");
});
