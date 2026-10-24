import test from "node:test";
import assert from "node:assert/strict";
import { assertLocalDemoDatabase,assertLocalDemoEnvironment } from "./local-demo-guard.mjs";

const services={
  nodeEnv:"development",
  databaseUrl:"postgresql://postgres@127.0.0.1:56432/sloptogether",
  storageUrl:"http://127.0.0.1:9000",
  publicUrl:"http://localhost:3000",
};

test("accepts the documented isolated local services",()=>{
  assert.doesNotThrow(()=>assertLocalDemoEnvironment(services));
});

test("rejects production and forwarded or nonstandard service endpoints",()=>{
  for(const override of [
    {nodeEnv:"production"},
    {databaseUrl:"postgresql://postgres@127.0.0.1:5432/postgres"},
    {databaseUrl:"postgresql://postgres@127.0.0.1:56432/production"},
    {storageUrl:"http://127.0.0.1:9001"},
    {publicUrl:"http://127.0.0.1:3000"},
  ])assert.throws(()=>assertLocalDemoEnvironment({...services,...override}));
});

test("requires the expected local Postgres server identity before seeding",()=>{
  const local={databaseName:"sloptogether",dataDirectory:"/tmp/sloptogether-pg",serverAddress:"127.0.0.1",serverPort:56432};
  assert.doesNotThrow(()=>assertLocalDemoDatabase(local));
  assert.doesNotThrow(()=>assertLocalDemoDatabase({database_name:"sloptogether",data_directory:"/tmp/sloptogether-pg",server_address:"127.0.0.1",server_port:56432}));
  for(const override of [
    {dataDirectory:"/var/lib/postgresql/data"},
    {serverAddress:"10.0.0.8"},
    {serverAddress:"203.0.113.5"},
    {serverPort:5432},
    {databaseName:"production"},
  ])assert.throws(()=>assertLocalDemoDatabase({...local,...override}),/local_demo_database_identity_not_allowed/);
});
