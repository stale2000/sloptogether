import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const installer=fileURLToPath(new URL("../scripts/publisher-systemd.sh",import.meta.url));

test("renders an unprivileged systemd unit with supervised shutdown and literal paths",()=>{
  const envPath="/tmp/publisher $HOME %n.env";
  const unit=execFileSync(installer,["render-unit"],{
    encoding:"utf8",env:{...process.env,SLOPTOGETHER_PUBLISHER_ENV_FILE:envPath,SLOPTOGETHER_PUBLISHER_NODE:process.execPath},
  });
  assert.match(unit,/^Restart=always$/m);
  assert.match(unit,/^RestartSec=10$/m);
  assert.match(unit,/^KillMode=mixed$/m);
  assert.match(unit,/^TimeoutStopSec=120$/m);
  assert.match(unit,/^NoNewPrivileges=yes$/m);
  assert.match(unit,/^UMask=0077$/m);
  assert.match(unit,/"\/tmp\/publisher \$\$HOME %%n\.env"/);
  assert.doesNotMatch(unit,/EnvironmentFile=/);
});

test("refuses service paths that could inject unit directives",()=>{
  const result=spawnSync(installer,["render-unit"],{
    encoding:"utf8",env:{...process.env,SLOPTOGETHER_PUBLISHER_ENV_FILE:"/tmp/test\nExecStart=bad",SLOPTOGETHER_PUBLISHER_NODE:process.execPath},
  });
  assert.equal(result.status,2);
  assert.match(result.stderr,/no control characters/);
});

test("each service start rejects exposed or symlinked credentials before executing Node",()=>{
  const directory=mkdtempSync(join(tmpdir(),"slop-systemd-"));
  try{
    const envFile=join(directory,"private.env"),link=join(directory,"link.env"),fakeNode=join(directory,"node"),invocation=join(directory,"invocation");
    writeFileSync(envFile,"DATABASE_URL=secret-value\n",{mode:0o600});
    writeFileSync(fakeNode,`#!/bin/sh\nprintf '%s\\n' "$@" > '${invocation}'\n`,{mode:0o700});
    symlinkSync(envFile,link);
    assert.equal(spawnSync(installer,["run",link,fakeNode],{encoding:"utf8"}).status,2);
    chmodSync(envFile,0o644);
    assert.equal(spawnSync(installer,["run",envFile,fakeNode],{encoding:"utf8"}).status,2);
    chmodSync(envFile,0o600);
    execFileSync(installer,["run",envFile,fakeNode]);
    const args=readFileSync(invocation,"utf8");
    assert.match(args,/--env-file=/);
    assert.match(args,/workers\/media-publisher\/src\/index\.mjs/);
    assert.doesNotMatch(args,/secret-value/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
