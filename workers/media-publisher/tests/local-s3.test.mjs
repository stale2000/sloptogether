import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalS3Server } from "../../../scripts/local-s3.mjs";

test("local S3 accepts bounded loopback object put, range read, copy and delete",async()=>{
  const root=await mkdtemp(join(tmpdir(),"slop-local-s3-test-"));
  const server=await createLocalS3Server({root,port:0,allowedOrigin:"http://localhost:3000",maxBytes:1024});
  const address=server.address();assert(address&&typeof address!=="string");const origin=`http://127.0.0.1:${address.port}`;
  try{
    const preflight=await fetch(`${origin}/`,{method:"OPTIONS",headers:{Origin:"http://localhost:3000"}});
    assert.equal(preflight.status,204);assert.equal(preflight.headers.get("x-sloptogether-local-store"),"loopback-v1");
    assert.equal((await fetch(`${origin}/test-bucket`,{method:"PUT"})).status,200);
    assert.equal((await fetch(`${origin}/test-bucket/incoming/test/frame.mp4`,{method:"PUT",headers:{"Content-Type":"video/mp4"},body:Buffer.from("0123456789")})).status,200);
    const partial=await fetch(`${origin}/test-bucket/incoming/test/frame.mp4`,{headers:{Range:"bytes=2-5"}});
    assert.equal(partial.status,206);assert.equal(await partial.text(),"2345");
    assert.equal((await fetch(`${origin}/test-bucket/private/final.mp4`,{method:"PUT",headers:{"x-amz-copy-source":"/test-bucket/incoming/test/frame.mp4"}})).status,200);
    assert.equal(await (await fetch(`${origin}/test-bucket/private/final.mp4`)).text(),"0123456789");
    assert.equal((await fetch(`${origin}/test-bucket/private/final.mp4`,{method:"DELETE"})).status,204);
    assert.equal((await fetch(`${origin}/test-bucket/%2e%2e/etc/passwd`)).status,404);
    assert.equal((await fetch(`${origin}/test-bucket/incoming/test/frame.mp4`,{headers:{Origin:"https://attacker.example"}})).status,403);
    assert.equal((await readFile(join(root,"test-bucket/incoming/test/frame.mp4.content-type"),"utf8")),"video/mp4");
  }finally{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});
