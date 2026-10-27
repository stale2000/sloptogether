import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertBitsLocalServer,assertBitsScratchDatabase } from "./bits-local-db-guard.mjs";

const server={databaseName:"sloptogether",dataDirectory:"/tmp/sloptogether-pg",serverAddress:"127.0.0.1",serverPort:56432};
const scratch="sloptogether_bits_test_0123456789abcdef",marker="a".repeat(48);

test("permits only the named local test server for database lifecycle operations",()=>{
  assert.doesNotThrow(()=>assertBitsLocalServer(server));
  for(const change of [{databaseName:"postgres"},{dataDirectory:"/var/lib/postgresql/data"},{serverAddress:"10.0.0.2"},{serverPort:5432}])
    assert.throws(()=>assertBitsLocalServer({...server,...change}),/local_demo_database_identity_not_allowed/);
});

test("requires an exact synthetic database and per-run marker",()=>{
  const identity={...server,databaseName:scratch,guardMarker:marker};
  assert.doesNotThrow(()=>assertBitsScratchDatabase(identity,scratch,marker));
  for(const change of [{databaseName:"production"},{guardMarker:"b".repeat(48)},{dataDirectory:"/other"},{serverPort:5432}])
    assert.throws(()=>assertBitsScratchDatabase({...identity,...change},scratch,marker));
  assert.throws(()=>assertBitsScratchDatabase(identity,"sloptogether_bits_test_unchecked",marker));
  assert.throws(()=>assertBitsScratchDatabase(identity,scratch,""));
});

test("runner rejects another port before opening a database connection",()=>{
  const result=spawnSync("bash",[fileURLToPath(new URL("./test-bits-local.sh",import.meta.url))],{
    encoding:"utf8",env:{PATH:process.env.PATH,SLOPTOGETHER_LOCAL_POSTGRES_PORT:"5432"},timeout:5000,
  });
  assert.equal(result.status,1);
  assert.match(result.stderr,/requires the dedicated local PostgreSQL port 56432/);
});
