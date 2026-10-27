import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("renders a per-user LaunchAgent that runs the publisher with the private env file",{skip:process.platform!=="darwin"},()=>{
  const installer=fileURLToPath(new URL("../scripts/publisher-launchd.sh",import.meta.url));
  const xml=execFileSync(installer,["render-plist"],{
    encoding:"utf8",
    env:{...process.env,SLOPTOGETHER_PUBLISHER_ENV_FILE:"/tmp/sloptogether-publisher.env"},
  });
  const json=execFileSync("python3",["-c","import json,plistlib,sys;print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))"],{
    input:xml,encoding:"utf8",
  });
  const plist=JSON.parse(json);
  assert.equal(plist.Label,"com.clipsgg.sloptogether.media-publisher");
  assert.equal(plist.KeepAlive,true);
  assert.equal(plist.RunAtLoad,true);
  assert.equal(plist.ProgramArguments[1],"--env-file=/tmp/sloptogether-publisher.env");
  assert.ok(plist.ProgramArguments[2].endsWith("/workers/media-publisher/src/index.mjs"));
  assert.ok(plist.StandardOutPath.endsWith("/media-publisher.log"));
  assert.ok(plist.StandardErrorPath.endsWith("/media-publisher-error.log"));
});
